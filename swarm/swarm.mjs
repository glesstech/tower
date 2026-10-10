#!/usr/bin/env node
// Start one agent per task, all coordinating through one tower trunk. The swarm does no
// coordination itself: it builds prompts, starts agents from swarm/agents.json (any agent with
// MCP support), waits, and reports what landed. By default it starts more of whichever agent
// launched it (Claude Code → Claude Code agents); --agent a,b picks explicitly.
//
//   TOWER_URL=https://tower-dev.<subdomain>.workers.dev TOWER_API_KEY=... \
//     npm run swarm -- --repo tower-src --issues 11,12 --task "Fix the typo in README.md"
//
// --init creates the trunk from the current directory's HEAD if it doesn't exist yet.
// --pr fetches what landed into a local swarm/<timestamp> branch, runs typecheck and test on it,
// pushes it, opens a GitHub PR with each agent's evidence and the combined check results, then
// tears the trunk down so the next run starts from main. --checks "<cmd>" replaces the npm
// typecheck/test default, for repos that don't use npm (e.g. --checks "go test ./...").
// --model picks the model: each agent in agents.json defaults to a cheap one, so a test run
// doesn't burn tokens. --model sonnet sets it for every agent, --model claude=opus,opencode=…
// per agent.
// --timeout (minutes, default 30) counts from when tower first clears the agent's plan, so time
// spent holding behind other agents doesn't eat into it; an agent never cleared stops at 3x.

import { execFile, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";

const run = promisify(execFile);
const { values: args } = parseArgs({
	options: {
		repo: { type: "string" },
		issues: { type: "string", default: "" },
		task: { type: "string", multiple: true, default: [] },
		agent: { type: "string" },
		config: { type: "string", default: new URL("./agents.json", import.meta.url).pathname },
		timeout: { type: "string", default: "30" },
		logs: { type: "string", default: "swarm-logs" },
		init: { type: "boolean", default: false },
		pr: { type: "boolean", default: false },
		checks: { type: "string" },
		model: { type: "string" },
		"dry-run": { type: "boolean", default: false },
	},
});
const BASE = process.env.TOWER_URL;
const KEY = process.env.TOWER_API_KEY;
if (!args.repo || !BASE || !KEY) throw new Error("need --repo, TOWER_URL and TOWER_API_KEY");
const REPO_URL = `${BASE}/repos/${args.repo}`;

const log = (who, msg) => console.log(`${new Date().toISOString().slice(11, 19)} ${who.padEnd(14)} ${msg}`);

async function api(method, path, body) {
	const res = await fetch(`${REPO_URL}${path}`, {
		method,
		headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
		body: body ? JSON.stringify(body) : undefined,
	});
	return { status: res.status, body: await res.json() };
}

// Tasks come from GitHub issues (via gh, in the current repo) and/or literal --task strings.
async function tasks() {
	const out = [];
	for (const n of args.issues.split(",").map((s) => s.trim()).filter(Boolean)) {
		const { stdout } = await run("gh", ["issue", "view", n, "--json", "number,title,body"]);
		const issue = JSON.parse(stdout);
		out.push({ id: `issue-${issue.number}`, issue: issue.number, text: `GitHub issue #${issue.number}: ${issue.title}\n\n${issue.body}` });
	}
	args.task.forEach((text, i) => out.push({ id: `task-${i + 1}`, text }));
	if (!out.length) throw new Error("give --issues and/or --task");
	return out;
}

function prompt(name, task) {
	return `You are agent "${name}", one of several agents working concurrently on the Git repository "${args.repo}". You do not have a copy of it yet.

All coordination goes through the "tower" MCP tools. Follow the tower server's instructions exactly: read the code first (suggest_claims, why), file a plan claiming the specific files you will change and any new files by exact path (use your agent name; never a whole top-level directory), wait for clearance, clone your fork into ./work, edit only claimed paths (amend claims first if you need more), commit, push, and land.

If the repository defines checks (for example "npm run typecheck" or "npm test"), run them in your fork before landing and include the results in your evidence. If you cannot finish, release your plan.

Your task:
${task}`;
}

// Replace {placeholders} in every string of a JSON-like value.
function fill(value, vars) {
	if (typeof value === "string") return value.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
	if (Array.isArray(value)) return value.map((v) => fill(v, vars));
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, vars)]));
	return value;
}

