#!/usr/bin/env node
// Scripted agents for exercising a Tower. Each agent files a flight plan, waits for
// clearance, clones its fork with the git CLI, edits only what it claimed, pushes, and lands.
// Agents share modules on purpose (agents > modules) so the tower has to sequence them, and
// pick them by a Zipf distribution (--zipf, 0 for round-robin) so a few modules are hot.
// Starts are spread over --stagger seconds. Git runs at most --git at a time.
//
// At the end it reads the event log and prints throughput: plans/min, lands/min, p50/p95 time
// holding and land latency, max queue depth and agents in flight, and Artifacts calls. With
// --seed it then clones trunk and checks that every agent's line is there exactly once (zero
// conflicts), and tears everything down (trunk, forks, Tower state) unless --keep is passed.
// --out writes the metrics and the event log as JSON, so a run can be replayed later.
//
//   TOWER_URL=http://localhost:8787 TOWER_API_KEY=... node sim/agents.mjs --repo demo --seed --agents 8 --drift 1
//   TOWER_API_KEY=... node sim/agents.mjs --repo scale --seed --agents 500 --modules 50 --stagger 120

import { execFile } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, promisify } from "node:util";

const run = promisify(execFile);
const { values: args } = parseArgs({
	options: {
		repo: { type: "string", default: "demo" },
		agents: { type: "string", default: "8" },
		modules: { type: "string", default: "4" },
		drift: { type: "string", default: "0" },
		zipf: { type: "string", default: "1" },
		stagger: { type: "string", default: "0" },
		git: { type: "string", default: "24" },
		poll: { type: "string", default: "1500" },
		rng: { type: "string", default: "28" },
		out: { type: "string" },
		quiet: { type: "boolean", default: false },
		seed: { type: "boolean", default: false },
		keep: { type: "boolean", default: false },
	},
});
const BASE = process.env.TOWER_URL ?? "http://localhost:8787";
const KEY = process.env.TOWER_API_KEY;
if (!KEY) throw new Error("set TOWER_API_KEY");
const AGENTS = Number(args.agents);
const MODULES = Number(args.modules);
const DRIFT = Number(args.drift);
const ZIPF = Number(args.zipf);
const STAGGER = Number(args.stagger) * 1000;
const POLL = Number(args.poll);
// A cleared plan should get its fork within this long; holding has no deadline (the queue
// in front of a hot module can be long).
const FORK_DEADLINE = 180_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (ms) => ms * (0.75 + Math.random() * 0.5);

