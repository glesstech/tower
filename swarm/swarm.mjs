#!/usr/bin/env node
// Start one agent per task, all coordinating through one tower trunk. The swarm does no
// coordination itself: it builds prompts, starts whatever agents swarm/agents.json lists
// (any agent with MCP support), waits, and reports what landed.
//
//   TOWER_URL=https://tower-dev.<subdomain>.workers.dev TOWER_API_KEY=... \
//     npm run swarm -- --repo tower-src --issues 11,12 --task "Fix the typo in README.md"
//
// --init creates the trunk from the current directory's HEAD if it doesn't exist yet.

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
		out.push({ id: `issue-${issue.number}`, text: `GitHub issue #${issue.number}: ${issue.title}\n\n${issue.body}` });
	}
	args.task.forEach((text, i) => out.push({ id: `task-${i + 1}`, text }));
	if (!out.length) throw new Error("give --issues and/or --task");
	return out;
}

function prompt(name, task) {
	return `You are agent "${name}", one of several agents working concurrently on the Git repository "${args.repo}". You do not have a copy of it yet.

All coordination goes through the "tower" MCP tools. Follow the tower server's instructions exactly: file a plan claiming every path you will change (use your agent name), wait for clearance, clone your fork into ./work, edit only claimed paths (amend claims first if you need more), commit, push, and land.

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

function launch(agent, name, task, logDir, timeoutMs) {
	return new Promise(async (done) => {
		const dir = await mkdtemp(join(tmpdir(), `swarm-${name}-`));
		const vars = { prompt: prompt(name, task.text), name, mcp_url: `${REPO_URL}/mcp`, auth: `Bearer ${KEY}` };
		for (const [file, content] of Object.entries(agent.files ?? {})) {
			await writeFile(join(dir, file), JSON.stringify(fill(content, vars), null, 2));
		}
		const [cmd, ...argv] = fill(agent.cmd, vars);
		const out = createWriteStream(join(logDir, `${name}.log`));
		const child = spawn(cmd, argv, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
		child.stdout.pipe(out);
		child.stderr.pipe(out);
		const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
		const finish = async (code) => {
			clearTimeout(timer);
			await rm(dir, { recursive: true, force: true }); // holds the API key in agent config files
			done(code);
		};
		child.on("error", (err) => (out.write(`\n${err}\n`), finish(-1)));
		child.on("close", finish);
	});
}

const { agents } = JSON.parse(await readFile(resolve(args.config), "utf8"));
const pool = args.agent ? agents.filter((a) => a.name === args.agent) : agents;
if (!pool.length) throw new Error(`no agent named ${args.agent} in ${args.config}`);

const work = (await tasks()).map((task, i) => {
	const agent = pool[i % pool.length];
	return { task, agent, name: `${agent.name}-${task.id}` };
});

if (args["dry-run"]) {
	for (const w of work) console.log(`${w.name}: ${fill(w.agent.cmd, { prompt: "<prompt>", mcp_url: `${REPO_URL}/mcp`, auth: "Bearer ***" }).join(" ")}\n  task: ${w.task.text.split("\n")[0]}`);
	process.exit(0);
}

if (args.init) await init();
await mkdir(args.logs, { recursive: true });
const timeoutMs = Number(args.timeout) * 60_000;

const codes = await Promise.all(
	work.map(async (w) => {
		log(w.name, `started (${w.task.text.split("\n")[0].slice(0, 60)})`);
		const code = await launch(w.agent, w.name, w.task, args.logs, timeoutMs);
		log(w.name, `exited ${code}`);
		return code;
	}),
);

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
