#!/usr/bin/env node
// Scripted agents for exercising a Tower. Each agent files a flight plan, waits for
// clearance, clones its fork with the git CLI, edits only what it claimed, pushes, and lands.
// Agents share modules on purpose (agents > modules) so the tower has to sequence them.
//
// With --seed the sim creates the trunk and tears it down afterwards (trunk, forks, Tower
// state) unless --keep is passed, so test runs don't leave repos behind.
//
//   TOWER_URL=http://localhost:8787 TOWER_API_KEY=... node sim/agents.mjs --repo demo --seed --agents 8 --drift 1

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile, appendFile, mkdir } from "node:fs/promises";
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

async function api(method, path, body) {
	const res = await fetch(`${BASE}/repos/${args.repo}${path}`, {
		method,
		headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
		body: body ? JSON.stringify(body) : undefined,
	});
	return { status: res.status, body: await res.json() };
}

const git = (cwd, token, ...cmd) =>
	run("git", ["-c", `http.extraHeader=Authorization: Bearer ${token}`, ...cmd], { cwd });

const log = (who, msg) => console.log(`${new Date().toISOString().slice(11, 23)} ${who.padEnd(9)} ${msg}`);

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

async function agent(i, work) {
	const name = `agent-${i}`;
	const mod = `m${i % MODULES}`;
	const file = `src/modules/${mod}.ts`;
	const drifts = i < DRIFT;

	let { body } = await api("POST", "/plans", { agent: name, task: `extend ${file}`, claims: [file] });
	if (!body.plan) throw new Error(`${name} plan failed: ${JSON.stringify(body)}`);
	const id = body.plan.id;
	log(name, `plan ${id} ${body.plan.status}${body.plan.blockedBy.length ? ` behind ${body.plan.blockedBy}` : ""}`);
	try {
		await fly({ name, id, mod, file, drifts, body, work });
	} catch (err) {
		// Free the airspace so agents queued behind this one aren't stuck forever.
		await api("POST", `/plans/${id}/release`).catch(() => {});
		throw err;
	}
}

async function fly({ name, id, mod, file, drifts, body, work }) {
	const deadline = Date.now() + 120_000;
	while (!body.fork) {
		if (Date.now() > deadline) throw new Error(`${name} never got a fork: ${JSON.stringify(body)}`);
		if (body.error) log(name, `provision retry: ${body.error}`);
		await new Promise((r) => setTimeout(r, 500));
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
	let res = await api("POST", `/plans/${id}/land`, { evidence });
	if (res.status === 409) {
		log(name, `DRIFT blocked: ${res.body.drift.join(", ")} — reverting`);
		await run("git", ["checkout", "HEAD~1", "--", "README.md"], { cwd: dir });
		await commit(`${name}: stay inside lease`);
		await git(dir, token, "push", "-q", "origin", `HEAD:${branch}`);
		res = await api("POST", `/plans/${id}/land`, { evidence });
	}
	if (res.status !== 200) throw new Error(`${name} land failed: ${JSON.stringify(res.body)}`);
	log(name, `landed ${res.body.sha.slice(0, 8)} ${res.body.paths.join(", ")}`);
}

const work = await mkdtemp(join(tmpdir(), "tower-sim-"));
try {
	if (args.seed) await seed(work);
	const results = await Promise.allSettled(Array.from({ length: AGENTS }, (_, i) => agent(i, work)));
	for (const r of results) if (r.status === "rejected") console.error(r.reason);
	const { body } = await api("GET", "/state");
	console.log("\nstats", body.stats);
	if (args.seed && !args.keep) {
		const { body: gone } = await api("DELETE", "");
		console.log(`cleanup: deleted ${gone.deleted} repos and reset the tower`);
	}
} finally {
	await rm(work, { recursive: true, force: true });
}
