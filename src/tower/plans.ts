// Flight plans: filing, clearance, fork provisioning, amendment, release, and re-clearing
// whatever was holding once airspace frees up.

import { type Claim, claimsOverlap, parseClaim } from "../claims";
import {
	ACTIVE,
	type Amendment,
	branch,
	type Core,
	deleteRepo,
	json,
	type Plan,
	type PlanRow,
	plan as getPlan,
	repo,
	retry,
	serial,
	type Status,
	toPlan,
} from "./core";
import { broadcast, bump } from "./events";

const TOKEN_TTL = 3600;

export async function file(t: Core, body: { agent?: string; task?: string; claims?: string[] }) {
	if (!body.agent || !body.task || !body.claims?.length) throw new Error("agent, task and claims are required");
	const claims = body.claims.map(parseClaim);
	const id = crypto.randomUUID().slice(0, 8);
	const blockedBy = blockers(t, claims, Date.now());
	const next: Status = blockedBy.length ? "holding" : "cleared";
	t.sql.exec(
		"INSERT INTO plans (id, agent, task, claims, status, blocked_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
		id, body.agent, body.task, JSON.stringify(claims), next, JSON.stringify(blockedBy), Date.now(),
	);
	if (blockedBy.length) bump(t, "conflicts_prevented");
	broadcast(t, { type: "plan", plan: getPlan(t, id) });
	return status(t, id);
}

// Active plans this claim set overlaps: every cleared plan, plus holding plans filed earlier
// (so a later plan queues behind an earlier one rather than jumping it).
function blockers(t: Core, claims: Claim[], before: number, self?: string): string[] {
	const rows = t.sql
		.exec<PlanRow>(`SELECT * FROM plans WHERE status IN ${ACTIVE} ORDER BY created_at`)
		.toArray()
		.filter((r) => r.id !== self && (r.status === "cleared" || r.created_at < before));
	return rows
		.filter((r) => (JSON.parse(r.claims) as Claim[]).some((a) => claims.some((b) => claimsOverlap(a, b))))
		.map((r) => r.id);
}

// Cleared plans get a fork and a fresh fork-scoped write token on each poll. A failed
// provision still returns the plan, so the agent keeps its id and the next poll retries.
export async function status(t: Core, id: string) {
	const plan = getPlan(t, id);
	if (plan.status !== "cleared") return { plan };
	if (!plan.fork) {
		try {
			await provision(t, plan);
		} catch (err) {
			console.error(`provision ${id}:`, err);
			return { plan, error: (err as Error).message };
		}
	}
	using fork = await t.env.ARTIFACTS.get(getPlan(t, id).fork!);
	const [info, token, br] = await Promise.all([fork.info(), fork.createToken("write", TOKEN_TTL), branch(t)]);
	return { plan: getPlan(t, id), fork: { name: info.name, remote: info.remote, token: token.plaintext, branch: br } };
}

// Provisioning doesn't wait behind lands: the base is read from the fork itself, so it is
// exact whenever the fork happens. Concurrent polls for one plan share a single fork call.
function provision(t: Core, plan: Plan): Promise<void> {
	let pending = t.provisioning.get(plan.id);
	if (!pending) {
		pending = forkFor(t, plan).finally(() => t.provisioning.delete(plan.id));
		t.provisioning.set(plan.id, pending);
	}
	return pending;
}

async function forkFor(t: Core, plan: Plan) {
	if (getPlan(t, plan.id).fork) return;
	const name = `${repo(t)}--${plan.id}`;
	const br = await branch(t);
	using trunk = await t.env.ARTIFACTS.get(repo(t));
	try {
		await retry(() => trunk.fork(name, { description: `${plan.agent}: ${plan.task}` }));
	} catch (err) {
		// An earlier attempt may have created the fork before failing to record it.
		if ((err as ArtifactsError).code !== "ALREADY_EXISTS") throw err;
	}
	using fork = await retry(() => t.env.ARTIFACTS.get(name));
	const head = await retry(async () => {
		const [commit] = await fork.log({ ref: br, limit: 1 });
		if (!commit) throw Object.assign(new Error(`fork ${name} has no commits yet`), { code: "FORK_IN_PROGRESS" });
		return commit;
	});
	t.sql.exec("UPDATE plans SET fork = ?, base = ? WHERE id = ?", name, head.hash, plan.id);
	// Released while the fork was being made: nobody will land it, so don't leave it behind.
	if (getPlan(t, plan.id).status !== "cleared") await deleteRepo(t, name);
	plan.fork = name;
	plan.base = head.hash;
	broadcast(t, { type: "plan", plan: getPlan(t, plan.id) });
}

