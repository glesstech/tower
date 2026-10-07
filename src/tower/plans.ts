// Flight plans: filing, clearance, fork provisioning, amendment, release, and re-clearing
// whatever was holding once airspace frees up.

import {
	type Claim,
	ClaimTooBroad,
	claimsOverlap,
	LIMITS,
	type Limits,
	measure,
	parseClaim,
	suggest,
	tooBroad,
	warnings,
} from "../claims";
import {
	ACTIVE,
	type Amendment,
	branch,
	type Core,
	deleteRepo,
	getMeta,
	json,
	later,
	leaseTtl,
	type Plan,
	type PlanRow,
	plan as getPlan,
	repo,
	retry,
	serial,
	type Status,
	toPlan,
} from "./core";
import { bump, emitPlan } from "./events";
import { tree } from "./trunk";

const TOKEN_TTL = 3600;

export async function file(t: Core, body: { agent?: string; task?: string; claims?: string[]; ttl?: number; force?: boolean }) {
	if (!body.agent || !body.task || !body.claims?.length) throw new Error("agent, task and claims are required");
	const claims = body.claims.map(parseClaim);
	const ttl = leaseTtl(body.ttl);
	// Measured before anything is read or written below: nothing awaits between the blocker
	// check and the insert, so plans filed meanwhile still queue in order.
	const files = await trunkFiles(t);
	const hygiene = vet(t, files, claims, body.task, !!body.force);
	const id = crypto.randomUUID().slice(0, 8);
	const now = Date.now();
	const blockedBy = blockers(t, claims, now);
	const next: Status = blockedBy.length ? "holding" : "cleared";
	t.sql.exec(
		"INSERT INTO plans (id, agent, task, claims, status, blocked_by, created_at, last_seen_at, ttl) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
		id, body.agent, body.task, JSON.stringify(claims), next, JSON.stringify(blockedBy), now, now, ttl,
	);
	if (blockedBy.length) bump(t, "conflicts_prevented");
	if (hygiene.forced) bump(t, "claims_forced");
	// A plan waiting on a claim tower would have refused: what broad claims cost everyone else.
	if (files && blockedBy.some((b) => broad(t, files, getPlan(t, b).claims).length)) bump(t, "blocked_by_broad");
	emitPlan(t, "filed", id, hygiene.data);
	emitPlan(t, next, id, next === "holding" ? { blockedBy } : {});
	return { ...(await status(t, id)), ...hygiene.data };
}

// Trunk's file list (cached until HEAD moves), or null if it can't be read: measuring is
// advice, so it never stands between an agent and its plan.
async function trunkFiles(t: Core): Promise<{ paths: string[]; truncated: boolean } | null> {
	try {
		const { paths, truncated } = await tree(t);
		return paths.length ? { paths, truncated } : null;
	} catch (err) {
		console.error("claim hygiene: trunk tree unavailable:", err);
		return null;
	}
}

// Per-trunk limits, from meta: claim_max_files, claim_max_share (0..1), claim_min_files.
function limits(t: Core): Limits {
	const n = (key: string, fallback: number) => {
		const v = Number(getMeta(t, key));
		return getMeta(t, key) !== null && Number.isFinite(v) ? v : fallback;
	};
	return {
		maxFiles: n("claim_max_files", LIMITS.maxFiles),
		maxShare: n("claim_max_share", LIMITS.maxShare),
		minFiles: n("claim_min_files", LIMITS.minFiles),
	};
}

function broad(t: Core, files: { paths: string[] }, claims: Claim[]) {
	const lim = limits(t);
	return measure(claims, files.paths).claims.flatMap((c) => {
		const reason = tooBroad(c, lim);
		return reason ? [{ ...c, reason }] : [];
	});
}

