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
// --review n makes the last n agents change a sensitive path instead of a module, so their land
// answers 202 and waits in the human inbox: auth files (src/auth/), one CI workflow
// (.github/workflows/), and one module land whose checks report a failure, so the inbox shows
// more than one group. Each has a file of its own (a change in review keeps its claims), which
// --seed puts on trunk. The rest land as usual; the summary counts what went to review.
//
// The seed is a small Worker app listing each module's agents, so trunk can be deployed and
// watched. --plain runs the same workload on a local bare repo with no tower (no key needed)
// and counts merge conflicts (each one an edit redone) and rejected pushes: the contrast for a demo.
// --llm "<task>" (repeatable) starts real Claude Code agents through swarm/swarm.mjs on the same
// trunk before the scripted ones, on the cheap model unless --model names one. The sim waits for
// them before it reports, and Ctrl-C stops them and still tears down.
//
//   TOWER_URL=http://localhost:8787 TOWER_API_KEY=... node sim/agents.mjs --repo demo --seed --agents 8 --drift 1
//   node sim/agents.mjs --plain --agents 30 --modules 4
//   TOWER_API_KEY=... node sim/agents.mjs --repo scale --seed --agents 500 --modules 50 --stagger 120
//   TOWER_API_KEY=... node sim/agents.mjs --repo review-demo --seed --keep --review 3

import { execFile, spawn } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs, promisify } from "node:util";

const run = promisify(execFile);
const { values: args } = parseArgs({
	options: {
		repo: { type: "string", default: "demo" },
		agents: { type: "string", default: "8" },
		modules: { type: "string", default: "4" },
		drift: { type: "string", default: "0" },
		review: { type: "string", default: "0" },
		zipf: { type: "string", default: "1" },
		stagger: { type: "string", default: "0" },
		think: { type: "string", default: "0" },
		git: { type: "string", default: "24" },
		poll: { type: "string", default: "1500" },
		rng: { type: "string", default: "28" },
		out: { type: "string" },
		quiet: { type: "boolean", default: false },
		seed: { type: "boolean", default: false },
		keep: { type: "boolean", default: false },
		plain: { type: "boolean", default: false },
		llm: { type: "string", multiple: true, default: [] },
		model: { type: "string" },
	},
});
const BASE = process.env.TOWER_URL ?? "http://localhost:8787";
const KEY = process.env.TOWER_API_KEY;
if (!KEY && !args.plain) throw new Error("set TOWER_API_KEY");
if (args.plain && args.llm.length) throw new Error("--llm needs tower; drop --plain");
const AGENTS = Number(args.agents);
const MODULES = Number(args.modules);
const DRIFT = Number(args.drift);
const REVIEW = Number(args.review);
if (!(REVIEW >= 0 && REVIEW <= AGENTS)) throw new Error("--review must be between 0 and --agents");
const ZIPF = Number(args.zipf);
const STAGGER = Number(args.stagger) * 1000;
// Seconds an agent spends on its edit after cloning. Real agents take minutes, which is what lets
// uncoordinated agents collide; local git alone is too fast to overlap.
const THINK = Number(args.think) * 1000;
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
	const auth = token ? ["-c", `http.extraHeader=Authorization: Bearer ${token}`] : [];
	return limited(() => run("git", [...auth, ...cmd], { cwd }));
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

const PASSING = { checks: "1 passed, 0 failed", tests: { passed: 1, failed: 0 } };

// The --review agents (the last n) and what each changes: auth files, one CI workflow, one
// module land with a failing check. Each file is the agent's own, so no one queues behind it.
function reviewer(i) {
	const r = i - (AGENTS - REVIEW);
	if (r < 0) return null;
	if (r === 1) return { file: `.github/workflows/sim-${i}.yml`, seed: "name: sim\n", line: (name) => `# ${name}\n`, evidence: PASSING };
	if (r === 2) {
		const evidence = { checks: "1 passed, 1 failed", tests: { passed: 1, failed: 1 } };
		return { file: `src/modules/review-${i}.ts`, seed: `export const r${i} = [];\n`, line: (name) => `r${i}.push(${JSON.stringify(name)});\n`, evidence };
	}
	return { file: `src/auth/r${i}.ts`, seed: `export const r${i} = [];\n`, line: (name) => `r${i}.push(${JSON.stringify(name)});\n`, evidence: PASSING };
}

