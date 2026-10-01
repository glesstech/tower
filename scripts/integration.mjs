#!/usr/bin/env node
// Opt-in end-to-end check against a deployed tower (tower-dev by default). Spends real
// Artifacts operations, so CI never runs it. It runs the sim on a fresh trunk and asserts:
//   - all 8 agents landed and the drifting agent was blocked first
//   - trunk passes `git fsck --strict` and has one commit per land on top of the seed
//   - teardown leaves nothing from this run in the namespace
//
//   TOWER_API_KEY=$(cut -d= -f2 .dev.vars) npm run test:integration
//
// The namespace check uses `wrangler artifacts repos list`, so wrangler must be logged in.

import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const BASE = process.env.TOWER_URL ?? "https://tower-dev.g12r.workers.dev";
const KEY = process.env.TOWER_API_KEY;
const NAMESPACE = process.env.TOWER_NAMESPACE ?? "tower-dev";
const AGENTS = 8;
const REPO = `it-${Date.now().toString(36)}`;
if (!KEY) throw new Error("set TOWER_API_KEY");

async function api(method, path) {
	const res = await fetch(`${BASE}/repos/${REPO}${path}`, { method, headers: { Authorization: `Bearer ${KEY}` } });
	return { status: res.status, body: await res.json() };
}

const failures = [];
function check(ok, what) {
	console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
	if (!ok) failures.push(what);
}

function sim() {
	const args = ["sim/agents.mjs", "--repo", REPO, "--seed", "--keep", "--agents", String(AGENTS), "--drift", "1"];
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, args, { stdio: "inherit", env: { ...process.env, TOWER_URL: BASE } });
		child.on("error", reject);
		child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`sim exited ${code}`))));
	});
}

async function namespaceRepos() {
	const { stdout } = await run("npx", ["wrangler", "artifacts", "repos", "list", "--namespace", NAMESPACE, "--json"]);
	const parsed = JSON.parse(stdout);
	return (Array.isArray(parsed) ? parsed : parsed.repos ?? []).map((r) => r.name);
}

const work = await mkdtemp(join(tmpdir(), "tower-it-"));
let tornDown = false;
try {
	console.log(`integration: repo ${REPO} on ${BASE}\n`);
	await sim();

	const { body: state } = await api("GET", "/state");
	check(state.stats.landed === AGENTS, `${AGENTS}/${AGENTS} landed (got ${state.stats.landed ?? 0})`);
	check((state.stats.drift_blocked ?? 0) >= 1, `drift blocked (drift_blocked=${state.stats.drift_blocked ?? 0})`);
	check(state.plans.length === 0, `no plans left in flight (got ${state.plans.length})`);

	const { body: read } = await api("POST", "/token");
	const dir = join(work, "trunk");
	await run("git", ["-c", `http.extraHeader=Authorization: Bearer ${read.token}`, "clone", "-q", read.remote, dir]);
	const fsck = await run("git", ["fsck", "--strict", "--full", "--no-dangling"], { cwd: dir }).then(
		() => null,
		(err) => err.stderr || err.message,
	);
	check(fsck === null, `trunk git fsck --strict clean${fsck ? `: ${fsck}` : ""}`);
	const { stdout: count } = await run("git", ["rev-list", "--count", "HEAD"], { cwd: dir });
	check(Number(count) === AGENTS + 1, `trunk has seed + ${AGENTS} land commits (got ${count.trim()})`);

	const { body: gone } = await api("DELETE", "");
	tornDown = true;
	check(gone.deleted === 1, `teardown deleted only the trunk; forks were already gone (deleted=${gone.deleted})`);
	const left = (await namespaceRepos()).filter((name) => name === REPO || name.startsWith(`${REPO}--`));
	check(left.length === 0, `namespace ${NAMESPACE} has no repos from this run${left.length ? `: ${left.join(", ")}` : ""}`);
} finally {
	if (!tornDown) await api("DELETE", "").catch(() => {});
	await rm(work, { recursive: true, force: true });
}

if (failures.length) {
	console.error(`\n${failures.length} check(s) failed`);
	process.exit(1);
}
console.log("\nintegration passed");
