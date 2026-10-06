// GET /plans/:id/diff, for the plan page: the files a plan changed, with old and new contents
// read through the Artifacts binding. A landed plan is diffed on trunk (its commit against its
// parent; the fork is gone by then). A plan in flight is diffed in its fork (base against fork
// head), which is what `check` sees, so the page can show touched paths and drift live.
//
// It runs in the Worker, not the Tower: the Tower counts every /plans/:id call as a heartbeat,
// and a page left open must never keep a silent agent's lease alive. The plan itself comes
// from its events (each lifecycle event carries the plan as it stands), read from the Tower's
// /events like any dashboard does.

import { covers } from "../claims";
import type { Plan } from "./core";

// Contents are returned for at most this many files, each up to BLOB_LIMIT bytes (like /blob).
const FILE_LIMIT = 200;
const BLOB_LIMIT = 1024 * 1024;

export type Side = { hash: string; mode: string; size: number; binary: boolean; text: string | null };
export type FileDiff = { path: string; op: "added" | "modified" | "deleted"; old: Side | null; new: Side | null; outside?: boolean };
export type PlanDiff = {
	plan: Plan;
	source: "trunk" | "fork" | null;
	sha: string | null;
	fork: string | null;
	base: string | null;
	head: string | null;
	files: FileDiff[];
	truncated: boolean;
	note?: string;
};

type Entry = { path: string; mode: string; hash: string };
type Pair = { path: string; before: Entry | null; after: Entry | null };

export async function planDiff(env: Pick<Env, "TOWER" | "ARTIFACTS">, repo: string, id: string): Promise<PlanDiff | null> {
	const found = await planEvents(env, repo, id);
	if (!found) return null;
	const { plan, sha } = found;
	const out: PlanDiff = { plan, source: null, sha, fork: plan.fork, base: plan.base, head: null, files: [], truncated: false };

	if (plan.status === "landed" && sha) {
		using trunk = await env.ARTIFACTS.get(repo);
		const commit = await trunk.readCommit(sha);
		if (!commit) return { ...out, note: "the landed commit is no longer on trunk" };
		const parent = commit.parents[0] ? await trunk.readCommit(commit.parents[0]) : null;
		return { ...out, source: "trunk", head: sha, ...(await diffCommits(trunk, parent?.treeHash ?? null, commit.treeHash)) };
	}

	if (plan.status === "cleared" && plan.fork && plan.base) {
		try {
			using fork = await env.ARTIFACTS.get(plan.fork);
			const { defaultBranch } = await fork.info();
			const [head] = await fork.log({ ref: defaultBranch, limit: 1 });
			const [before, after] = await Promise.all([fork.readCommit(plan.base), head ? fork.readCommit(head.hash) : null]);
			if (!before || !after) return { ...out, note: "the fork has no commits yet" };
			const diff = await diffCommits(fork, before.treeHash, after.treeHash);
			for (const f of diff.files) f.outside = !covers(plan.claims, f.path);
			return { ...out, source: "fork", head: head!.hash, ...diff };
		} catch (err) {
			// A fork still being copied, or deleted by a land or release racing this read.
			return { ...out, note: `fork not readable: ${(err as Error).message}` };
		}
	}

	const note = plan.status === "holding" ? "holding: no fork yet" : plan.status === "cleared" ? "cleared: fork not provisioned yet" : `${plan.status}: its fork was deleted, nothing landed`;
	return { ...out, note };
}

// The plan as its latest lifecycle event left it, and the trunk SHA if it landed.
async function planEvents(env: Pick<Env, "TOWER">, repo: string, id: string): Promise<{ plan: Plan; sha: string | null } | null> {
	let plan: Plan | null = null;
	let sha: string | null = null;
	let since = 0;
	for (;;) {
		const res = await env.TOWER.getByName(repo).fetch(
			`https://tower/events?plan=${encodeURIComponent(id)}&since=${since}&limit=10000`,
			{ headers: { "X-Tower-Repo": repo } },
		);
		if (!res.ok) throw new Error(`events: ${res.status}`);
		const page = await res.json<{ events: { type: string; plan?: Plan; sha?: string }[]; last: number }>();
		for (const ev of page.events) {
			if (ev.plan) plan = ev.plan;
			if (ev.type === "landed" && ev.sha) sha = ev.sha;
		}
		if (page.events.length < 10000) break;
		since = page.last;
	}
	return plan ? { plan, sha } : null;
}

/** Every file that differs between two trees (either may be null), with both sides' contents. */
export async function diffCommits(repo: ArtifactsRepo, before: string | null, after: string | null): Promise<{ files: FileDiff[]; truncated: boolean }> {
	const pairs = (await pairTrees(repo, before, after)).sort((a, b) => a.path.localeCompare(b.path));
	const files = await Promise.all(
		pairs.map(async (p, i): Promise<FileDiff> => {
			const withText = i < FILE_LIMIT;
			const [old, now] = await Promise.all([side(repo, p.before, withText), side(repo, p.after, withText)]);
			return { path: p.path, op: !p.before ? "added" : !p.after ? "deleted" : "modified", old, new: now };
		}),
	);
	return { files, truncated: pairs.length > FILE_LIMIT };
}

// Like diffTrees (src/treediff.ts), descending only into changed subtrees, but keeping both sides.
async function pairTrees(repo: ArtifactsRepo, before: string | null, after: string | null, prefix = ""): Promise<Pair[]> {
	if (before === after) return [];
	const [a, b] = await Promise.all([entries(repo, before), entries(repo, after)]);
	const out: Pair[] = [];
	const nested: Promise<Pair[]>[] = [];
	for (const name of new Set([...a.keys(), ...b.keys()])) {
		const x = a.get(name);
		const y = b.get(name);
		if (x && y && x.hash === y.hash && x.mode === y.mode) continue;
		const path = prefix + name;
		const xTree = x?.type === "tree" ? x.hash : null;
		const yTree = y?.type === "tree" ? y.hash : null;
		if (xTree || yTree) nested.push(pairTrees(repo, xTree, yTree, `${path}/`));
		const xFile = x && x.type !== "tree" ? { path, mode: x.mode, hash: x.hash } : null;
		const yFile = y && y.type !== "tree" ? { path, mode: y.mode, hash: y.hash } : null;
		if (xFile || yFile) out.push({ path, before: xFile, after: yFile });
	}
	for (const sub of await Promise.all(nested)) out.push(...sub);
	return out;
}

async function entries(repo: ArtifactsRepo, hash: string | null) {
	const map = new Map<string, ArtifactsTreeEntry>();
	if (!hash) return map;
	const list = await repo.readTree(hash);
	if (!list) throw new Error(`tree not found: ${hash}`);
	for (const e of list) map.set(e.name, e);
	return map;
}

// One side of a file. Binary files (a NUL in the first 8 KB), files over BLOB_LIMIT, submodules
// and files past FILE_LIMIT come back without text.
async function side(repo: ArtifactsRepo, e: Entry | null, withText: boolean): Promise<Side | null> {
	if (!e) return null;
	const base = { hash: e.hash, mode: e.mode, size: 0, binary: false, text: null };
	if (!withText || e.mode === "160000") return base;
	const data = await repo.readBlob(e.hash);
	if (!data) return base;
	const bytes = new Uint8Array(await data.slice(0, BLOB_LIMIT).arrayBuffer());
	const binary = bytes.subarray(0, 8192).includes(0);
	const text = binary || data.size > BLOB_LIMIT ? null : new TextDecoder().decode(bytes);
	return { ...base, size: data.size, binary, text };
}