// Measure claims against trunk: refuse broad ones (ClaimTooBroad, with files under them that
// fit the task) unless forced, and flag guessed paths. A truncated tree undercounts, so it
// can still refuse but doesn't warn about paths it may simply not have listed.
function vet(t: Core, files: { paths: string[]; truncated: boolean } | null, claims: Claim[], task: string, force: boolean) {
	if (!files) return { forced: false, data: {} };
	const coverage = measure(claims, files.paths);
	const wide = broad(t, files, claims);
	if (wide.length && !force) {
		bump(t, "claims_refused");
		const within = wide.map((w) => parseClaim(w.path));
		const suggested = suggest(task, files.paths, history(t), { within, limit: 8 }).map((s) => s.path);
		throw new ClaimTooBroad(wide, suggested, coverage);
	}
	const warned = files.truncated ? [] : warnings(claims, files.paths);
	const data: Record<string, unknown> = { coverage };
	if (warned.length) data.warnings = warned;
	if (wide.length) data.forced = wide.map((w) => w.path);
	return { forced: wide.length > 0, data };
}

// Recent lands, newest first, with the paths each changed: what suggestions learn from.
function history(t: Core, limit = 200): { task: string; paths: string[] }[] {
	const lands = t.sql.exec<{ sha: string; task: string }>("SELECT sha, task FROM lands ORDER BY landed_at DESC LIMIT ?", limit).toArray();
	return lands.map((l) => ({
		task: l.task,
		paths: t.sql.exec<{ path: string }>("SELECT path FROM land_paths WHERE sha = ?", l.sha).toArray().map((r) => r.path),
	}));
}

// Why a holding plan waits, per overlapping claim, phrased so the agent can act on it:
// narrow its own claim when that is what overlaps, or wait for the holder.
function waiting(t: Core, plan: Plan) {
	return plan.blockedBy.flatMap((b) => {
		const other = getPlan(t, b);
		const who = `${other.agent} (${other.status === "cleared" ? "in flight" : "queued ahead of you"})`;
		return other.claims.flatMap((theirs) =>
			plan.claims.filter((mine) => claimsOverlap(mine, theirs)).map((mine) => {
				const reason = mine.dir && mine.path !== theirs.path && theirs.path.startsWith(mine.path)
					? `\`${theirs.path}\` is held by ${who}, and your claim \`${mine.path}\` covers it; narrow \`${mine.path}\` to the files you will change to start now`
					: `\`${theirs.path}\` is held by ${who} for "${other.task.split("\n")[0]}", and covers your \`${mine.path}\`; you start when they land or release, or sooner if you drop \`${mine.path}\` and refile`;
				return { planId: other.id, agent: other.agent, held: theirs.path, yours: mine.path, reason };
			}),
		);
	});
}

// Active plans this claim set overlaps: every cleared plan, plus holding plans filed earlier
// (so a later plan queues behind an earlier one rather than jumping it).
function blockers(t: Core, claims: Claim[], before: number, self?: string): string[] {
	return blockersIn(airspace(t), claims, before, self);
}

type Airspace = { id: string; status: Status; createdAt: number; claims: Claim[] }[];

// Active plans with their claims parsed, oldest first.
function airspace(t: Core): Airspace {
	return t.sql
		.exec<PlanRow>(`SELECT id, status, created_at, claims FROM plans WHERE status IN ${ACTIVE} ORDER BY created_at`)
		.toArray()
		.map((r) => ({ id: r.id, status: r.status, createdAt: r.created_at, claims: JSON.parse(r.claims) as Claim[] }));
}

function blockersIn(active: Airspace, claims: Claim[], before: number, self?: string): string[] {
	return active
		.filter((r) => r.id !== self && (r.status === "cleared" || r.createdAt < before))
		.filter((r) => r.claims.some((a) => claims.some((b) => claimsOverlap(a, b))))
		.map((r) => r.id);
}

// Cleared plans get a fork and a fresh fork-scoped write token on each poll. A failed
// provision still returns the plan, so the agent keeps its id and the next poll retries.
export async function status(t: Core, id: string) {
	const plan = getPlan(t, id);
	if (plan.status === "holding") return { plan, waiting: waiting(t, plan) };
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
	plan.fork = name;
	plan.base = head.hash;
	// Released while the fork was being made: nobody will land it, so don't leave it behind.
	if (getPlan(t, plan.id).status !== "cleared") await deleteRepo(t, name);
	else emitPlan(t, "provisioned", plan.id, { fork: name, base: head.hash });
}