// Extend an active plan's claims. New paths nobody else holds are granted at once. A holding
// plan just re-queues with the larger set. An in-flight plan whose new paths are held keeps its
// fork and lease while the amendment waits; close() grants it once the blockers land or release.
// Only cleared plans block an amendment: holding plans hold nothing yet, and an in-flight agent
// going ahead of them is what keeps it from waiting on a plan that waits on it.
export function amend(t: Core, id: string, raw?: string[]): Response {
	if (!raw?.length) throw new Error("claims are required");
	const plan = getPlan(t, id);
	if (plan.status !== "cleared" && plan.status !== "holding") throw new Error(`plan ${id} is ${plan.status}`);
	const added = merge([], raw.map(parseClaim)).filter((c) => !within(plan.claims, c));
	if (!added.length) return json({ granted: true, blockedBy: [], plan });

	if (plan.status === "holding") {
		const claims = [...plan.claims, ...added];
		const blockedBy = blockers(t, claims, plan.createdAt, id);
		const status: Status = blockedBy.length ? "holding" : "cleared";
		t.sql.exec(
			"UPDATE plans SET claims = ?, status = ?, blocked_by = ? WHERE id = ?",
			JSON.stringify(claims), status, JSON.stringify(blockedBy), id,
		);
		broadcast(t, { type: "plan", plan: getPlan(t, id) });
		return json({ granted: true, blockedBy, plan: getPlan(t, id) });
	}

	if (!blockers(t, added, 0, id).length) {
		t.sql.exec("UPDATE plans SET claims = ? WHERE id = ?", JSON.stringify([...plan.claims, ...added]), id);
		broadcast(t, { type: "plan", plan: getPlan(t, id) });
		return json({ granted: true, blockedBy: [], plan: getPlan(t, id) });
	}

	// Held: fold into any amendment already waiting, then make sure waiting on these blockers
	// can't close a cycle (A holds X and wants Y while B holds Y and wants X). If it would,
	// refuse this amendment; both plans keep their leases and forks.
	const claims = merge(plan.amendment?.claims ?? [], added);
	const blockedBy = blockers(t, claims, 0, id);
	const found = cycle(t, id, blockedBy);
	if (found) {
		bump(t, "deadlocks_prevented");
		const error = `deadlock: ${found.join(" -> ")}; finish without these paths, or land or release first`;
		return json({ granted: false, error, deadlock: found, blockedBy, plan }, 409);
	}
	const amendment: Amendment = { claims, blockedBy, requestedAt: plan.amendment?.requestedAt ?? Date.now() };
	t.sql.exec("UPDATE plans SET amendment = ? WHERE id = ?", JSON.stringify(amendment), id);
	// Agents poll by asking again; count an amendment once, not once per poll.
	if (claims.length > (plan.amendment?.claims.length ?? 0)) bump(t, "amendments_held");
	broadcast(t, { type: "plan", plan: getPlan(t, id) });
	return json({ granted: false, held: true, blockedBy, plan: getPlan(t, id) });
}

// The wait-for path from `self` through held amendments back to `self`, if there is one.
function cycle(t: Core, self: string, blockedBy: string[]): string[] | null {
	const seen = new Set<string>();
	const walk = (path: string[]): string[] | null => {
		const id = path[path.length - 1];
		if (id === self) return path;
		if (seen.has(id)) return null;
		seen.add(id);
		// Edges are recomputed, not read from the stored blockedBy: a plan filed since may
		// have taken some of the held paths.
		const held = getPlan(t, id).amendment;
		for (const next of held ? blockers(t, held.claims, 0, id) : []) {
			const found = walk([...path, next]);
			if (found) return found;
		}
		return null;
	};
	for (const b of blockedBy) {
		const found = walk([self, b]);
		if (found) return found;
	}
	return null;
}

export async function release(t: Core, id: string) {
	return serial(t, async () => {
		const plan = getPlan(t, id);
		if (plan.status === "landed") throw new Error("plan already landed");
		await close(t, plan, "released");
		return { plan: getPlan(t, id) };
	});
}

// Free a plan's airspace, then grant held amendments (in-flight agents first, oldest request
// first) and clear whichever holding plans no longer have blockers.
export async function close(t: Core, plan: Plan, status: "landed" | "released") {
	t.sql.exec("UPDATE plans SET status = ?, amendment = NULL WHERE id = ?", status, plan.id);
	// A landed fork's changes now live on trunk (and the commit trailers keep its name),
	// so the fork and its tokens go away rather than accumulating storage.
	if (plan.fork) await deleteRepo(t, plan.fork);
	broadcast(t, { type: "plan", plan: getPlan(t, plan.id) });

	const amending = t.sql
		.exec<PlanRow>("SELECT * FROM plans WHERE status = 'cleared' AND amendment IS NOT NULL")
		.toArray()
		.map(toPlan)
		.sort((a, b) => a.amendment!.requestedAt - b.amendment!.requestedAt);
	for (const { id } of amending) {
		const p = getPlan(t, id); // re-read: an earlier grant in this loop may now block it
		if (p.status !== "cleared" || !p.amendment) continue;
		const blockedBy = blockers(t, p.amendment.claims, 0, id);
		if (blockedBy.length) {
			t.sql.exec("UPDATE plans SET amendment = ? WHERE id = ?", JSON.stringify({ ...p.amendment, blockedBy }), id);
			continue;
		}
		const claims = merge(p.claims, p.amendment.claims);
		t.sql.exec("UPDATE plans SET claims = ?, amendment = NULL WHERE id = ?", JSON.stringify(claims), id);
		broadcast(t, { type: "plan", plan: getPlan(t, id) });
	}

	for (const row of t.sql.exec<PlanRow>("SELECT * FROM plans WHERE status = 'holding' ORDER BY created_at").toArray()) {
		const blockedBy = blockers(t, JSON.parse(row.claims), row.created_at, row.id);
		const next: Status = blockedBy.length ? "holding" : "cleared";
		t.sql.exec("UPDATE plans SET status = ?, blocked_by = ? WHERE id = ?", next, JSON.stringify(blockedBy), row.id);
		if (next === "cleared") broadcast(t, { type: "plan", plan: getPlan(t, row.id) });
	}
}

// Whether a claim is already inside one of `claims` (same path, or under a claimed directory).
function within(claims: Claim[], c: Claim): boolean {
	return claims.some((x) => x.path === c.path || (x.dir && c.path.startsWith(x.path)));
}

function merge(claims: Claim[], extra: Claim[]): Claim[] {
	const out = [...claims];
	for (const c of extra) if (!within(out, c)) out.push(c);
	return out;
}