// The seed commit, the same for tower and --plain so the two runs start from one trunk.
// It is a small Worker that lists every module's agents, so a Worker connected to trunk through
// Workers Builds redeploys on each land and the page fills in as agents land.
async function writeSeed(dir) {
	await mkdir(join(dir, "src/modules"), { recursive: true });
	const worker = `tower-demo-${args.repo}`.toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 63).replace(/-+$/, "");
	const mods = Array.from({ length: MODULES }, (_, m) => `m${m}`);
	await writeFile(join(dir, "README.md"), `# demo\n\nA Worker that lists which agents landed in each module. Deploy with \`npm run deploy\`.\n`);
	await writeFile(join(dir, "package.json"), `${JSON.stringify({ name: worker, private: true, scripts: { deploy: "wrangler deploy" }, devDependencies: { wrangler: "^4" } }, null, 2)}\n`);
	await writeFile(join(dir, "wrangler.jsonc"), `${JSON.stringify({ name: worker, main: "src/index.ts", compatibility_date: "2026-09-01" }, null, 2)}\n`);
	for (const mod of mods) await writeFile(join(dir, `src/modules/${mod}.ts`), `export const ${mod}: string[] = [];\n`);
	await writeFile(
		join(dir, "src/index.ts"),
		`${mods.map((mod) => `import { ${mod} } from "./modules/${mod}";`).join("\n")}

const modules: Record<string, string[]> = { ${mods.join(", ")} };
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => \`&#\${c.charCodeAt(0)};\`);

export default {
	fetch(): Response {
		const sections = Object.entries(modules)
			.map(([name, agents]) => \`<section><h2>\${name} <small>\${agents.length}</small></h2><ul>\${agents.map((a) => \`<li>\${esc(a)}</li>\`).join("")}</ul></section>\`)
			.join("");
		const html = \`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>demo</title>
<style>body{font:15px system-ui;margin:2rem;display:grid;gap:1rem;grid-template-columns:repeat(auto-fill,minmax(12rem,1fr))}h1{grid-column:1/-1}small{color:#888}</style>
<h1>Agents by module</h1>\${sections}\`;
		return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
	},
};
`,
	);
	for (let i = AGENTS - REVIEW; i < AGENTS; i++) {
		const { file, seed: text } = reviewer(i);
		await mkdir(join(dir, file, ".."), { recursive: true });
		await writeFile(join(dir, file), text);
	}
	await run("git", ["init", "-b", "main"], { cwd: dir });
	await run("git", ["add", "."], { cwd: dir });
	await run("git", ["-c", "user.name=seed", "-c", "user.email=seed@tower.local", "commit", "-qm", "seed"], { cwd: dir });
}

async function seed(work) {
	const { status, body } = await api("POST", "/init");
	if (status !== 200) throw new Error(`init failed: ${JSON.stringify(body)}`);
	const dir = join(work, "seed");
	await writeSeed(dir);
	await git(dir, body.token, "push", body.remote, `HEAD:${body.branch ?? "main"}`);
	log("seed", `trunk ${body.remote}`);
}

// Client-side timings per agent: when it asked to land and how long the answer took.
const timings = [];
// Lands that answered 202 and wait in the inbox: agent and group label.
const reviews = [];

async function agent(i, m, work) {
	if (STAGGER) await sleep((STAGGER * i) / AGENTS + Math.random() * 250);
	const name = `agent-${i}`;
	const review = reviewer(i);
	const mod = `m${m}`;
	const file = review?.file ?? `src/modules/${mod}.ts`;
	const drifts = i < DRIFT && !review;

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
		await fly({ name, id, mod, file, drifts, review, body, work });
	} catch (err) {
		// Free the airspace so agents queued behind this one aren't stuck forever.
		await api("POST", `/plans/${id}/release`).catch(() => {});
		throw err;
	}
}

