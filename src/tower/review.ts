// Review by exception. Every land is scored (src/risk.ts); low-risk changes land at once, the
// rest wait in a human inbox, grouped so similar changes ("12 dependency bumps") take one
// decision: approve (land exactly what was scored), reject (release the plan), or send back
// (the agent keeps its fork and lease and may push again and re-land).
//
// The scorer's inputs come from trunk HEAD, which is the composed tree every earlier land
// produced: who imports the changed files there (blast radius), and which lands since this
// fork's base touched a file that imports, or is imported by, a changed file. That is the
// semantic-conflict signal: leases keep two agents off the same file, not off each other's
// callers. Running the checks themselves against the composed tree needs a build runner,
// which a Worker is not; this catches the shape of the conflict and sends it to a human.

import { type FileChange, importersOf, importSpecifiers, lineDelta, type Overlap, type Risk, resolveImport, SOURCE, score } from "../risk";
import type { Change } from "../treediff";
import { branch, type Core, json, type Plan, type PlanRow, plan as getPlan, type Review, repo, serial, toPlan } from "./core";
import { bump, emitPlan } from "./events";
import { changes, commit, type LandBody } from "./landing";
import { close } from "./plans";

const FILE_LIMIT = 5000;
const TEXT_LIMIT = 1024 * 1024;
const SPEC_CACHE_LIMIT = 50_000;
const SINCE_LIMIT = 500;

export type Decision = "approve" | "reject" | "send_back";

// Score a change about to land. Scoring that fails sends the change to a human rather than
// failing the land or letting it through unexamined.
export async function assess(t: Core, plan: Plan, changed: Change[], evidence: unknown): Promise<Risk> {
	let risk: Risk;
	try {
		risk = score(await inputs(t, plan, changed, evidence));
	} catch (err) {
		console.error(`score ${plan.id}:`, err);
		const reasons = [`could not score: ${(err as Error).message}`];
		risk = { score: 100, level: "review", reasons, group: { key: "unscored", label: "unscored changes" } };
	}
	return risk;
}

async function inputs(t: Core, plan: Plan, changed: Change[], evidence: unknown) {
	const br = await branch(t);
	using trunk = await t.env.ARTIFACTS.get(repo(t));
	using fork = await t.env.ARTIFACTS.get(plan.fork!);
	const [head] = await trunk.log({ ref: br, limit: 1 });
	const files = await walk(trunk, (await trunk.readCommit(head.hash))!.treeHash);

	// Trunk's import graph (source files only), parsed once per blob.
	if (t.importSpecs.size > SPEC_CACHE_LIMIT) t.importSpecs.clear();
	const graph = new Map<string, string[]>();
	await Promise.all(
		[...files].filter(([p]) => SOURCE.test(p)).map(async ([p, hash]) => graph.set(p, await specs(t, trunk, hash))),
	);
	const paths = changed.map((c) => c.path);
	const importers = importersOf(graph, paths);

	// Sizes, and what each changed file imports in its new version.
	const known = new Set([...files.keys(), ...paths]);
	const imports: Record<string, string[]> = {};
	const sized: FileChange[] = await Promise.all(
		changed.map(async (c) => {
			const oldHash = files.get(c.path);
			const [before, after] = await Promise.all([
				oldHash ? text(trunk, oldHash) : null,
				c.op === "upsert" ? text(fork, c.hash) : null,
			]);
			if (before?.text === null || after?.text === null) {
				// Binary or huge: size it by bytes, about 40 to a line.
				return { path: c.path, op: c.op, added: Math.ceil((after?.size ?? 0) / 40), removed: Math.ceil((before?.size ?? 0) / 40) };
			}
			if (after && SOURCE.test(c.path)) {
				imports[c.path] = importSpecifiers(after.text!)
					.map((s) => resolveImport(c.path, s, known))
					.filter((p): p is string => !!p && p !== c.path);
			}
			return { path: c.path, op: c.op, ...lineDelta(before?.text ?? null, after?.text ?? null) };
		}),
	);

	// Lands since the fork's base that touched a neighbor of a changed file.
	const neighbors = new Map<string, string>();
	for (const p of paths) {
		for (const i of importers[p] ?? []) if (!neighbors.has(i)) neighbors.set(i, `imports ${p}`);
		for (const i of imports[p] ?? []) if (!neighbors.has(i)) neighbors.set(i, `is imported by ${p}`);
	}
	for (const p of paths) neighbors.delete(p);
	const overlaps: Overlap[] = [];
	if (neighbors.size && head.hash !== plan.base) {
		const since = await trunk.log({ ref: br, limit: SINCE_LIMIT });
		const end = since.findIndex((c) => c.hash === plan.base);
		for (const c of end >= 0 ? since.slice(0, end) : since) {
			const land = t.sql.exec<{ agent: string }>("SELECT agent FROM lands WHERE sha = ?", c.hash).toArray()[0];
			for (const { path } of t.sql.exec<{ path: string }>("SELECT path FROM land_paths WHERE sha = ?", c.hash)) {
				const via = neighbors.get(path);
				if (via) overlaps.push({ path, via, sha: c.hash, agent: land?.agent ?? "unknown" });
			}
		}
	}

	return { changes: sized, importers, overlaps, evidence };
}

