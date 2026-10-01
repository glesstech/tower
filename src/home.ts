// Data for the home page at / (web/index.html). GET /repos lists the trunks with live counts
// from each Tower's /state: every trunk for the operator key, otherwise only the public demo
// trunk (TOWER_DEMO_REPO), so the list of repos never leaks without a key.
//
// The demo trunk is also watchable without a key: the same read-only routes the dashboard
// key opens (see src/dashboard/access.ts), for that one repo only.

import { access } from "./dashboard/access";

export type Counts = { in_flight: number; holding: number; landed: number; conflicts_prevented: number };
export type Trunk = { repo: string; counts: Counts | null };

type State = { plans?: { status: string }[]; stats?: Record<string, number> };

/** Trunk names among Artifacts repos: forks are named <trunk>--<plan id>. */
export function trunkNames(repos: { name: string }[]): string[] {
	return repos.map((r) => r.name).filter((name) => !name.includes("--")).sort();
}

/** The home page counters from a Tower's /state. */
export function counts(state: State): Counts {
	const plans = state.plans ?? [];
	const stats = state.stats ?? {};
	return {
		in_flight: plans.filter((p) => p.status === "cleared").length,
		holding: plans.filter((p) => p.status === "holding").length,
		landed: stats.landed ?? 0,
		conflicts_prevented: stats.conflicts_prevented ?? 0,
	};
}

/** Whether a keyless request may read this repo: only the demo trunk's read-only routes. */
export function demoAccess(
	demo: string | undefined,
	repo: string,
	req: { method: string; rest: string; websocket: boolean },
): boolean {
	if (!demo || repo !== demo) return false;
	return access({ dashboard: "demo" }, "demo", req) === "dashboard";
}

/** GET /repos: { demo, trunks }, with every trunk for the operator and only the demo otherwise. */
export async function home(env: Env, operator: boolean): Promise<{ demo: string | null; trunks: Trunk[] }> {
	const demo = env.TOWER_DEMO_REPO || null;
	const names = operator ? await listTrunks(env) : demo ? [demo] : [];
	const trunks = await Promise.all(names.map(async (repo) => ({ repo, counts: await trunkCounts(env, repo) })));
	return { demo, trunks };
}

async function listTrunks(env: Env): Promise<string[]> {
	const repos: { name: string }[] = [];
	let cursor: string | undefined;
	do {
		const page = await env.ARTIFACTS.list({ limit: 200, cursor });
		repos.push(...page.repos);
		cursor = page.cursor;
	} while (cursor);
	return trunkNames(repos);
}

async function trunkCounts(env: Env, repo: string): Promise<Counts | null> {
	try {
		const res = await env.TOWER.getByName(repo).fetch("https://tower/state", { headers: { "X-Tower-Repo": repo } });
		return res.ok ? counts(await res.json<State>()) : null;
	} catch {
		return null;
	}
}
