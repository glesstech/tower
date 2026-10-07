// Drift check and landing: diff a fork against its base, refuse paths outside the lease, score
// the rest by risk, and overlay low-risk changes onto trunk (the others wait for a human).
//
// Lands are serialized, so the time a land holds the lock caps throughput for the whole trunk.
// Everything that reads only the fork (the diff, the drift check, the agent's commit and the
// changed blobs) happens before taking it. Inside it, scoring reads trunk from the tower's own
// caches (trunk's file list moves forward with each land), the write token is reused, and
// trunk HEAD is the one the last push left; a push rejected because trunk moved under it is
// retried once from a fresh read.

import { covers } from "../claims";
import { type Author, TrunkWorkspace } from "../land";
import type { Risk } from "../risk";
import { type Change, diffTrees } from "../treediff";
import { branch, type Core, json, type Plan, plan as getPlan, repo, serial, trunkHead } from "./core";
import { bump, emit } from "./events";
import { close } from "./plans";
import { assess, queue } from "./review";
import { advanceTree } from "./trunk";

export async function changes(t: Core, plan: Plan): Promise<{ head: string; commit: ArtifactsCommitMetadata; changes: Change[]; drift: string[] }> {
	if (plan.status !== "cleared" || !plan.fork || !plan.base) throw new Error(`plan ${plan.id} is not in flight`);
	const br = await branch(t);
	using fork = await t.env.ARTIFACTS.get(plan.fork);
	const [head] = await fork.log({ ref: br, limit: 1 });
	if (!head) throw new Error(`fork ${plan.fork} has no commits on ${br}`);
	const before = await fork.readCommit(plan.base);
	const changes = await diffTrees(fork, before!.treeHash, head.treeHash);
	const drift = changes.map((c) => c.path).filter((p) => !covers(plan.claims, p));
	return { head: head.hash, commit: head, changes, drift };
}

export async function check(t: Core, id: string) {
	const plan = getPlan(t, id);
	const { head, changes: touched, drift } = await changes(t, plan);
	if (drift.length) emit(t, "drift", { planId: id, agent: plan.agent, paths: drift, blocked: false });
	return { head, touched: touched.map((c) => c.path), drift };
}

// The merge gate: refuse drift, score the change, then land it (low risk) or queue it in the
// human inbox (everything else; see review.ts). The fork head diffed here is what lands, even
// if the agent pushes again meanwhile, just as an approval lands what was reviewed.
export async function land(t: Core, id: string, body: LandBody) {
	const plan = getPlan(t, id);
	if (plan.review) return json({ error: "awaiting human review", review: plan.review }, 409);
	const { head, commit: agentCommit, changes: changed, drift } = await changes(t, plan);
	if (!changed.length) return json({ error: "nothing to land" }, 400);
	if (drift.length) {
		bump(t, "drift_blocked");
		emit(t, "drift", { planId: id, agent: plan.agent, paths: drift, blocked: true });
		return json({ error: "changes outside lease", drift, claims: plan.claims.map((c) => c.path) }, 409);
	}
	const ready = await prepare(t, plan, agentCommit, changed);

	return serial(t, async () => {
		const now = getPlan(t, id);
		// Released or expired while its diff was read: as for any plan no longer in flight.
		if (now.status !== "cleared") return json({ error: `plan ${id} is not in flight` }, 400);
		if (now.review) return json({ error: "awaiting human review", review: now.review }, 409);
		const risk = await assess(t, now, changed, body.evidence);
		if (risk.level === "review") return queue(t, now, head, changed, body, risk);
		return json({ ...(await commit(t, now, head, changed, body, risk, ready)), risk });
	});
}

type Prepared = { agentCommit: ArtifactsCommitMetadata; fork: Pick<ArtifactsRepo, "readBlob"> };

// Read every blob a land changed from the fork into the tower's blob cache, and keep the
// agent's commit (from changes()) for its message and author. Needs no lock.
export async function prepare(t: Core, plan: Plan, agentCommit: ArtifactsCommitMetadata, changed: Change[]): Promise<Prepared> {
	using fork = await t.env.ARTIFACTS.get(plan.fork!);
	await Promise.all(changed.filter((c) => c.op === "upsert").map((c) => t.blobs.read(fork, c.hash)));
	// The handle above is disposed when this returns; the workspace reads the cache, and only
	// falls back to the fork (a fresh handle) if the cache was emptied meanwhile.
	const name = plan.fork!;
	const fallback = async (hash: string) => {
		using f = await t.env.ARTIFACTS.get(name);
		return f.readBlob(hash);
	};
	return {
		agentCommit,
		fork: {
			readBlob: async (hash: string) => {
				const bytes = t.blobs.get(hash);
				return bytes ? new Blob([bytes]) : fallback(hash);
			},
		} as Pick<ArtifactsRepo, "readBlob">,
	};
}