// Extend an active plan's claims. New paths nobody else holds are granted at once. A holding
// plan just re-queues with the larger set. An in-flight plan whose new paths are held keeps its
// fork and lease while the amendment waits; close() grants it once the blockers land or release.
// Only cleared plans block an amendment: holding plans hold nothing yet, and an in-flight agent
// going ahead of them is what keeps it from waiting on a plan that waits on it.
// New paths are measured like a filing's (coverage and warnings come back with the answer); a
// broad one is refused with 422 claim_too_broad unless forced.
export async function amend(t: Core, id: string, raw?: string[], force = false): Promise<Response> {
	if (!raw?.length) throw new Error("claims are required");
	const requested = raw.map(parseClaim);
	const before = getPlan(t, id);
	if (before.status !== "cleared" && before.status !== "holding") throw new Error(`plan ${id} is ${before.status}`);
	const fresh = requested.filter((c) => !within(before.claims, c));
	let hygiene: ReturnType<typeof vet> = { forced: false, data: {} };
	let files: Awaited<ReturnType<typeof trunkFiles>> = null;
	if (fresh.length) {
		files = await trunkFiles(t);
		try {
			hygiene = vet(t, files, fresh, before.task, force);
		} catch (err) {
			if (err instanceof ClaimTooBroad) return json({ granted: false, ...err.body }, 422);
			throw err;
		}
	}
	if (hygiene.forced) bump(t, "claims_forced");
	return amendNow(t, id, requested, hygiene.data, files?.paths);
}

// Everything after measuring runs without awaiting, so blockers can't change under it.
function amendNow(t: Core, id: string, requested: Claim[], extra: Record<string, unknown>, paths?: string[]): Response {
	const reply = (body: Record<string, unknown>, status?: number) => json({ ...body, ...extra }, status);
	const plan = getPlan(t, id);
	if (plan.status !== "cleared" && plan.status !== "holding") throw new Error(`plan ${id} is ${plan.status}`);
	const added = merge([], requested).filter((c) => !within(plan.claims, c));
	if (!added.length) return reply({ granted: true, blockedBy: [], plan });
	// For the dashboard: the whole lease's coverage once granted, and any path forced into it.
	// (A held amendment granted later in close() keeps the coverage it was filed with.)
	const amended = (claims: Claim[]) => ({
		added: added.map((c) => c.path),
		...(paths ? { coverage: measure(claims, paths) } : {}),
		...(extra.forced ? { forced: extra.forced } : {}),
	});

	if (plan.status === "holding") {
		const claims = [...plan.claims, ...added];
		const blockedBy = blockers(t, claims, plan.createdAt, id);
		const status: Status = blockedBy.length ? "holding" : "cleared";
		t.sql.exec(
			"UPDATE plans SET claims = ?, status = ?, blocked_by = ? WHERE id = ?",
			JSON.stringify(claims), status, JSON.stringify(blockedBy), id,
		);
		emitPlan(t, "amended", id, amended(claims));
		emitPlan(t, status, id, status === "holding" ? { blockedBy } : {});
		return reply({ granted: true, blockedBy, plan: getPlan(t, id) });
	}

	if (!blockers(t, added, 0, id).length) {
		const claims = [...plan.claims, ...added];
		t.sql.exec("UPDATE plans SET claims = ? WHERE id = ?", JSON.stringify(claims), id);
		emitPlan(t, "amended", id, amended(claims));
		return reply({ granted: true, blockedBy: [], plan: getPlan(t, id) });
	}

	// Held: fold into any amendment already waiting, then make sure waiting on these blockers
	// can't close a cycle (A holds X and wants Y while B holds Y and wants X). If it would,
	// refuse this amendment; both plans keep their leases and forks.
	const claims = merge(plan.amendment?.claims ?? [], added);
	const blockedBy = blockers(t, claims, 0, id);
	const found = cycle(t, id, blockedBy);
	if (found) {
		bump(t, "deadlocks_prevented");
		emitPlan(t, "deadlock", id, { paths: added.map((c) => c.path), blockedBy, cycle: found });
		const error = `deadlock: ${found.join(" -> ")}; finish without these paths, or land or release first`;
		return reply({ granted: false, error, deadlock: found, blockedBy, plan }, 409);
	}
	const amendment: Amendment = { claims, blockedBy, requestedAt: plan.amendment?.requestedAt ?? Date.now() };
	t.sql.exec("UPDATE plans SET amendment = ? WHERE id = ?", JSON.stringify(amendment), id);
	// Agents poll by asking again; count an amendment once, not once per poll.
	if (claims.length > (plan.amendment?.claims.length ?? 0)) {
		bump(t, "amendments_held");
		emitPlan(t, "amendment_held", id, { paths: claims.map((c) => c.path), blockedBy });
	}
	return reply({ granted: false, held: true, blockedBy, plan: getPlan(t, id) });
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
		if (plan.status === "expired") return { plan }; // already released by its lease running out
		await close(t, plan, "released");
		return { plan: getPlan(t, id) };
	});
}