// Every blob path on a tree, with its hash.
async function walk(repo: ArtifactsRepo, treeHash: string): Promise<Map<string, string>> {
	const files = new Map<string, string>();
	const dirs: [string, string][] = [["", treeHash]];
	while (dirs.length && files.size < FILE_LIMIT) {
		const [prefix, hash] = dirs.shift()!;
		for (const e of (await repo.readTree(hash)) ?? []) {
			if (e.type === "tree") dirs.push([`${prefix}${e.name}/`, e.hash]);
			else if (e.type === "blob") files.set(prefix + e.name, e.hash);
		}
	}
	return files;
}

async function specs(t: Core, repo: ArtifactsRepo, hash: string): Promise<string[]> {
	let found = t.importSpecs.get(hash);
	if (!found) {
		const body = (await text(repo, hash))?.text;
		found = body ? importSpecifiers(body) : [];
		t.importSpecs.set(hash, found);
	}
	return found;
}

// A blob's text, or null text for binary files and files over TEXT_LIMIT.
async function text(repo: ArtifactsRepo, hash: string): Promise<{ size: number; text: string | null } | null> {
	const blob = await repo.readBlob(hash);
	if (!blob) return null;
	if (blob.size > TEXT_LIMIT) return { size: blob.size, text: null };
	const bytes = new Uint8Array(await blob.arrayBuffer());
	return { size: blob.size, text: bytes.subarray(0, 8192).includes(0) ? null : new TextDecoder().decode(bytes) };
}

// Park a scored change in the inbox. The plan keeps its claims (nothing may land over a change
// a human is reading) and its fork; its lease is paused (see leases.ts). 202, not an error:
// the agent is done.
export function queue(t: Core, plan: Plan, head: string, changed: Change[], body: LandBody, risk: Risk): Response {
	const review: Review = {
		head,
		summary: body.summary,
		evidence: body.evidence,
		author: body.author,
		risk,
		paths: changed.map((c) => c.path),
		requestedAt: Date.now(),
	};
	t.sql.exec("UPDATE plans SET review = ? WHERE id = ?", JSON.stringify(review), plan.id);
	bump(t, "reviews_queued");
	emitPlan(t, "review", plan.id, { risk });
	return json(
		{
			review: risk,
			message:
				"Queued for human review. Your work is done: do not release the plan. A human will approve it (it lands as pushed), reject it, or send it back (the plan's events will say why; push again and land).",
		},
		202,
	);
}

function pending(t: Core): Plan[] {
	return t.sql
		.exec<PlanRow>("SELECT * FROM plans WHERE status = 'cleared' AND review IS NOT NULL ORDER BY created_at")
		.toArray()
		.map(toPlan);
}