async function fly({ name, id, mod, file, drifts, review, body, work }) {
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

	if (THINK) await sleep(jitter(THINK));
	await appendFile(join(dir, file), review ? review.line(name) : `${mod}.push(${JSON.stringify(name)});\n`);
	// Without --seed a review file may be new; commit -a only stages tracked files.
	if (review) await run("git", ["add", file], { cwd: dir });
	if (drifts) await appendFile(join(dir, "README.md"), `${name} was here\n`);
	await commit(`${name}: extend ${file}`);
	await git(dir, token, "push", "-q", "origin", `HEAD:${branch}`);

	const evidence = { prompt: `extend ${file}`, ...(review?.evidence ?? PASSING) };
	const asked = Date.now();
	// A land that errors may still have landed, or gone to review; the plan says so.
	const landOnce = async () => {
		const res = await api("POST", `/plans/${id}/land`, { evidence }).catch((err) => ({ status: 599, body: { error: err.message } }));
		if (res.status < 500) return res;
		const { body: now } = await api("GET", `/plans/${id}`);
		if (now.plan?.status === "cleared" && now.plan.review) return { status: 202, body: { review: now.plan.review.risk } };
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
	if (res.status === 202) {
		// Done: the plan keeps its claims and fork until a human decides it.
		timings.push({ id, landMs: Date.now() - asked });
		reviews.push({ agent: name, group: res.body.review.group.label });
		await rm(dir, { recursive: true, force: true });
		log(name, `REVIEW ${res.body.review.group.label}: ${res.body.review.reasons.join("; ")}`);
		return;
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
		review: reviews.length,
		reviewGroups: Object.fromEntries(Object.entries(Object.groupBy(reviews, (r) => r.group)).map(([g, rs]) => [g, rs.length])),
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
// that picked it, each once, and trunk has one commit per land on top of the seed. Changes
// waiting for review have no module and no commit on trunk.
async function verify(work, assigned, landed, remote, token) {
	const dir = join(work, "verify");
	await git(work, token, "clone", "-q", remote, dir);
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

// ── plain git: the same workload with no tower ──────────────────────────────

// Each agent acts like an uncoordinated agent on a shared repo: clone, edit, commit, push. A
// rejected push pulls with rebase; a rebase that conflicts is thrown away and the edit redone
// on top of the new trunk. Everyone eventually lands, but every conflict is wasted work.
const plain = { rejectedPushes: 0, mergeConflicts: 0 };

async function plainAgent(i, m, remote, work) {
	if (STAGGER) await sleep((STAGGER * i) / AGENTS + Math.random() * 250);
	const name = `agent-${i}`;
	const file = `src/modules/m${m}.ts`;
	const dir = join(work, name);
	await git(work, null, "clone", "-q", remote, dir);
	const sh = (...cmd) => run("git", ["-c", `user.name=${name}`, "-c", `user.email=${name}@tower.local`, ...cmd], { cwd: dir });
	const edit = async () => {
		if (THINK) await sleep(jitter(THINK));
		await appendFile(join(dir, file), `m${m}.push(${JSON.stringify(name)});\n`);
		await sh("commit", "-qam", `${name}: extend ${file}`);
	};
	await edit();
	// Each round of rejections lets at least one agent through, so AGENTS rounds always suffice.
	for (let attempt = 1; ; attempt++) {
		try {
			await git(dir, null, "push", "-q", "origin", "HEAD:main");
			log(name, `pushed ${file}${attempt > 1 ? ` on try ${attempt}` : ""}`);
			break;
		} catch {}
		plain.rejectedPushes++;
		if (attempt > AGENTS) throw new Error(`${name} gave up after ${attempt} rejected pushes`);
		try {
			await sh("pull", "-q", "--rebase", "origin", "main");
		} catch {
			plain.mergeConflicts++;
			log(name, `CONFLICT in ${file}, redoing the edit`);
			await sh("rebase", "--abort").catch(() => {});
			await sh("reset", "-q", "--hard", "origin/main");
			await edit();
		}
	}
	await rm(dir, { recursive: true, force: true });
}

async function plainRun(work) {
	const remote = join(work, "plain.git");
	await run("git", ["init", "-q", "--bare", "-b", "main", remote]);
	const dir = join(work, "seed");
	await writeSeed(dir);
	await git(dir, null, "push", "-q", remote, "HEAD:main");
	const assigned = modulesFor(AGENTS);
	const startedAt = Date.now();
	const results = await Promise.allSettled(assigned.map((m, i) => plainAgent(i, m, remote, work)));
	const endedAt = Date.now();
	for (const r of results) if (r.status === "rejected") (failed++, console.error(r.reason));
	const problems = await verify(work, assigned, AGENTS - failed, remote, null);
	for (const p of problems) console.error(`CONTENT ${p}`);
	const report = {
		mode: "plain git (no tower)",
		agents: AGENTS,
		modules: MODULES,
		zipf: ZIPF,
		durationSec: Math.round((endedAt - startedAt) / 1000),
		pushed: AGENTS - failed,
		...plain,
		failed,
		contentProblems: problems.length,
	};
	failed += problems.length;
	console.log("\nplain git");
	for (const [k, v] of Object.entries(report)) console.log(`  ${k.padEnd(18)} ${v}`);
	console.log("\nThe same workload on tower (drop --plain, add --seed) reports conflictsPrevented: agents wait for their claim instead of colliding.");
	if (args.out) await writeFile(args.out, JSON.stringify({ repo: args.repo, savedAt: Date.now(), report }));
}

// ── real LLM agents ─────────────────────────────────────────────────────────

// The swarm starts one Claude Code agent per --llm task on this trunk; the sim only waits for it.
let llm = null;
function startLlm() {
	const swarm = new URL("../swarm/swarm.mjs", import.meta.url).pathname;
	// A sim run is test or demo work, so the agents run on the cheap model unless --model names one.
	const argv = [swarm, "--repo", args.repo, "--agent", "claude", ...args.llm.flatMap((t) => ["--task", t]), ...(args.model ? ["--model", args.model] : ["--cheap"])];
	log("llm", `starting ${args.llm.length} agent(s): swarm ${argv.slice(1).join(" ")}`);
	// Its own process group, so stopping the sim can stop the swarm and the agents it started.
	const child = spawn(process.execPath, argv, { env: { ...process.env, TOWER_URL: BASE, TOWER_API_KEY: KEY }, stdio: ["ignore", "pipe", "pipe"], detached: true });
	for (const stream of [child.stdout, child.stderr]) createInterface({ input: stream }).on("line", (line) => console.log(`llm ${line}`));
	const exit = new Promise((r) => (child.on("error", (err) => (console.error(err), r(-1))), child.on("close", (code) => r(code ?? -1))));
	llm = { child, exit };
}

// The swarm starts each agent in a process group of its own, so killing the swarm's group alone
// would leave the agents running: kill every descendant's group, deepest first.
async function stopLlm() {
	if (!llm || llm.child.exitCode !== null) return;
	const { stdout } = await run("ps", ["-A", "-o", "pid=,ppid="]).catch(() => ({ stdout: "" }));
	const kids = new Map();
	for (const [pid, ppid] of stdout.trim().split("\n").map((l) => l.trim().split(/\s+/).map(Number))) kids.set(ppid, [...(kids.get(ppid) ?? []), pid]);
	const tree = [];
	const walk = (pid) => (tree.unshift(pid), (kids.get(pid) ?? []).forEach(walk));
	walk(llm.child.pid);
	for (const pid of tree) {
		try {
			process.kill(-pid, "SIGTERM");
		} catch {}
	}
	await llm.exit;
}

async function towerRun(work) {
	if (args.seed) {
		seeded = true; // init may have created trunk even if seeding fails after it
		await seed(work);
	}
	if (args.llm.length) startLlm();
	// Review agents pick no module (null); the rest keep the choices --rng gives them.
	const assigned = modulesFor(AGENTS).map((m, i) => (reviewer(i) ? null : m));
	const startedAt = Date.now();
	const results = await Promise.allSettled(assigned.map((m, i) => agent(i, m, work)));
	const endedAt = Date.now();
	for (const r of results) if (r.status === "rejected") (failed++, console.error(r.reason));
	if (llm) log("llm", "scripted agents done; waiting for the LLM agents");
	const llmExit = llm ? await llm.exit : null;

	const [{ body: state }, events] = await Promise.all([api("GET", "/state"), eventLog()]);
	const report = metrics(events, state.stats, startedAt, endedAt);
	report.failed = failed;
	if (llm) {
		// The swarm exits 0 whether or not its agents landed, so count their lands too.
		report.llmLanded = `${new Set(events.filter((e) => e.type === "landed" && e.agent?.startsWith("claude-")).map((e) => e.agent)).size}/${args.llm.length}`;
		report.llmExit = llmExit;
		if (llmExit !== 0) failed++;
	}
	if (args.seed) {
		const { body: read } = await api("POST", "/token");
		const problems = await verify(work, assigned, report.landed, read.remote, read.token);
		report.conflicts = problems.length;
		for (const p of problems) console.error(`CONFLICT ${p}`);
		failed += problems.length;
	}
	const heat = Object.entries(assigned.reduce((acc, m) => (m !== null && (acc[m] = (acc[m] ?? 0) + 1), acc), {}))
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
}

const work = await mkdtemp(join(tmpdir(), "tower-sim-"));
let failed = 0;
let seeded = false;
let cleaning = null;
const cleanup = () =>
	(cleaning ??= (async () => {
		await stopLlm();
		if (seeded && !args.keep) {
			const { body: gone } = await api("DELETE", "", undefined, true).catch((err) => ({ body: { deleted: `none (${err.message})` } }));
			console.log(`cleanup: deleted ${gone.deleted} repos and reset the tower`);
		}
		if (args.plain && args.keep) console.log(`kept the plain repo: git clone ${join(work, "plain.git")}`);
		else await rm(work, { recursive: true, force: true });
	})());
// Ctrl-C stops the LLM agents and still tears down; a second Ctrl-C exits at once.
for (const sig of ["SIGINT", "SIGTERM"]) {
	process.on(sig, () => {
		if (cleaning) process.exit(130);
		console.error(`\n${sig}: stopping agents and cleaning up`);
		cleanup().finally(() => process.exit(130));
	});
}
try {
	await (args.plain ? plainRun(work) : towerRun(work));
} catch (err) {
	failed++;
	console.error(err);
} finally {
	await cleanup();
}
if (failed) process.exit(1);