async function init() {
	const { status, body } = await api("POST", "/init");
	if (status !== 200) {
		if (/exist/i.test(body.error ?? "")) return log("swarm", `trunk ${args.repo} already exists`);
		throw new Error(`init failed: ${JSON.stringify(body)}`);
	}
	await run("git", ["-c", `http.extraHeader=Authorization: Bearer ${body.token}`, "push", body.remote, "HEAD:main"]);
	log("swarm", `created trunk ${args.repo} from this directory's HEAD`);
}

function launch(agent, name, task, logDir, clock) {
	return new Promise(async (done) => {
		const dir = await mkdtemp(join(tmpdir(), `swarm-${name}-`));
		const vars = { prompt: prompt(name, task.text), name, model: agent.model, mcp_url: `${REPO_URL}/mcp`, auth: `Bearer ${KEY}` };
		for (const [file, content] of Object.entries(agent.files ?? {})) {
			await writeFile(join(dir, file), JSON.stringify(fill(content, vars), null, 2));
		}
		const [cmd, ...argv] = fill(agent.cmd, vars);
		const out = createWriteStream(join(logDir, `${name}.log`));
		// Its own process group, so a timeout stops the agent's children (npm, tests) too.
		const child = spawn(cmd, argv, { cwd: dir, stdio: ["ignore", "pipe", "pipe"], detached: true });
		const kill = () => {
			try {
				process.kill(-child.pid, "SIGTERM");
			} catch {}
		};
		child.stdout.pipe(out);
		child.stderr.pipe(out);
		let timer = setTimeout(kill, clock.backstopMs);
		clock.start = () => {
			clearTimeout(timer);
			timer = setTimeout(kill, clock.workMs);
		};
		const finish = async (code) => {
			clearTimeout(timer);
			kill(); // anything the agent left running in the background
			// The dir holds the API key in agent config files; a failed cleanup mustn't end the run.
			await rm(dir, { recursive: true, force: true, maxRetries: 5 }).catch((err) => log(name, `cleanup failed: ${err.message}`));
			done(code);
		};
		child.on("error", (err) => (out.write(`\n${err}\n`), finish(-1)));
		child.on("close", finish);
	});
}

// The agent that launched the swarm: the nearest ancestor process that is a known agent
// (env vars alone are ambiguous, since a nested agent inherits its parent's), else an env marker.
async function callingAgent(agents) {
	let pid = process.ppid;
	for (let depth = 0; depth < 32 && pid > 1; depth++) {
		const { stdout } = await run("ps", ["-o", "ppid=,args=", "-p", String(pid)]).catch(() => ({ stdout: "" }));
		const m = stdout.trim().match(/^(\d+)\s+(.*)$/);
		if (!m) break;
		// Match the executable, or the script it runs (e.g. "node /…/bin/opencode").
		const names = m[2].split(/\s+/).slice(0, 2).map((t) => t.split("/").pop());
		const hit = agents.find((a) => a.detect?.process?.some((p) => names.includes(p)));
		if (hit) return { agent: hit, how: `launched from ${hit.name} (pid ${pid})` };
		pid = Number(m[1]);
	}
	const hit = agents.find((a) => a.detect?.env?.some((v) => process.env[v]));
	return hit ? { agent: hit, how: `env ${hit.detect.env.find((v) => process.env[v])}` } : null;
}

async function choosePool(agents) {
	if (args.agent) {
		const pool = args.agent.split(",").map((name) => {
			const agent = agents.find((a) => a.name === name.trim());
			if (!agent) throw new Error(`no agent named ${name} in ${args.config}`);
			return agent;
		});
		return { pool, how: "--agent" };
	}
	const found = await callingAgent(agents);
	if (found) return { pool: [found.agent], how: found.how };
	return { pool: [agents[0]], how: `no calling agent detected; first in ${args.config}` };
}