// Retries rate limits (refused before anything ran) always, and server errors and dropped
// connections only for requests that are safe to repeat: GETs, unless `retry` says otherwise.
// A filing or a land that fails that way may still have happened; their callers reconcile.
async function api(method, path, body, retry = method === "GET") {
	for (let attempt = 1; ; attempt++) {
		let res;
		try {
			res = await fetch(`${BASE}/repos/${args.repo}${path}`, {
				method,
				headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
				body: body ? JSON.stringify(body) : undefined,
			});
		} catch (err) {
			if (!retry || attempt >= 8) throw err;
			await sleep(jitter(500 * attempt));
			continue;
		}
		const text = await res.text();
		if ((res.status === 429 || (retry && res.status >= 500)) && attempt < 8) {
			await sleep(jitter(500 * attempt));
			continue;
		}
		let parsed;
		try {
			parsed = JSON.parse(text);
		} catch {
			parsed = { error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
		}
		return { status: res.status, body: parsed };
	}
}

// At most --git git processes at once: hundreds of concurrent clones would only thrash.
let gitSlots = Number(args.git);
const gitQueue = [];
const gitOps = { clone: 0, push: 0 };
async function limited(fn) {
	if (gitSlots > 0) gitSlots--;
	else await new Promise((r) => gitQueue.push(r));
	try {
		return await fn();
	} finally {
		const next = gitQueue.shift();
		if (next) next();
		else gitSlots++;
	}
}
const git = (cwd, token, ...cmd) => {
	if (cmd[0] in gitOps) gitOps[cmd[0]]++;
	return limited(() => run("git", ["-c", `http.extraHeader=Authorization: Bearer ${token}`, ...cmd], { cwd }));
};

const log = (who, msg) => {
	if (!args.quiet) console.log(`${new Date().toISOString().slice(11, 23)} ${who.padEnd(9)} ${msg}`);
};

// A seeded PRNG, so the same --rng gives the same module choices run to run.
function mulberry32(a) {
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

// Module k (0-based) is picked with weight 1/(k+1)^s: m0 is the hottest.
function modulesFor(n) {
	if (!ZIPF) return Array.from({ length: n }, (_, i) => i % MODULES);
	const rand = mulberry32(Number(args.rng));
	const weights = Array.from({ length: MODULES }, (_, k) => 1 / (k + 1) ** ZIPF);
	const total = weights.reduce((a, b) => a + b, 0);
	return Array.from({ length: n }, () => {
		let r = rand() * total;
		for (let k = 0; k < MODULES; k++) if ((r -= weights[k]) <= 0) return k;
		return MODULES - 1;
	});
}

async function seed(work) {
	const { status, body } = await api("POST", "/init");
	if (status !== 200) throw new Error(`init failed: ${JSON.stringify(body)}`);
	const dir = join(work, "seed");
	await mkdir(join(dir, "src/modules"), { recursive: true });
	await writeFile(join(dir, "README.md"), "# demo\n");
	for (let m = 0; m < MODULES; m++) await writeFile(join(dir, `src/modules/m${m}.ts`), `export const m${m} = [];\n`);
	await run("git", ["init", "-b", "main"], { cwd: dir });
	await run("git", ["add", "."], { cwd: dir });
	await run("git", ["-c", "user.name=seed", "-c", "user.email=seed@tower.local", "commit", "-m", "seed"], { cwd: dir });
	await git(dir, body.token, "push", body.remote, `HEAD:${body.branch ?? "main"}`);
	log("seed", `trunk ${body.remote}`);
}

// Client-side timings per agent: when it asked to land and how long the answer took.
const timings = [];

async function agent(i, m, work) {
	if (STAGGER) await sleep((STAGGER * i) / AGENTS + Math.random() * 250);
	const name = `agent-${i}`;
	const mod = `m${m}`;
	const file = `src/modules/${mod}.ts`;
	const drifts = i < DRIFT;

	let { body } = await api("POST", "/plans", { agent: name, task: `extend ${file}`, claims: [file] }).catch((err) => ({ body: { error: err.message } }));
	if (!body.plan) {
		// The filing may have gone through before the error: adopt it rather than leave a plan
		// nobody polls, which would hold up everyone queued behind it until its lease ran out.
		const { body: state } = await api("GET", "/state");
		const mine = state.plans?.find((p) => p.agent === name);
		if (mine) body = { plan: mine };
		else ({ body } = await api("POST", "/plans", { agent: name, task: `extend ${file}`, claims: [file] }));
	}
	if (!body.plan) throw new Error(`${name} plan failed: ${JSON.stringify(body)}`);
	const id = body.plan.id;
	log(name, `plan ${id} ${body.plan.status}${body.plan.blockedBy.length ? ` behind ${body.plan.blockedBy.length}` : ""}`);
	try {
		await fly({ name, id, mod, file, drifts, body, work });
	} catch (err) {
		// Free the airspace so agents queued behind this one aren't stuck forever.
		await api("POST", `/plans/${id}/release`).catch(() => {});
		throw err;
	}
}

async function fly({ name, id, mod, file, drifts, body, work }) {
	let clearedAt = null;
	while (!body.fork) {
		if (body.plan?.status === "cleared") clearedAt ??= Date.now();
		else if (body.plan && body.plan.status !== "holding") throw new Error(`${name} plan ${id} is ${body.plan.status}`);
		if (clearedAt && Date.now() - clearedAt > FORK_DEADLINE) throw new Error(`${name} never got a fork: ${JSON.stringify(body)}`);
		if (body.error) log(name, `provision retry: ${body.error}`);
		await sleep(jitter(clearedAt ? 500 : POLL));
		({ body } = await api("GET", `/plans/${id}`));
	}
	log(name, `cleared → ${body.fork.name}`);

	const dir = join(work, name);
	const { remote, token, branch = "main" } = body.fork;
	await git(work, token, "clone", "-q", remote, dir);
	const commit = (msg) =>
		run("git", ["-c", `user.name=${name}`, "-c", `user.email=${name}@tower.local`, "commit", "-qam", msg], { cwd: dir });

	await appendFile(join(dir, file), `${mod}.push(${JSON.stringify(name)});\n`);
	if (drifts) await appendFile(join(dir, "README.md"), `${name} was here\n`);
	await commit(`${name}: extend ${file}`);
	await git(dir, token, "push", "-q", "origin", `HEAD:${branch}`);

	const evidence = { prompt: `extend ${file}`, tests: { passed: 1, failed: 0 } };
	const asked = Date.now();
	// A land that errors may still have landed; the plan says so.
	const landOnce = async () => {
		const res = await api("POST", `/plans/${id}/land`, { evidence }).catch((err) => ({ status: 599, body: { error: err.message } }));
		if (res.status < 500) return res;
		const { body: now } = await api("GET", `/plans/${id}`);
		return now.plan?.status === "landed" ? { status: 200, body: { sha: "(landed)", paths: [file] } } : res;
	};
	let res = await landOnce();
	if (res.status === 409 && res.body.drift) {
		log(name, `DRIFT blocked: ${res.body.drift.join(", ")} — reverting`);
		await run("git", ["checkout", "HEAD~1", "--", "README.md"], { cwd: dir });
		await commit(`${name}: stay inside lease`);
		await git(dir, token, "push", "-q", "origin", `HEAD:${branch}`);
		res = await landOnce();
	}
	if (res.status !== 200) throw new Error(`${name} land failed: ${JSON.stringify(res.body)}`);
	timings.push({ id, landMs: Date.now() - asked });
	await rm(dir, { recursive: true, force: true });
	log(name, `landed ${res.body.sha.slice(0, 8)} ${res.body.paths.join(", ")}`);
}

// ── metrics ────────────────────────────────────────────────────────────────

async function eventLog() {
	const all = [];
	for (let since = 0; ; ) {
		const { body } = await api("GET", `/events?since=${since}&limit=10000`);
		if (!body.events?.length) return all;
		all.push(...body.events);
		since = body.last;
	}
}

const pct = (xs, p) => {
	if (!xs.length) return null;
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};

// Replays the event log: per-plan holding time, queue depth (holding) and agents in flight
// (cleared, not yet closed) over time, and per-minute rates.
function metrics(events, stats, startedAt, endedAt) {
	const status = {};
	const filedAt = {};
	const holding = [];
	let queue = 0, flying = 0, maxQueue = 0, maxFlying = 0, maxActive = 0, plans = 0, lands = 0;
	const perMinute = {};
	const minute = (at) => Math.floor((at - startedAt) / 60_000);
	const move = (id, next) => {
		const prev = status[id];
		if (prev === "holding") queue--;
		if (prev === "cleared") flying--;
		if (next === "holding") queue++;
		if (next === "cleared") flying++;
		status[id] = next;
		maxQueue = Math.max(maxQueue, queue);
		maxFlying = Math.max(maxFlying, flying);
		maxActive = Math.max(maxActive, queue + flying);
	};
	for (const e of events) {
		const id = e.planId;
		if (e.type === "filed") {
			plans++;
			filedAt[id] = e.at;
			(perMinute[minute(e.at)] ??= { plans: 0, lands: 0 }).plans++;
		} else if (e.type === "holding" && status[id] !== "holding") move(id, "holding");
		else if (e.type === "cleared" && status[id] !== "cleared") {
			move(id, "cleared");
			if (filedAt[id]) holding.push(e.at - filedAt[id]);
		} else if (e.type === "landed" || e.type === "released" || e.type === "expired") {
			move(id, e.type);
			if (e.type === "landed") {
				lands++;
				(perMinute[minute(e.at)] ??= { plans: 0, lands: 0 }).lands++;
			}
		}
	}
	const mins = (endedAt - startedAt) / 60_000;
	const landMs = timings.map((t) => t.landMs);
	const rates = Object.values(perMinute);
	return {
		agents: AGENTS,
		modules: MODULES,
		zipf: ZIPF,
		durationSec: Math.round((endedAt - startedAt) / 1000),
		plans,
		landed: lands,
		plansPerMin: +(plans / mins).toFixed(1),
		landsPerMin: +(lands / mins).toFixed(1),
		peakLandsPerMin: Math.max(0, ...rates.map((r) => r.lands)),
		holdingMs: { p50: pct(holding, 50), p95: pct(holding, 95), max: pct(holding, 100) },
		landLatencyMs: { p50: pct(landMs, 50), p95: pct(landMs, 95), max: pct(landMs, 100) },
		maxQueueDepth: maxQueue,
		maxInFlight: maxFlying,
		maxActive,
		conflictsPrevented: stats.conflicts_prevented ?? 0,
		driftBlocked: stats.drift_blocked ?? 0,
		events: events.length,
		artifactsCalls: stats.artifacts_calls ?? null,
		gitClones: gitOps.clone,
		gitPushes: gitOps.push,
	};
}

// Zero conflicts, checked on trunk itself: every module holds exactly the lines of the agents
// that picked it, each once, and trunk has one commit per land on top of the seed.
async function verify(work, assigned, landed) {
	const { body: read } = await api("POST", "/token");
	const dir = join(work, "verify");
	await git(work, read.token, "clone", "-q", read.remote, dir);
	const problems = [];
	for (let m = 0; m < MODULES; m++) {
		const text = await readFile(join(dir, `src/modules/m${m}.ts`), "utf8");
		const got = [...text.matchAll(/push\("([^"]+)"\)/g)].map((x) => x[1]).sort();
		const want = assigned.flatMap((k, i) => (k === m ? [`agent-${i}`] : [])).sort();
		if (got.join() !== want.join()) problems.push(`m${m}: ${got.length} lines, expected ${want.length}`);
	}
	const { stdout } = await run("git", ["rev-list", "--count", "HEAD"], { cwd: dir });
	if (Number(stdout) !== landed + 1) problems.push(`trunk has ${stdout.trim()} commits, expected ${landed + 1}`);
	return problems;
}

const work = await mkdtemp(join(tmpdir(), "tower-sim-"));
let failed = 0;
let seeded = false;
try {
	if (args.seed) {
		seeded = true; // init may have created trunk even if seeding fails after it
		await seed(work);
	}
	const assigned = modulesFor(AGENTS);
	const startedAt = Date.now();
	const results = await Promise.allSettled(assigned.map((m, i) => agent(i, m, work)));
	const endedAt = Date.now();
	for (const r of results) if (r.status === "rejected") (failed++, console.error(r.reason));

	const [{ body: state }, events] = await Promise.all([api("GET", "/state"), eventLog()]);
	const report = metrics(events, state.stats, startedAt, endedAt);
	report.failed = failed;
	if (args.seed) {
		const problems = await verify(work, assigned, report.landed);
		report.conflicts = problems.length;
		for (const p of problems) console.error(`CONFLICT ${p}`);
		failed += problems.length;
	}
	const heat = Object.entries(assigned.reduce((acc, m) => ((acc[m] = (acc[m] ?? 0) + 1), acc), {}))
		.sort((a, b) => b[1] - a[1])
		.slice(0, 5)
		.map(([m, n]) => `m${m}×${n}`);
	console.log(`\nhottest modules: ${heat.join(", ")}`);
	console.log("stats", state.stats);
	console.log("\nthroughput");
	for (const [k, v] of Object.entries(report)) console.log(`  ${k.padEnd(18)} ${typeof v === "object" && v ? JSON.stringify(v) : v}`);
	if (args.out) {
		await writeFile(args.out, JSON.stringify({ repo: args.repo, savedAt: Date.now(), report, state, events }));
		console.log(`\nwrote ${args.out} (load it in the dashboard with Load log)`);
	}
} catch (err) {
	failed++;
	console.error(err);
} finally {
	if (seeded && !args.keep) {
		const { body: gone } = await api("DELETE", "", undefined, true).catch((err) => ({ body: { deleted: `none (${err.message})` } }));
		console.log(`cleanup: deleted ${gone.deleted} repos and reset the tower`);
	}
	await rm(work, { recursive: true, force: true });
}
if (failed) process.exit(1);