// GET /inbox: changes waiting for a human, one entry per decision, and the run's headline.
export function inbox(t: Core) {
	const groups = new Map<string, { key: string; label: string; plans: object[] }>();
	for (const p of pending(t)) {
		const r = p.review!;
		const g = groups.get(r.risk.group.key) ?? { key: r.risk.group.key, label: r.risk.group.label, plans: [] };
		g.plans.push({ id: p.id, agent: p.agent, task: p.task, summary: r.summary ?? null, paths: r.paths, risk: r.risk, requestedAt: r.requestedAt });
		groups.set(g.key, g);
	}
	const decisions = [...groups.values()].map((g) => ({ ...g, count: g.plans.length, label: `${g.plans.length} ${g.label}` }));
	return { decisions, headline: headline(t, decisions.length) };
}

// "N agents, 0 conflicts reached a human, K decisions required": overlapping plans queue
// instead of conflicting, so a human only ever sees review decisions, made or pending.
export function headline(t: Core, open: number) {
	const stat = (key: string) => t.sql.exec<{ value: number }>("SELECT value FROM stats WHERE key = ?", key).toArray()[0]?.value ?? 0;
	const agents = t.sql.exec<{ n: number }>("SELECT COUNT(DISTINCT agent) AS n FROM plans").one().n;
	const decisions = stat("decisions") + open;
	return {
		agents,
		conflictsPrevented: stat("conflicts_prevented"),
		conflictsReachedHuman: 0,
		autoLanded: stat("landed") - stat("reviews_approved"),
		decisions,
		text: `${agents} agents, 0 conflicts reached a human, ${decisions} decision${decisions === 1 ? "" : "s"} required`,
	};
}

// POST /inbox/decide {decision, group | plans, note?}: one human decision over a whole group (or
// chosen plans). Each plan's outcome is reported; one failing doesn't stop the rest.
export async function decide(t: Core, body: { decision?: string; group?: string; plans?: string[]; note?: string }) {
	const decision = body.decision as Decision;
	if (!["approve", "reject", "send_back"].includes(decision)) throw new Error("decision must be approve, reject or send_back");
	return serial(t, async () => {
		const ids = body.plans?.length
			? body.plans
			: pending(t)
					.filter((p) => p.review!.risk.group.key === body.group)
					.map((p) => p.id);
		if (!ids.length) throw new Error("nothing in review matches; pass group (a key from GET /inbox) or plans");
		bump(t, "decisions");
		const results: Record<string, unknown>[] = [];
		for (const id of ids) {
			try {
				results.push({ id, ...(await one(t, id, decision, body.note)) });
			} catch (err) {
				results.push({ id, outcome: "error", error: (err as Error).message });
			}
		}
		return { decision, results };
	});
}

async function one(t: Core, id: string, decision: Decision, note?: string): Promise<Record<string, unknown>> {
	const plan = getPlan(t, id);
	if (plan.status !== "cleared" || !plan.review) throw new Error(`plan ${id} is not awaiting review`);
	const review = plan.review;

	if (decision === "reject") {
		bump(t, "reviews_rejected");
		await close(t, plan, "released", { rejected: true, note: note ?? null, risk: review.risk });
		return { outcome: "rejected" };
	}
	if (decision === "send_back") {
		bump(t, "reviews_sent_back");
		resume(t, id);
		emitPlan(t, "sent_back", id, { note: note ?? null, risk: review.risk });
		return { outcome: "sent_back" };
	}

	// Approve lands exactly what was scored; a fork that moved since goes back for a fresh land.
	const { head, changes: changed, drift } = await changes(t, plan);
	if (head !== review.head || drift.length || !changed.length) {
		resume(t, id);
		const reason = head !== review.head ? "fork changed since it was reviewed" : drift.length ? "fork drifted outside its lease" : "nothing to land";
		emitPlan(t, "sent_back", id, { note: reason, risk: review.risk });
		return { outcome: "sent_back", reason };
	}
	const landed = await commit(t, plan, head, changed, review, review.risk);
	t.sql.exec("UPDATE plans SET review = NULL WHERE id = ?", id);
	bump(t, "reviews_approved");
	return { outcome: "landed", ...landed };
}

// Back to the agent: out of the inbox, with its lease restarted from now.
function resume(t: Core, id: string) {
	t.sql.exec("UPDATE plans SET review = NULL, last_seen_at = ? WHERE id = ?", Date.now(), id);
}
