// Drift check and landing: diff a fork against its base, refuse paths outside the lease, and
// overlay the rest onto trunk.

import { covers } from "../claims";
import { type Author, TrunkWorkspace } from "../land";
import { type Change, diffTrees } from "../treediff";
import { branch, type Core, json, type Plan, plan as getPlan, repo, serial } from "./core";
import { bump, emit } from "./events";
import { close } from "./plans";

async function changes(t: Core, plan: Plan): Promise<{ head: string; changes: Change[]; drift: string[] }> {
	if (plan.status !== "cleared" || !plan.fork || !plan.base) throw new Error(`plan ${plan.id} is not in flight`);
	const br = await branch(t);
	using fork = await t.env.ARTIFACTS.get(plan.fork);
	const [head] = await fork.log({ ref: br, limit: 1 });
	if (!head) throw new Error(`fork ${plan.fork} has no commits on ${br}`);
	const [before, after] = await Promise.all([fork.readCommit(plan.base), fork.readCommit(head.hash)]);
	const changes = await diffTrees(fork, before!.treeHash, after!.treeHash);
	const drift = changes.map((c) => c.path).filter((p) => !covers(plan.claims, p));
	return { head: head.hash, changes, drift };
}

export async function check(t: Core, id: string) {
	const plan = getPlan(t, id);
	const { head, changes: touched, drift } = await changes(t, plan);
	if (drift.length) emit(t, "drift", { planId: id, agent: plan.agent, paths: drift, blocked: false });
	return { head, touched: touched.map((c) => c.path), drift };
}

export async function land(t: Core, id: string, body: { summary?: string; evidence?: unknown; author?: Author }) {
	return serial(t, async () => {
		const plan = getPlan(t, id);
		const { head, changes: changed, drift } = await changes(t, plan);
		if (!changed.length) return json({ error: "nothing to land" }, 400);
		if (drift.length) {
			bump(t, "drift_blocked");
			emit(t, "drift", { planId: id, agent: plan.agent, paths: drift, blocked: true });
			return json({ error: "changes outside lease", drift, claims: plan.claims.map((c) => c.path) }, 409);
		}

		using fork = await t.env.ARTIFACTS.get(plan.fork!);
		const br = await branch(t);
		using trunk = await t.env.ARTIFACTS.get(repo(t));
		const [[trunkHead], info, token, agentCommit] = await Promise.all([
			trunk.log({ ref: br, limit: 1 }),
			trunk.info(),
			trunk.createToken("write", 300),
			fork.readCommit(head),
		]);
		if (t.workspace?.branch !== br) t.workspace = new TrunkWorkspace(info.remote, br);
		const summary = body.summary?.trim() || agentCommit!.message.split("\n")[0];
		const sha = await t.workspace.land({
			token: token.plaintext,
			trunkHead: trunkHead.hash,
			fork,
			changes: changed,
			author: body.author ?? agentCommit!.author,
			message: `${summary}\n\nTower-Plan: ${plan.id}\nTower-Agent: ${plan.agent}\nTower-Fork: ${plan.fork}@${head}\n`,
		});
		await trunk.revokeToken(token.id);

		t.sql.exec(
			"INSERT INTO lands (sha, plan_id, agent, task, summary, evidence, landed_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			sha, plan.id, plan.agent, plan.task, summary, JSON.stringify(body.evidence ?? null), Date.now(),
		);
		for (const c of changed) t.sql.exec("INSERT INTO land_paths (sha, path) VALUES (?, ?)", sha, c.path);
		bump(t, "landed");
		await close(t, plan, "landed", { sha, summary, paths: changed.map((c) => c.path) });
		return json({ sha, paths: changed.map((c) => c.path) });
	});
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