// Free a plan's airspace, then grant held amendments (in-flight agents first, oldest request
// first) and clear whichever holding plans no longer have blockers.
export async function close(t: Core, plan: Plan, status: "landed" | "released" | "expired", data: Record<string, unknown> = {}) {
	t.sql.exec("UPDATE plans SET status = ?, amendment = NULL WHERE id = ?", status, plan.id);
	// Logged before the await below, so nothing filed meanwhile is ordered ahead of it.
	emitPlan(t, status, plan.id, data);
	// A landed fork's changes now live on trunk (and the commit trailers keep its name),
	// so the fork and its tokens go away rather than accumulating storage. Lands wait in line
	// for each other, not for this: nothing after it needs the fork gone.
	if (plan.fork) later(t, deleteRepo(t, plan.fork));

	const amending = t.sql
		.exec<PlanRow>("SELECT * FROM plans WHERE status = 'cleared' AND amendment IS NOT NULL")
		.toArray()
		.map(toPlan)
		.sort((a, b) => a.amendment!.requestedAt - b.amendment!.requestedAt);
	let granted = false;
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
		emitPlan(t, "amended", id, { added: p.amendment.claims.map((c) => c.path) });
		granted = true;
	}

	// Only plans that waited on this one can clear, unless an amendment was just granted (it may
	// now block anyone). With hundreds queued, the airspace is read and parsed once, not once per
	// plan: a plan cleared in this loop was already a blocker of the ones behind it (as an
	// earlier holding plan), so it stays one. A plan still holding is announced again only when
	// it now waits on someone new; its line merely getting shorter would be an event per queued
	// plan per land (the dashboard works out who is ahead itself).
	const active = airspace(t);
	for (const row of t.sql.exec<PlanRow>("SELECT * FROM plans WHERE status = 'holding' ORDER BY created_at").toArray()) {
		const before: string[] = JSON.parse(row.blocked_by);
		if (!granted && !before.includes(plan.id)) continue;
		const blockedBy = blockersIn(active, JSON.parse(row.claims), row.created_at, row.id);
		const next: Status = blockedBy.length ? "holding" : "cleared";
		t.sql.exec("UPDATE plans SET status = ?, blocked_by = ? WHERE id = ?", next, JSON.stringify(blockedBy), row.id);
		if (next === "cleared") {
			// Its lease starts now: an agent that waited in line shouldn't expire the moment it clears.
			t.sql.exec("UPDATE plans SET last_seen_at = ? WHERE id = ?", Date.now(), row.id);
			const self = active.find((r) => r.id === row.id);
			if (self) self.status = "cleared";
			emitPlan(t, "cleared", row.id);
		}
		else if (blockedBy.some((b) => !before.includes(b))) emitPlan(t, "holding", row.id, { blockedBy });
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