const { agents } = JSON.parse(await readFile(resolve(args.config), "utf8"));
const { pool, how } = await choosePool(agents);
for (const spec of (args.model ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
	const [name, model] = spec.includes("=") ? spec.split("=") : [null, spec];
	const targets = name ? pool.filter((a) => a.name === name) : pool;
	if (!targets.length) throw new Error(`--model ${spec}: no agent named ${name} in this run`);
	for (const a of targets) a.model = model;
}
log("swarm", `agents: ${pool.map((a) => `${a.name} (${a.model})`).join(", ")} (${how})`);

const work = (await tasks()).map((task, i) => {
	const agent = pool[i % pool.length];
	return { task, agent, name: `${agent.name}-${task.id}` };
});

if (args["dry-run"]) {
	for (const w of work) console.log(`${w.name}: ${fill(w.agent.cmd, { prompt: "<prompt>", model: w.agent.model, mcp_url: `${REPO_URL}/mcp`, auth: "Bearer ***" }).join(" ")}\n  task: ${w.task.text.split("\n")[0]}`);
	process.exit(0);
}

if (args.init) await init();
await mkdir(args.logs, { recursive: true });
const workMs = Number(args.timeout) * 60_000;
const clocks = new Map(work.map((w) => [w.name, { workMs, backstopMs: 3 * workMs, start: null, started: false, running: true }]));

// Start each agent's work clock once tower clears its first plan, and heartbeat the plans of
// agents whose process is still running: a coding agent can go quiet for longer than the lease
// TTL while it edits and tests, and a lease should expire when its agent dies, not when it thinks.
const watch = setInterval(async () => {
	const { body } = await api("GET", "/state").catch(() => ({ body: null }));
	for (const p of body?.plans ?? []) {
		const clock = clocks.get(p.agent);
		if (clock?.running) api("POST", `/plans/${p.id}/heartbeat`).catch(() => {});
		if (p.status !== "cleared" || !clock?.start || clock.started) continue;
		clock.started = true;
		clock.start();
		log(p.agent, `cleared; ${args.timeout} min work clock started`);
	}
}, 10_000);

const codes = await Promise.all(
	work.map(async (w) => {
		log(w.name, `started (${w.task.text.split("\n")[0].slice(0, 60)})`);
		const code = await launch(w.agent, w.name, w.task, args.logs, clocks.get(w.name));
		clocks.get(w.name).running = false;
		log(w.name, `exited ${code}`);
		return code;
	}),
);
clearInterval(watch);

// Report, and free any airspace left by agents that exited without landing.
const { body: state } = await api("GET", "/state");
console.log("");
for (const [i, w] of work.entries()) {
	const landed = state.lands.filter((l) => l.agent === w.name);
	const stuck = state.plans.filter((p) => p.agent === w.name);
	for (const p of stuck) await api("POST", `/plans/${p.id}/release`);
	const outcome = landed.length
		? `landed ${landed.map((l) => `${l.sha.slice(0, 8)} "${l.summary}"`).join(", ")}`
		: `did not land${stuck.length ? `; released ${stuck.length} plan(s)` : ""}`;
	console.log(`${w.name.padEnd(24)} exit ${String(codes[i]).padEnd(3)} ${outcome}`);
}
console.log(`\nstats ${JSON.stringify(state.stats)}  ·  logs in ${args.logs}/`);
if (args.pr) await openPr(state, codes);

async function openPr(state, codes) {
	const landed = state.lands.filter((l) => work.some((w) => w.name === l.agent)).reverse();
	if (!landed.length) {
		log("swarm", "nothing landed; no PR");
		return teardown();
	}
	const stamp = new Date().toISOString().slice(0, 16).replace("T", "-").replace(":", "");
	const branch = `swarm/${stamp}`;
	const { body: t } = await api("POST", "/token");
	await run("git", ["-c", `http.extraHeader=Authorization: Bearer ${t.token}`, "fetch", "-q", t.remote, `main:${branch}`]);
	log("swarm", `fetched trunk into ${branch}`);
	// Everything landed is now in the local branch, so the trunk can go even if the PR step fails.
	await teardown();
	const checks = await verify(branch);

	const issues = work.filter((w) => w.task.issue && landed.some((l) => l.agent === w.name)).map((w) => w.task.issue);
	const title = `Swarm: ${landed.length} change${landed.length === 1 ? "" : "s"}${issues.length ? ` (${issues.map((n) => `#${n}`).join(", ")})` : ""}`;
	const missed = work
		.map((w, i) => ({ w, code: codes[i] }))
		.filter(({ w }) => !landed.some((l) => l.agent === w.name))
		.map(({ w, code }) => `- \`${w.name}\` (exit ${code}): ${w.task.text.split("\n")[0]}`);
	const body = [
		`Changes landed by ${work.length} agents coordinating through tower on trunk \`${args.repo}\`. Each commit carries \`Tower-*\` trailers.`,
		"",
		"| Agent | Commit | Summary |",
		"| --- | --- | --- |",
		...landed.map((l) => `| \`${l.agent}\` | ${l.sha.slice(0, 8)} | ${l.summary} |`),
		"",
		"## Evidence",
		...landed.flatMap((l) => [
			"",
			`### \`${l.agent}\`: ${l.summary}`,
			...Object.entries(l.evidence ?? {}).map(([k, v]) => `- **${k}:** ${typeof v === "string" ? v : JSON.stringify(v)}`),
		]),
		...(missed.length ? ["", "## Did not land", ...missed] : []),
		"",
		"## Combined checks",
		"",
		checks.summary,
		...(checks.output ? ["", "```", checks.output, "```"] : []),
		"",
		`Stats: ${JSON.stringify(state.stats)}`,
		"",
		...issues.map((n) => `Closes #${n}`),
	].join("\n");

	try {
		await run("git", ["push", "-q", "-u", "origin", branch]);
		const dir = await mkdtemp(join(tmpdir(), "swarm-pr-"));
		await writeFile(join(dir, "body.md"), body);
		const { stdout: base } = await run("gh", ["repo", "view", "--json", "defaultBranchRef", "-q", ".defaultBranchRef.name"]);
		const { stdout: url } = await run("gh", ["pr", "create", "--base", base.trim(), "--head", branch, "--title", title, "--body-file", join(dir, "body.md")]);
		await rm(dir, { recursive: true, force: true });
		log("swarm", `opened ${url.trim()}`);
	} catch (err) {
		log("swarm", `PR step failed (${err.message.split("\n")[0]}); the work is in local branch ${branch}`);
	}
}

// Each agent ran its checks against trunk as it was when it landed, not against the other
// agents' work. Path claims can't catch a semantic clash between disjoint paths (one change
// breaking another's tests), so run the checks on the combined branch in a scratch worktree:
// --checks if given, else the npm `typecheck` and `test` scripts if the repo defines them.
// Failures are reported in the PR, not fatal.
async function verify(branch) {
	const dir = await mkdtemp(join(tmpdir(), "swarm-verify-"));
	const sh = (cmd) => run("sh", ["-c", cmd], { cwd: dir, maxBuffer: 64 << 20 });
	try {
		await run("git", ["worktree", "add", "-q", "--detach", dir, branch]);
		const plan = args.checks ? { setup: null, steps: [args.checks] } : await npmChecks(dir);
		if (!plan) return { ok: true, summary: "No checks defined (no npm `typecheck` or `test` script, no `--checks`); nothing ran." };
		log("swarm", `running ${plan.steps.join(", ")} on ${branch}`);
		if (plan.setup) await sh(plan.setup);
		for (const step of plan.steps) {
			try {
				await sh(step);
			} catch (err) {
				const output = `${err.stdout ?? ""}${err.stderr ?? ""}`.trim().split("\n").slice(-40).join("\n");
				log("swarm", `combined checks FAILED: ${step}`);
				return { ok: false, summary: `❌ \`${step}\` fails on the combined branch (the agents' changes may clash even though their claims didn't overlap).`, output };
			}
		}
		log("swarm", `combined checks passed (${plan.steps.join(", ")})`);
		return { ok: true, summary: `✅ ${plan.steps.map((s) => `\`${s}\``).join(" and ")} ${plan.steps.length === 1 ? "passes" : "pass"} on the combined branch.` };
	} catch (err) {
		log("swarm", `combined checks could not run (${err.message.split("\n")[0]})`);
		return { ok: false, summary: `⚠️ Combined checks could not run: ${err.message.split("\n")[0]}` };
	} finally {
		await run("git", ["worktree", "remove", "--force", dir]).catch(() => rm(dir, { recursive: true, force: true }));
	}
}

// The npm checks a repo defines, or null. `npm init`'s placeholder test script always fails,
// so it doesn't count as a test.
async function npmChecks(dir) {
	const pkg = await readFile(join(dir, "package.json"), "utf8").catch(() => null);
	if (!pkg) return null;
	const { scripts = {} } = JSON.parse(pkg);
	const steps = ["typecheck", "test"].filter((s) => scripts[s] && !scripts[s].includes("no test specified"));
	if (!steps.length) return null;
	const locked = await readFile(join(dir, "package-lock.json")).then(() => true, () => false);
	return { setup: `npm ${locked ? "ci" : "install"} --no-audit --no-fund`, steps: steps.map((s) => `npm run ${s}`) };
}

async function teardown() {
	const { body } = await api("DELETE", "");
	log("swarm", `tore down trunk ${args.repo} (${body.deleted} repos)`);
}
