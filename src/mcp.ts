// Tower as MCP tools, so any MCP-capable agent (Claude Code, Codex, Cursor, Gemini CLI, …)
// can coordinate through it directly. Each tool is a thin call into the repo's Tower Durable
// Object over the same HTTP API that non-MCP agents use, so both paths share one state.

import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { suggest } from "./claims";

const WAIT_MS = 25_000;

const INSTRUCTIONS = `Tower coordinates many agents changing one Git repository at the same time. You never
push to the shared trunk; you work in a private fork and tower lands your change for you.

1. Plan before editing, and claim narrowly: every path you claim is airspace other agents wait
   for. Start from real paths: call suggest_claims with your task (trunk files ranked for it),
   and why on the files you expect to change. Then call file_plan with the specific files you
   will change, plus any new files you will create by their exact path. Don't claim a directory
   to be safe: tower refuses broad claims (claim_too_broad, with narrower files to claim
   instead), and warns about paths that don't exist on trunk, which usually means a guess.
   Claim what you know now and grow the lease with amend_claims as you go.
2. Call wait_for_clearance until it returns a fork, then clone the fork with the git command it
   gives you. If another agent holds an overlapping path, you wait in line; the answer says
   which of your claims is held and by whom. If a claim of yours is wider than you need, release
   and refile without it to start now.
3. Edit only the paths you claimed. If you discover you need another path, call amend_claims
   first. If it is held, keep working on what you have and call amend_claims again later; you
   keep your fork either way. If it reports a deadlock, finish without that path.
   Your lease expires if tower hears nothing from you for about 15 minutes: the plan is released
   and your fork deleted. During long work (installs, builds, test runs), call check every few
   minutes to keep it alive.
4. Commit and push to the fork's trunk branch (wait_for_clearance gives the command), then call
   land with a short summary and your evidence (what you were asked, your plan, and the checks you ran).
5. If land reports drift, undo the changes outside your claims (or amend), push, and land again.
6. If you give up, call release so others are not blocked.`;