export type LandBody = { summary?: string; evidence?: unknown; author?: Author };

// Overlay a fork's changes onto trunk and close the plan as landed. Callers hold the serial
// queue and have already checked drift; `ready` is what prepare() read.
export async function commit(t: Core, plan: Plan, head: string, changed: Change[], body: LandBody, risk: Risk, ready: Prepared) {
	const { agentCommit, fork } = ready;
	const br = await branch(t);
	using trunk = await t.env.ARTIFACTS.get(repo(t));
	if (t.workspace?.branch !== br) {
		t.workspace = new TrunkWorkspace((await trunk.info()).remote, br);
		t.trunkToken = null;
	}
	const workspace = t.workspace;
	const summary = body.summary?.trim() || agentCommit.message.split("\n")[0];
	const push = async () => {
		const parent = await trunkHead(t, trunk, br);
		if (!parent) throw new Error("trunk has no commits");
		const sha = await workspace.land({
			token: await writeToken(t, trunk),
			trunkHead: parent,
			fork,
			changes: changed,
			author: body.author ?? agentCommit.author,
			message: `${summary}\n\nTower-Plan: ${plan.id}\nTower-Agent: ${plan.agent}\nTower-Fork: ${plan.fork}@${head}\n`,
		});
		return { parent, sha };
	};
	let landed: { parent: string; sha: string };
	try {
		landed = await push();
	} catch (err) {
		// Trunk moved, or the token went stale: the workspace has dropped its state, so retry
		// once from a fresh read of trunk with a fresh token. A push that went through but
		// reported failure left this plan's commit on top; that is the land, not a reason for
		// a second one.
		console.error(`land ${plan.id}: retrying once:`, err);
		t.trunkToken = null;
		const [top] = await trunk.log({ ref: br, limit: 1 });
		if (top?.message.includes(`\nTower-Plan: ${plan.id}\n`)) landed = { parent: "", sha: top.hash };
		else landed = await push();
	}
	const { parent, sha } = landed;
	advanceFiles(t, parent, sha, changed);
	advanceTree(t, parent, sha, changed);

	t.sql.exec(
		"INSERT INTO lands (sha, plan_id, agent, task, summary, evidence, landed_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
		sha, plan.id, plan.agent, plan.task, summary, JSON.stringify(body.evidence ?? null), Date.now(),
	);
	for (const c of changed) t.sql.exec("INSERT INTO land_paths (sha, path) VALUES (?, ?)", sha, c.path);
	bump(t, "landed");
	await close(t, plan, "landed", { sha, summary, paths: changed.map((c) => c.path), risk });
	return { sha, paths: changed.map((c) => c.path) };
}

// A trunk write token for the workspace's push, reused until it is within a minute of expiry.
async function writeToken(t: Core, trunk: ArtifactsRepo): Promise<string> {
	const held = t.trunkToken;
	if (held && held.expiresAt - Date.now() > 60_000) return held.plaintext;
	const token = await trunk.createToken("write", 600);
	const expiresAt = Date.parse(token.expiresAt);
	t.trunkToken = { id: token.id, plaintext: token.plaintext, expiresAt: Number.isFinite(expiresAt) ? expiresAt : Date.now() + 600_000 };
	if (held) trunk.revokeToken(held.id).catch(() => {});
	return token.plaintext;
}

// Carry trunk's cached file list forward over a land, so the next scoring needn't re-walk it.
function advanceFiles(t: Core, parent: string, sha: string, changed: Change[]) {
	if (t.trunkFiles?.head !== parent) {
		t.trunkFiles = null;
		return;
	}
	const files = new Map(t.trunkFiles.files);
	for (const c of changed) {
		// Regular files only, as review.ts walks trunk.
		if (c.op === "upsert" && c.mode === "100644") files.set(c.path, c.hash);
		else files.delete(c.path);
	}
	t.trunkFiles = { head: sha, files };
}

// Memory: why does this path look the way it does? The newest 20 lands by default; ?limit= asks
// for up to 1000 (the code explorer wants a file's whole history).
export function why(t: Core, path: string, limit?: string | null) {
	if (!path) throw new Error("path is required");
	const n = Math.min(Math.max(Number(limit) || 20, 1), 1000);
	return t.sql
		.exec<{ sha: string; plan_id: string; agent: string; task: string; summary: string; evidence: string; landed_at: number }>(
			`SELECT DISTINCT l.* FROM lands l JOIN land_paths p ON p.sha = l.sha
			 WHERE p.path = ? OR p.path LIKE ? ORDER BY l.landed_at DESC LIMIT ?`,
			path, `${path.replace(/\/?$/, "/")}%`, n,
		)
		.toArray()
		.map((r) => ({ ...r, evidence: JSON.parse(r.evidence) }));
}