type Call = (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>;

export function createServer(env: Env, repo: string): McpServer {
	const call: Call = async (method, path, body) => {
		const res = await env.TOWER.getByName(repo).fetch(
			new Request(`https://tower${path}`, {
				method,
				headers: { "X-Tower-Repo": repo, "Content-Type": "application/json" },
				body: body === undefined ? undefined : JSON.stringify(body),
			}),
		);
		return { status: res.status, body: await res.json() };
	};

	const server = new McpServer({ name: `tower:${repo}`, version: "0.1.0" }, { instructions: INSTRUCTIONS });
	const planId = z.string().describe("Plan id returned by file_plan");
	const claims = z
		.array(z.string())
		.min(1)
		.describe('Repo-relative file paths ("src/a.ts"), including new files you will create. A directory ("src/auth/") only when you will change most of a small one');
	const force = z
		.boolean()
		.optional()
		.describe("Claim paths tower refuses as too broad anyway. Counted, and shown on the dashboard; narrow the claim instead if you can");

	server.registerTool(
		"file_plan",
		{
			description:
				"File a flight plan: what you will do and the specific files you expect to change. Do this before editing. A claim covering too much of trunk is refused with narrower files to claim instead; paths that don't exist on trunk come back as warnings.",
			inputSchema: {
				agent: z.string().describe("A name for you, unique among the agents in this run"),
				task: z.string().describe("One line describing the change"),
				claims,
				ttl: z
					.number()
					.int()
					.optional()
					.describe("Seconds of silence before your lease expires (default 900, 60 to 3600)"),
				force,
			},
		},
		async (args) => result(await call("POST", "/plans", args)),
	);

	server.registerTool(
		"wait_for_clearance",
		{
			description:
				"Wait (up to ~25s per call) for a plan to be cleared. Once cleared, returns your fork's git remote, a fork-scoped token, and the commands to clone and push. Call again while it says holding.",
			inputSchema: { plan_id: planId },
		},
		async ({ plan_id }) => {
			const deadline = Date.now() + WAIT_MS;
			let res = await call("GET", `/plans/${plan_id}`);
			while (res.status === 200 && !res.body.fork && Date.now() < deadline) {
				await new Promise((r) => setTimeout(r, 1000));
				res = await call("GET", `/plans/${plan_id}`);
			}
			if (res.status !== 200 || !res.body.fork) return result(res);
			const { remote, token, branch = "main" } = res.body.fork;
			const auth = `-c http.extraHeader="Authorization: Bearer ${token}"`;
			return result({
				status: 200,
				body: {
					plan: res.body.plan,
					fork: res.body.fork,
					git: {
						clone: `git ${auth} clone ${remote} <dir>`,
						push: `git ${auth} push ${remote} HEAD:${branch}`,
						note: "The token only works on this fork and expires in an hour; call wait_for_clearance again for a fresh one.",
					},
				},
			});
		},
	);

	server.registerTool(
		"amend_claims",
		{
			description:
				"Add paths to your plan's claims before editing them. Free paths are granted at once. Paths another agent holds are held for you (granted: false, held: true) and granted when that agent lands or releases; call again to see. Refused with a deadlock if the wait would be circular, or claim_too_broad if a new path covers too much of trunk.",
			inputSchema: { plan_id: planId, claims, force },
		},
		async ({ plan_id, claims, force }) => result(await call("POST", `/plans/${plan_id}/amend`, { claims, force })),
	);

	server.registerTool(
		"suggest_claims",
		{
			description:
				"Trunk files ranked for a task: by how well their names and directories match it, and by which files past lands of similar tasks changed. Call before file_plan to claim real, specific paths.",
			inputSchema: { task: z.string().describe("Your task, in your own words or as given"), limit: z.number().int().min(1).max(50).optional() },
		},
		async ({ task, limit }) => {
			const [tree, state] = await Promise.all([call("GET", "/tree"), call("GET", "/state")]);
			if (tree.status !== 200) return result(tree);
			const history = (state.body?.lands ?? []).map((l: { task: string; paths: string[] }) => ({ task: l.task, paths: l.paths }));
			const files = suggest(task, tree.body.paths ?? [], history, { limit: limit ?? 15 });
			return result({ status: 200, body: { files, trunk: tree.body.paths?.length ?? 0 } });
		},
	);

	server.registerTool(
		"check",
		{
			description:
				"List the paths your pushed fork has changed so far, and any drift (changes outside your claims). Also keeps your lease alive; call it every few minutes during long work.",
			inputSchema: { plan_id: planId },
		},
		async ({ plan_id }) => result(await call("POST", `/plans/${plan_id}/check`)),
	);

	server.registerTool(
		"land",
		{
			description:
				"Ask tower to land your pushed fork onto trunk. Rejected with the drifted paths if you changed anything outside your claims.",
			inputSchema: {
				plan_id: planId,
				summary: z.string().describe("One-line commit summary for trunk"),
				evidence: z
					.object({
						request: z.string().optional().describe("What you were asked to do"),
						plan: z.string().optional().describe("How you approached it"),
						checks: z.string().optional().describe("Commands you ran to verify it, and their results"),
					})
					.optional(),
			},
		},
		async ({ plan_id, ...body }) => result(await call("POST", `/plans/${plan_id}/land`, body)),
	);

	server.registerTool(
		"release",
		{
			description: "Abandon a plan and free its claims so queued agents can proceed.",
			inputSchema: { plan_id: planId },
		},
		async ({ plan_id }) => result(await call("POST", `/plans/${plan_id}/release`)),
	);

	server.registerTool(
		"why",
		{
			description: "Past landed changes to a file or directory: which agent, the task, summary and evidence. Read before changing code.",
			inputSchema: { path: z.string() },
		},
		async ({ path }) => result(await call("GET", `/why?path=${encodeURIComponent(path)}`)),
	);

	server.registerTool(
		"state",
		{
			description: "Current airspace: active plans with their claims and status, recent lands, and stats.",
			inputSchema: {},
		},
		async () => result(await call("GET", "/state")),
	);

	return server;
}

function result({ status, body }: { status: number; body: unknown }) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }],
		isError: status >= 400,
	};
}
