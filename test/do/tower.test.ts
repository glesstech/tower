import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Tower } from "../../src/tower";
import { FakeArtifacts, type Snapshot } from "../fake-artifacts";

const REPO = "trunk";
const SEED: Snapshot = { "README.md": "# trunk\n", "src/a.ts": "a\n", "src/b.ts": "b\n", "docs/guide.md": "g\n" };
const LANDED_SHA = "f".repeat(40);

type Body = Record<string, any>;

// A Tower with the Artifacts binding replaced by a fake, and a trunk workspace that
// records lands instead of pushing over HTTP. Each test gets its own Durable Object.
async function tower(opts: { seed?: boolean } = {}) {
	const artifacts = new FakeArtifacts();
	if (opts.seed !== false) await artifacts.seed(REPO, SEED);
	const landed: { message: string; paths: string[] }[] = [];
	const stub = env.TOWER.getByName(crypto.randomUUID());
	await runInDurableObject(stub, (instance: Tower) => {
		const t = instance as any;
		t.env = { ...t.env, ARTIFACTS: artifacts };
		t.workspace = {
			branch: "main",
			land: async (o: { message: string; changes: { path: string }[] }) => {
				landed.push({ message: o.message, paths: o.changes.map((c) => c.path) });
				return LANDED_SHA;
			},
		};
	});

	const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: Body }> => {
		const res = await stub.fetch(`https://tower${path}`, {
			method,
			headers: { "X-Tower-Repo": REPO, "Content-Type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		return { status: res.status, body: await res.json() };
	};
	// created_at has millisecond resolution; plans filed in the same millisecond would not queue.
	const file = async (agent: string, claims: string[]) => {
		await new Promise((r) => setTimeout(r, 5));
		const res = await call("POST", "/plans", { agent, task: `${agent} task`, claims });
		expect(res.status).toBe(201);
		return res.body;
	};
	const plan = async (id: string) => (await call("GET", `/plans/${id}`)).body.plan;
	// Commit a full snapshot to a plan's fork, as an agent pushing would.
	const push = async (id: string, files: Snapshot) => {
		const p = await plan(id);
		await artifacts.repos.get(p.fork)!.commit(files, `${p.agent} work`);
	};

	return { stub, artifacts, landed, call, file, plan, push };
}

describe("plan queueing", () => {
	it("clears a plan with no overlap and provisions its fork", async () => {
		const t = await tower();
		const res = await t.file("a", ["src/a.ts"]);
		expect(res.plan.status).toBe("cleared");
		expect(res.plan.fork).toBe(`${REPO}--${res.plan.id}`);
		expect(res.plan.base).toBe(await t.artifacts.repos.get(REPO)!.head());
		expect(res.fork).toMatchObject({ name: res.plan.fork, remote: expect.stringContaining(res.plan.fork) });
		expect(res.fork.token).toMatch(/^art_v1_/);
	});

	it("holds an overlapping plan behind the cleared one", async () => {
		const t = await tower();
		const a = await t.file("a", ["src/"]);
		const b = await t.file("b", ["src/a.ts"]);
		expect(b.plan).toMatchObject({ status: "holding", blockedBy: [a.plan.id], fork: null });
		expect(b.fork).toBeUndefined();
		expect((await t.call("GET", "/state")).body.stats.conflicts_prevented).toBe(1);
	});

	it("does not hold plans on sibling or prefix-only paths", async () => {
		const t = await tower();
		await t.file("a", ["src/a/"]);
		expect((await t.file("b", ["src/ab"])).plan.status).toBe("cleared");
		expect((await t.file("c", ["src/b/"])).plan.status).toBe("cleared");
	});

	it("queues FIFO: a later plan waits behind earlier holding plans", async () => {
		const t = await tower();
		const a = await t.file("a", ["src/"]);
		const b = await t.file("b", ["src/a.ts"]);
		const c = await t.file("c", ["src/a.ts"]);
		expect(c.plan).toMatchObject({ status: "holding", blockedBy: [a.plan.id, b.plan.id] });

		// Releasing a clears b (the earlier waiter); c now waits on b alone.
		expect((await t.call("POST", `/plans/${a.plan.id}/release`)).status).toBe(200);
		expect(await t.plan(b.plan.id)).toMatchObject({ status: "cleared", blockedBy: [] });
		expect(await t.plan(c.plan.id)).toMatchObject({ status: "holding", blockedBy: [b.plan.id] });
	});

	it("an earlier holding plan is not blocked by a later one", async () => {
		const t = await tower();
		const a = await t.file("a", ["src/a.ts"]);
		const b = await t.file("b", ["src/a.ts", "src/b.ts"]);
		const c = await t.file("c", ["src/b.ts"]);
		// c only overlaps b, which is still holding but was filed first.
		expect(c.plan).toMatchObject({ status: "holding", blockedBy: [b.plan.id] });
		await t.call("POST", `/plans/${a.plan.id}/release`);
		expect((await t.plan(b.plan.id)).status).toBe("cleared");
		expect((await t.plan(c.plan.id)).status).toBe("holding");
	});

	it("clears blocked plans when the blocker lands", async () => {
		const t = await tower();
		const a = await t.file("a", ["src/a.ts"]);
		const b = await t.file("b", ["src/a.ts"]);
		expect(b.plan.status).toBe("holding");

		await t.push(a.plan.id, { ...SEED, "src/a.ts": "a2\n" });
		const res = await t.call("POST", `/plans/${a.plan.id}/land`, { summary: "change a", evidence: { checks: "ok" } });
		expect(res).toMatchObject({ status: 200, body: { sha: LANDED_SHA, paths: ["src/a.ts"] } });
		expect(t.landed).toHaveLength(1);
		expect(t.landed[0].message).toContain(`Tower-Plan: ${a.plan.id}`);

		expect((await t.plan(a.plan.id)).status).toBe("landed");
		expect(t.artifacts.repos.has(a.plan.fork)).toBe(false); // landed forks are deleted
		const b2 = await t.call("GET", `/plans/${b.plan.id}`);
		expect(b2.body.plan).toMatchObject({ status: "cleared", blockedBy: [] });
		expect(b2.body.fork.name).toBe(`${REPO}--${b.plan.id}`);

		const why = await t.call("GET", "/why?path=src/a.ts");
		expect(why.body).toEqual([expect.objectContaining({ sha: LANDED_SHA, plan_id: a.plan.id, summary: "change a", evidence: { checks: "ok" } })]);
	});

	it("amend is granted only when the new paths are free", async () => {
		const t = await tower();
		const a = await t.file("a", ["src/a.ts"]);
		const b = await t.file("b", ["docs/"]);
		const denied = await t.call("POST", `/plans/${a.plan.id}/amend`, { claims: ["docs/guide.md"] });
		expect(denied.body).toMatchObject({ granted: false, blockedBy: [b.plan.id] });
		const granted = await t.call("POST", `/plans/${a.plan.id}/amend`, { claims: ["README.md"] });
		expect(granted.body.granted).toBe(true);
		expect(granted.body.plan.claims.map((c: { path: string }) => c.path)).toEqual(["src/a.ts", "README.md"]);
	});

	it("rejects invalid plans", async () => {
		const t = await tower();
		expect((await t.call("POST", "/plans", { agent: "a", task: "t", claims: [] })).status).toBe(400);
		expect((await t.call("POST", "/plans", { agent: "a", task: "t", claims: ["../x"] })).status).toBe(400);
	});
});

describe("amendments", () => {
	const paths = (plan: { claims: { path: string }[] }) => plan.claims.map((c) => c.path);

	it("holds a blocked amendment, keeping the fork and lease, until the blocker lands", async () => {
		const t = await tower();
		const a = await t.file("a", ["src/a.ts"]);
		const b = await t.file("b", ["docs/"]);
		const held = await t.call("POST", `/plans/${a.plan.id}/amend`, { claims: ["docs/guide.md"] });
		expect(held).toMatchObject({ status: 200, body: { granted: false, held: true, blockedBy: [b.plan.id] } });
		expect(held.body.plan).toMatchObject({ status: "cleared", fork: a.plan.fork, amendment: { blockedBy: [b.plan.id] } });
		expect(paths(held.body.plan)).toEqual(["src/a.ts"]);
		expect(t.artifacts.repos.has(a.plan.fork)).toBe(true);

		await t.push(b.plan.id, { ...SEED, "docs/guide.md": "g2\n" });
		expect((await t.call("POST", `/plans/${b.plan.id}/land`, { summary: "docs" })).status).toBe(200);
		const after = await t.plan(a.plan.id);
		expect(after).toMatchObject({ status: "cleared", fork: a.plan.fork, amendment: null });
		expect(paths(after)).toEqual(["src/a.ts", "docs/guide.md"]);
		// Asking again once granted is a no-op success.
		expect((await t.call("POST", `/plans/${a.plan.id}/amend`, { claims: ["docs/guide.md"] })).body.granted).toBe(true);
	});

	it("grants a held amendment when the blocker releases", async () => {
		const t = await tower();
		const a = await t.file("a", ["src/a.ts"]);
		const b = await t.file("b", ["src/b.ts"]);
		await t.call("POST", `/plans/${a.plan.id}/amend`, { claims: ["src/b.ts"] });
		await t.call("POST", `/plans/${b.plan.id}/release`);
		expect(paths(await t.plan(a.plan.id))).toEqual(["src/a.ts", "src/b.ts"]);
	});

	it("grants free paths at once without disturbing a held amendment", async () => {
		const t = await tower();
		const a = await t.file("a", ["src/a.ts"]);
		await t.file("b", ["docs/"]);
		await t.call("POST", `/plans/${a.plan.id}/amend`, { claims: ["docs/guide.md"] });
		const granted = await t.call("POST", `/plans/${a.plan.id}/amend`, { claims: ["README.md", "src/a.ts"] });
		expect(granted.body.granted).toBe(true);
		expect(paths(granted.body.plan)).toEqual(["src/a.ts", "README.md"]);
		expect(paths(granted.body.plan.amendment)).toEqual(["docs/guide.md"]);
	});

	it("does not duplicate paths already under a claimed directory", async () => {
		const t = await tower();
		const a = await t.file("a", ["src/"]);
		const res = await t.call("POST", `/plans/${a.plan.id}/amend`, { claims: ["src/a.ts"] });
		expect(res.body.granted).toBe(true);
		expect(paths(res.body.plan)).toEqual(["src/"]);
	});

	it("an in-flight amendment goes ahead of a holding plan for the same path", async () => {
		const t = await tower();
		const a = await t.file("a", ["src/a.ts"]);
		const b = await t.file("b", ["src/b.ts"]);
		const c = await t.file("c", ["src/b.ts"]);
		expect(c.plan.status).toBe("holding");
		await t.call("POST", `/plans/${a.plan.id}/amend`, { claims: ["src/b.ts"] });
		await t.call("POST", `/plans/${b.plan.id}/release`);
		expect(paths(await t.plan(a.plan.id))).toEqual(["src/a.ts", "src/b.ts"]);
		expect(await t.plan(c.plan.id)).toMatchObject({ status: "holding", blockedBy: [a.plan.id] });
	});

	it("refuses the amendment that would deadlock, leaving both leases and forks intact", async () => {
		const t = await tower();
		const a = await t.file("a", ["src/a.ts"]);
		const b = await t.file("b", ["src/b.ts"]);
		expect((await t.call("POST", `/plans/${a.plan.id}/amend`, { claims: ["src/b.ts"] })).body.held).toBe(true);
		const res = await t.call("POST", `/plans/${b.plan.id}/amend`, { claims: ["src/a.ts"] });
		expect(res.status).toBe(409);
		expect(res.body).toMatchObject({ granted: false, deadlock: [b.plan.id, a.plan.id, b.plan.id] });
		expect(res.body.error).toMatch(/deadlock/);
		expect(await t.plan(b.plan.id)).toMatchObject({ status: "cleared", fork: b.plan.fork, amendment: null });
		expect(await t.plan(a.plan.id)).toMatchObject({ status: "cleared", fork: a.plan.fork, amendment: { blockedBy: [b.plan.id] } });
		expect((await t.call("GET", "/state")).body.stats.deadlocks_prevented).toBe(1);

		// b finishes without src/a.ts; a then gets src/b.ts.
		await t.push(b.plan.id, { ...SEED, "src/b.ts": "b2\n" });
		expect((await t.call("POST", `/plans/${b.plan.id}/land`, { summary: "b" })).status).toBe(200);
		expect(paths(await t.plan(a.plan.id))).toEqual(["src/a.ts", "src/b.ts"]);
	});

	it("detects longer cycles", async () => {
		const t = await tower();
		const a = await t.file("a", ["src/a.ts"]);
		const b = await t.file("b", ["src/b.ts"]);
		const c = await t.file("c", ["docs/"]);
		await t.call("POST", `/plans/${a.plan.id}/amend`, { claims: ["src/b.ts"] });
		await t.call("POST", `/plans/${b.plan.id}/amend`, { claims: ["docs/guide.md"] });
		const res = await t.call("POST", `/plans/${c.plan.id}/amend`, { claims: ["src/a.ts"] });
		expect(res).toMatchObject({ status: 409, body: { deadlock: [c.plan.id, a.plan.id, b.plan.id, c.plan.id] } });
	});

	it("re-asking for a held amendment does not count as a cycle with itself", async () => {
		const t = await tower();
		const a = await t.file("a", ["src/a.ts"]);
		await t.file("b", ["src/b.ts"]);
		await t.call("POST", `/plans/${a.plan.id}/amend`, { claims: ["src/b.ts"] });
		const again = await t.call("POST", `/plans/${a.plan.id}/amend`, { claims: ["src/b.ts"] });
		expect(again).toMatchObject({ status: 200, body: { held: true } });
		expect(paths(again.body.plan.amendment)).toEqual(["src/b.ts"]);
		expect((await t.call("GET", "/state")).body.stats.amendments_held).toBe(1);
	});

	it("drops a plan's held amendment when it lands or releases", async () => {
		const t = await tower();
		const a = await t.file("a", ["src/a.ts"]);
		const b = await t.file("b", ["src/b.ts"]);
		await t.call("POST", `/plans/${a.plan.id}/amend`, { claims: ["src/b.ts"] });
		await t.call("POST", `/plans/${a.plan.id}/release`);
		expect(await t.plan(a.plan.id)).toMatchObject({ status: "released", amendment: null });
		await t.call("POST", `/plans/${b.plan.id}/release`);
		expect(paths(await t.plan(a.plan.id))).toEqual(["src/a.ts"]);
	});

	it("rejects amending a closed plan", async () => {
		const t = await tower();
		const a = await t.file("a", ["src/a.ts"]);
		await t.call("POST", `/plans/${a.plan.id}/release`);
		expect((await t.call("POST", `/plans/${a.plan.id}/amend`, { claims: ["src/b.ts"] })).status).toBe(400);
	});
});

describe("drift", () => {
	it("rejects a land that changes paths outside the lease with 409 and counts it", async () => {
		const t = await tower();
		const a = await t.file("a", ["src/a.ts"]);
		await t.push(a.plan.id, { ...SEED, "src/a.ts": "a2\n", "README.md": "drifted\n" });

		const check = await t.call("POST", `/plans/${a.plan.id}/check`);
		expect(check.body).toMatchObject({ drift: ["README.md"] });
		expect(check.body.touched.sort()).toEqual(["README.md", "src/a.ts"]);

		const res = await t.call("POST", `/plans/${a.plan.id}/land`, { summary: "x" });
		expect(res.status).toBe(409);
		expect(res.body).toMatchObject({ error: "changes outside lease", drift: ["README.md"], claims: ["src/a.ts"] });
		expect((await t.call("GET", "/state")).body.stats.drift_blocked).toBe(1);
		expect((await t.plan(a.plan.id)).status).toBe("cleared");
		expect(t.landed).toHaveLength(0);

		// Reverting the drift lets the same plan land.
		await t.push(a.plan.id, { ...SEED, "src/a.ts": "a2\n" });
		const ok = await t.call("POST", `/plans/${a.plan.id}/land`, { summary: "x" });
		expect(ok).toMatchObject({ status: 200, body: { paths: ["src/a.ts"] } });
	});

	it("rejects a land with nothing to land", async () => {
		const t = await tower();
		const a = await t.file("a", ["src/a.ts"]);
		const res = await t.call("POST", `/plans/${a.plan.id}/land`, {});
		expect(res).toMatchObject({ status: 400, body: { error: "nothing to land" } });
	});
});

describe("fork provisioning", () => {
	it("retries while Artifacts reports FORK_IN_PROGRESS", async () => {
		const t = await tower();
		t.artifacts.failNext("fork", "FORK_IN_PROGRESS", { times: 2 });
		t.artifacts.failNext("log", "FORK_IN_PROGRESS");
		const res = await t.file("a", ["src/a.ts"]);
		expect(res.plan.fork).toBe(`${REPO}--${res.plan.id}`);
		expect(res.fork.name).toBe(res.plan.fork);
		expect(t.artifacts.calls.fork).toBe(3);
	});

	it("returns the plan id with an error when provisioning fails, then recovers on the next poll", async () => {
		const t = await tower();
		t.artifacts.failNext("fork", "INTERNAL_ERROR");
		const res = await t.file("a", ["src/a.ts"]);
		expect(res.plan).toMatchObject({ status: "cleared", fork: null });
		expect(res.plan.id).toMatch(/^[0-9a-f]{8}$/);
		expect(res.error).toBe("INTERNAL_ERROR");
		expect(res.fork).toBeUndefined();

		const again = await t.call("GET", `/plans/${res.plan.id}`);
		expect(again.body.plan.fork).toBe(`${REPO}--${res.plan.id}`);
		expect(again.body.fork.name).toBe(again.body.plan.fork);
	});

	it("adopts a fork that an earlier failed attempt already created (ALREADY_EXISTS)", async () => {
		const t = await tower();
		// The fork is created, but the call still fails, as if its response were lost.
		t.artifacts.failNext("fork", "INTERNAL_ERROR", { after: true });
		const res = await t.file("a", ["src/a.ts"]);
		expect(res.error).toBe("INTERNAL_ERROR");
		expect(t.artifacts.repos.has(`${REPO}--${res.plan.id}`)).toBe(true);

		const again = await t.call("GET", `/plans/${res.plan.id}`);
		expect(again.status).toBe(200);
		expect(again.body.plan).toMatchObject({ status: "cleared", fork: `${REPO}--${res.plan.id}` });
		expect(again.body.plan.base).toBe(await t.artifacts.repos.get(REPO)!.head());
	});

	it("deletes the fork when a plan is released", async () => {
		const t = await tower();
		const a = await t.file("a", ["src/a.ts"]);
		expect(t.artifacts.repos.has(a.plan.fork)).toBe(true);
		await t.call("POST", `/plans/${a.plan.id}/release`);
		expect(t.artifacts.repos.has(a.plan.fork)).toBe(false);
	});

	it("tears down every fork and the trunk on DELETE", async () => {
		const t = await tower();
		await t.file("a", ["src/a.ts"]);
		await t.file("b", ["src/b.ts"]);
		expect(t.artifacts.repos.size).toBe(3);
		const res = await t.call("DELETE", "/");
		expect(res.body).toEqual({ deleted: 3 });
		expect(t.artifacts.repos.size).toBe(0);
	});
});

describe("dashboard", () => {
	it("lists trunk's files for the codebase map, walking the tree only when HEAD moves", async () => {
		const t = await tower();
		const trunk = t.artifacts.repos.get(REPO)!;
		let reads = 0;
		const readTree = trunk.readTree.bind(trunk);
		trunk.readTree = (hash: string) => (reads++, readTree(hash));

		const first = await t.call("GET", "/tree");
		expect(first.body).toEqual({ head: await trunk.head(), paths: ["README.md", "docs/guide.md", "src/a.ts", "src/b.ts"], truncated: false });
		const walked = reads;
		await t.call("GET", "/tree");
		expect(reads).toBe(walked);

		await trunk.commit({ ...SEED, "src/c.ts": "c\n" }, "add c");
		expect((await t.call("GET", "/tree")).body.paths).toContain("src/c.ts");
	});

	it("reads a file's contents on trunk HEAD for the code explorer", async () => {
		const t = await tower();
		const trunk = t.artifacts.repos.get(REPO)!;
		const res = await t.call("GET", "/blob?path=src/a.ts");
		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({ head: await trunk.head(), path: "src/a.ts", size: 2, binary: false, text: "a\n" });

		await trunk.commit({ ...SEED, "src/a.ts": "a2\n", "img.bin": "\0\x01\x02" }, "change a");
		expect((await t.call("GET", "/blob?path=src/a.ts")).body.text).toBe("a2\n");
		expect((await t.call("GET", "/blob?path=img.bin")).body).toMatchObject({ binary: true, text: null });

		expect((await t.call("GET", "/blob?path=src/missing.ts")).status).toBe(404);
		expect((await t.call("GET", "/blob?path=src")).status).toBe(404);
		expect((await t.call("GET", "/blob?path=README.md/x")).status).toBe(404);
		for (const bad of ["", "/src/a.ts", "src/../README.md", "src//a.ts"]) {
			expect((await t.call("GET", `/blob?path=${encodeURIComponent(bad)}`)).status).toBe(400);
		}
	});

	it("answers 404 for a trunk that was never created or was torn down", async () => {
		const missing = await tower({ seed: false });
		for (const path of ["/tree", "/blob?path=src/a.ts"]) {
			expect(await missing.call("GET", path)).toEqual({ status: 404, body: { error: "trunk not found", repo: REPO } });
		}

		const t = await tower();
		expect((await t.call("GET", "/tree")).status).toBe(200);
		t.artifacts.repos.delete(REPO);
		expect(await t.call("GET", "/tree")).toEqual({ status: 404, body: { error: "trunk not found", repo: REPO } });
	});

	it("keeps a missing fork from reading as a missing trunk", async () => {
		const t = await tower();
		const a = await t.file("a", ["src/a.ts"]);
		t.artifacts.repos.delete(a.plan.fork);
		const res = await t.call("POST", `/plans/${a.plan.id}/check`);
		expect(res.status).toBe(400);
		expect(res.body.error).not.toBe("trunk not found");
	});

	it("returns a path's whole history from /why with ?limit=", async () => {
		const t = await tower();
		for (let i = 0; i < 22; i++) {
			await runInDurableObject(t.stub, (instance: Tower) => {
				const sql = (instance as any).sql as SqlStorage;
				const sha = String(i).padStart(40, "0");
				sql.exec("INSERT INTO lands VALUES (?, ?, 'a', 'task', 'summary', 'null', ?)", sha, `p${i}`, i);
				sql.exec("INSERT INTO land_paths VALUES (?, 'src/a.ts')", sha);
			});
		}
		expect((await t.call("GET", "/why?path=src/a.ts")).body).toHaveLength(20);
		const all = (await t.call("GET", "/why?path=src/a.ts&limit=1000")).body as unknown as { plan_id: string }[];
		expect(all).toHaveLength(22);
		expect(all[0].plan_id).toBe("p21");
		expect((await t.call("GET", "/why?path=src/&limit=3")).body).toHaveLength(3);
	});

	it("matches /why paths literally, so _ and case don't widen a directory", async () => {
		const t = await tower();
		await runInDurableObject(t.stub, (instance: Tower) => {
			const sql = (instance as any).sql as SqlStorage;
			["src/a_b/x.ts", "src/axb/y.ts", "SRC/a_b/z.ts", "src/a_b.ts"].forEach((path, i) => {
				const sha = String(i).padStart(40, "0");
				sql.exec("INSERT INTO lands VALUES (?, ?, 'a', 'task', 'summary', 'null', ?)", sha, `p${i}`, i);
				sql.exec("INSERT INTO land_paths VALUES (?, ?)", sha, path);
			});
		});
		const why = async (path: string) => ((await t.call("GET", `/why?path=${path}`)).body as unknown as { plan_id: string }[]).map((l) => l.plan_id);
		expect(await why("src/a_b")).toEqual(["p0"]);
		expect(await why("src/a_b.ts")).toEqual(["p3"]);
		expect(await why("src/")).toEqual(["p3", "p1", "p0"]);
	});

	it("includes each land's paths in the state snapshot", async () => {
		const t = await tower();
		const a = await t.file("a", ["src/a.ts"]);
		await t.push(a.plan.id, { ...SEED, "src/a.ts": "a2\n" });
		await t.call("POST", `/plans/${a.plan.id}/land`, { summary: "change a" });
		const state = (await t.call("GET", "/state")).body;
		expect(state.lands).toEqual([expect.objectContaining({ sha: LANDED_SHA, agent: "a", paths: ["src/a.ts"] })]);
		expect(state.stats.landed).toBe(1);
	});
});

describe("event log", () => {
	const history = async (t: Awaited<ReturnType<typeof tower>>, query = "") => (await t.call("GET", `/events${query}`)).body;

	// Open /live as a client would and collect what it is sent.
	const connect = async (t: Awaited<ReturnType<typeof tower>>, query = "") => {
		const res = await t.stub.fetch(`https://tower/live${query}`, { headers: { Upgrade: "websocket", "X-Tower-Repo": REPO } });
		const ws = res.webSocket!;
		const got: Body[] = [];
		ws.addEventListener("message", (e) => {
			got.push(JSON.parse(e.data as string));
		});
		ws.accept();
		const settle = () => new Promise((r) => setTimeout(r, 20));
		await settle();
		return { got, settle, close: () => ws.close() };
	};

	it("records a run's full ordered history: filed, holding, cleared, amended, drift, landed, released", async () => {
		const t = await tower();
		const a = await t.file("a", ["src/a.ts"]);
		const b = await t.file("b", ["src/a.ts"]);
		await t.call("POST", `/plans/${a.plan.id}/amend`, { claims: ["docs/"] });
		await t.push(a.plan.id, { ...SEED, "src/a.ts": "a2\n", "README.md": "drifted\n" });
		expect((await t.call("POST", `/plans/${a.plan.id}/land`, { summary: "change a" })).status).toBe(409);
		await t.push(a.plan.id, { ...SEED, "src/a.ts": "a2\n" });
		expect((await t.call("POST", `/plans/${a.plan.id}/land`, { summary: "change a" })).status).toBe(200);
		await t.plan(b.plan.id);
		await t.call("POST", `/plans/${b.plan.id}/release`);

		const { events, last } = await history(t);
		const seqs = events.map((e: Body) => e.seq);
		expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
		expect(new Set(seqs).size).toBe(seqs.length);
		expect(last).toBe(seqs.at(-1));

		const lifecycle = events.filter((e: Body) => e.type !== "stat").map((e: Body) => `${e.agent}:${e.type}`);
		expect(lifecycle).toEqual([
			"a:filed", "a:cleared", "a:provisioned",
			"b:filed", "b:holding",
			"a:amended",
			"a:drift",
			"a:landed", "b:cleared",
			"b:provisioned",
			"b:released",
		]);
		const find = (agent: string, type: string) => events.find((e: Body) => e.agent === agent && e.type === type);
		expect(find("b", "holding")).toMatchObject({ planId: b.plan.id, blockedBy: [a.plan.id], plan: { status: "holding" } });
		expect(find("a", "amended")).toMatchObject({ added: ["docs/"] });
		expect(find("a", "drift")).toMatchObject({ planId: a.plan.id, paths: ["README.md"], blocked: true });
		expect(find("a", "landed")).toMatchObject({ sha: LANDED_SHA, summary: "change a", paths: ["src/a.ts"], plan: { status: "landed" } });
		expect(find("b", "released")).toMatchObject({ plan: { status: "released" } });
		expect(events.filter((e: Body) => e.type === "stat").map((e: Body) => e.key)).toEqual(["conflicts_prevented", "drift_blocked", "landed"]);
	});

	it("pages with since= and limit=, and filters by plan", async () => {
		const t = await tower();
		const a = await t.file("a", ["src/a.ts"]);
		await t.file("b", ["src/a.ts"]);
		await t.call("POST", `/plans/${a.plan.id}/release`);
		const all = (await history(t)).events;
		expect(all.length).toBeGreaterThan(5);

		const paged: Body[] = [];
		let since = 0;
		for (;;) {
			const page = await history(t, `?since=${since}&limit=2`);
			if (!page.events.length) break;
			expect(page.events.length).toBeLessThanOrEqual(2);
			paged.push(...page.events);
			since = page.last;
		}
		expect(paged).toEqual(all);
		expect((await history(t, `?since=${since}`)).last).toBe(since);

		const forA = (await history(t, `?plan=${a.plan.id}`)).events;
		expect(forA.map((e: Body) => e.type)).toEqual(["filed", "cleared", "provisioned", "released"]);
		expect(forA.every((e: Body) => e.planId === a.plan.id)).toBe(true);
	});

	it("records refused deadlocks and held amendments once", async () => {
		const t = await tower();
		const a = await t.file("a", ["src/a.ts"]);
		const b = await t.file("b", ["src/b.ts"]);
		await t.call("POST", `/plans/${a.plan.id}/amend`, { claims: ["src/b.ts"] });
		await t.call("POST", `/plans/${a.plan.id}/amend`, { claims: ["src/b.ts"] });
		await t.call("POST", `/plans/${b.plan.id}/amend`, { claims: ["src/a.ts"] });
		const events = (await history(t)).events;
		expect(events.filter((e: Body) => e.type === "amendment_held")).toEqual([
			expect.objectContaining({ planId: a.plan.id, paths: ["src/b.ts"], blockedBy: [b.plan.id] }),
		]);
		expect(events.find((e: Body) => e.type === "deadlock")).toMatchObject({
			planId: b.plan.id, paths: ["src/a.ts"], cycle: [b.plan.id, a.plan.id, b.plan.id],
		});
	});

	it("streams live events with their seq, and catches a reconnecting client up with since=", async () => {
		const t = await tower();
		const first = await connect(t);
		expect(first.got).toEqual([expect.objectContaining({ type: "state", state: expect.objectContaining({ seq: 0 }) })]);
		const a = await t.file("a", ["src/a.ts"]);
		await first.settle();
		const live = first.got.slice(1);
		expect(live.map((e) => e.type)).toEqual(["filed", "cleared", "provisioned"]);
		expect(live).toEqual((await history(t)).events);
		first.close();

		// Missed while disconnected.
		await t.file("b", ["src/a.ts"]);
		await t.call("POST", `/plans/${a.plan.id}/release`);
		const missed = (await history(t, `?since=${live.at(-1)!.seq}`)).events;
		expect(missed.length).toBeGreaterThan(0);

		const again = await connect(t, `?since=${live.at(-1)!.seq}`);
		expect(again.got).toEqual(missed);
		again.close();

		// A seq from before a reset (or otherwise unknown) gets a fresh snapshot instead.
		const stale = await connect(t, "?since=99999");
		expect(stale.got).toEqual([expect.objectContaining({ type: "state" })]);
		stale.close();
	});

	it("clears the log on DELETE", async () => {
		const t = await tower();
		await t.file("a", ["src/a.ts"]);
		expect((await history(t)).events.length).toBeGreaterThan(0);
		await t.call("DELETE", "/");
		expect((await history(t)).events).toEqual([]);
	});
});

describe("leases", () => {
	// Time passing for a plan: move its last_seen_at back, as if its agent had been silent that long.
	const silence = (t: Awaited<ReturnType<typeof tower>>, id: string, seconds: number) =>
		runInDurableObject(t.stub, (instance: Tower) => {
			const sql = (instance as any).sql as SqlStorage;
			sql.exec("UPDATE plans SET last_seen_at = ? WHERE id = ?", Date.now() - seconds * 1000, id);
		});
	const alarmAt = (t: Awaited<ReturnType<typeof tower>>) => runInDurableObject(t.stub, (_: Tower, state) => state.storage.getAlarm());

	it("expires a silent cleared plan: deletes its fork, frees its claims and clears the next plan", async () => {
		const t = await tower();
		const a = await t.file("a", ["src/"]);
		const b = await t.file("b", ["src/a.ts"]);
		expect(a.plan).toMatchObject({ status: "cleared", ttl: 900 });
		expect(b.plan.status).toBe("holding");
		const scheduled = await alarmAt(t);
		expect(scheduled).toBeGreaterThan(Date.now() + 890_000);
		expect(scheduled).toBeLessThanOrEqual(Date.now() + 900_000);

		// Before the TTL the alarm does nothing.
		await silence(t, a.plan.id, 600);
		expect(await runDurableObjectAlarm(t.stub)).toBe(true);
		expect((await t.call("GET", "/state")).body.plans.map((p: Body) => p.id)).toEqual([a.plan.id, b.plan.id]);

		await silence(t, a.plan.id, 901);
		expect(await runDurableObjectAlarm(t.stub)).toBe(true);

		const state = (await t.call("GET", "/state")).body;
		expect(state.stats.leases_expired).toBe(1);
		expect(state.plans).toEqual([expect.objectContaining({ id: b.plan.id, status: "cleared" })]);
		expect(t.artifacts.repos.has(a.plan.fork)).toBe(false);
		const expired = (await t.call("GET", `/events?plan=${a.plan.id}`)).body.events.at(-1);
		expect(expired).toMatchObject({ type: "expired", agent: "a", ttl: 900, plan: { status: "expired" } });
		expect(expired.silentFor).toBeGreaterThanOrEqual(901_000);

		// The plan that took off gets a full lease of its own and its fork; the expired one stays closed.
		const b2 = await t.call("GET", `/plans/${b.plan.id}`);
		expect(b2.body.fork.name).toBe(`${REPO}--${b.plan.id}`);
		expect(await alarmAt(t)).toBeGreaterThan(Date.now() + 890_000);
		expect((await t.call("GET", `/plans/${a.plan.id}`)).body.plan.status).toBe("expired");
		expect((await t.call("POST", `/plans/${a.plan.id}/heartbeat`)).status).toBe(400);
		expect((await t.call("POST", `/plans/${a.plan.id}/land`, { summary: "late" })).status).toBe(400);
		expect((await t.call("POST", `/plans/${a.plan.id}/release`)).body.plan.status).toBe("expired");
	});

	it("heartbeats, polls and checks keep a long-running plan alive", async () => {
		const t = await tower();
		const a = await t.file("a", ["src/a.ts"]);

		for (const beat of [
			() => t.call("POST", `/plans/${a.plan.id}/heartbeat`),
			() => t.call("GET", `/plans/${a.plan.id}`),
			() => t.call("POST", `/plans/${a.plan.id}/check`),
		]) {
			// Hours of work in all, but never 15 minutes without a word.
			await silence(t, a.plan.id, 840);
			const res = await beat();
			expect(res.status).toBe(200);
			expect(await runDurableObjectAlarm(t.stub)).toBe(true);
			expect((await t.plan(a.plan.id)).status).toBe("cleared");
		}
		const beat = await t.call("POST", `/plans/${a.plan.id}/heartbeat`);
		expect(beat.body.expiresAt).toBeGreaterThan(Date.now() + 890_000);

		// The same silence without a heartbeat in between expires it.
		await silence(t, a.plan.id, 901);
		await runDurableObjectAlarm(t.stub);
		expect((await t.call("GET", `/plans/${a.plan.id}`)).body.plan.status).toBe("expired");
	});

	it("takes a per-plan TTL on filing, capped", async () => {
		const t = await tower();
		expect((await t.file("a", ["src/a.ts"])).plan.ttl).toBe(900);
		const short = await t.call("POST", "/plans", { agent: "b", task: "t", claims: ["src/b.ts"], ttl: 5 });
		expect(short.body.plan.ttl).toBe(60);
		const long = await t.call("POST", "/plans", { agent: "c", task: "t", claims: ["docs/"], ttl: 999_999 });
		expect(long.body.plan.ttl).toBe(3600);
		expect((await t.call("POST", "/plans", { agent: "d", task: "t", claims: ["x"], ttl: "soon" })).status).toBe(400);

		await silence(t, short.body.plan.id, 61);
		await runDurableObjectAlarm(t.stub);
		const plans = (await t.call("GET", "/state")).body.plans.map((p: Body) => p.agent);
		expect(plans).toEqual(["a", "c"]);
	});

	it("does not expire a holding plan, and starts its lease when it clears", async () => {
		const t = await tower();
		const a = await t.file("a", ["src/"]);
		const b = await t.file("b", ["src/a.ts"]);
		await silence(t, b.plan.id, 5000);
		await runDurableObjectAlarm(t.stub);
		expect((await t.plan(b.plan.id)).status).toBe("holding");

		await silence(t, b.plan.id, 5000);
		await t.call("POST", `/plans/${a.plan.id}/release`);
		await runDurableObjectAlarm(t.stub);
		expect((await t.plan(b.plan.id)).status).toBe("cleared");
	});
});

describe("review by exception", () => {
	// A tower whose workspace really lands onto the fake trunk (each land a new commit), so trunk
	// moves the way it does in production and the scorer sees the composed tree.
	async function composing() {
		const t = await tower();
		const trunk = t.artifacts.repos.get(REPO)!;
		await runInDurableObject(t.stub, (instance: Tower) => {
			(instance as any).workspace = {
				branch: "main",
				land: async (o: { fork: ArtifactsRepo; changes: { op: string; path: string; hash?: string }[]; message: string }) => {
					const files = await snapshot(trunk);
					for (const c of o.changes) {
						if (c.op === "delete") delete files[c.path];
						else files[c.path] = await (await o.fork.readBlob(c.hash!))!.text();
					}
					const sha = await trunk.commit(files, o.message);
					t.landed.push({ message: o.message, paths: o.changes.map((c) => c.path) });
					return sha;
				},
			};
		});
		const land = (id: string, body: Body = { summary: "s", evidence: { checks: "npm test: ok" } }) => t.call("POST", `/plans/${id}/land`, body);
		const decide = (body: Body) => t.call("POST", "/inbox/decide", body);
		const inbox = async () => (await t.call("GET", "/inbox")).body;
		return { ...t, trunk, land, decide, inbox };
	}

	async function snapshot(repo: ArtifactsRepo): Promise<Snapshot> {
		const [head] = await repo.log({ limit: 1 });
		const files: Snapshot = {};
		const walk = async (hash: string, prefix: string) => {
			for (const e of (await repo.readTree(hash))!) {
				if (e.type === "tree") await walk(e.hash, `${prefix}${e.name}/`);
				else files[prefix + e.name] = await (await repo.readBlob(e.hash))!.text();
			}
		};
		await walk((await repo.readCommit(head.hash))!.treeHash, "");
		return files;
	}

	it("auto-lands a low-risk change and reports its score", async () => {
		const t = await composing();
		const a = await t.file("a", ["src/a.ts"]);
		await t.push(a.plan.id, { ...SEED, "src/a.ts": "a2\n" });
		const res = await t.land(a.plan.id);
		expect(res).toMatchObject({ status: 200, body: { paths: ["src/a.ts"], risk: { level: "low", reasons: [] } } });
		expect((await t.inbox())).toMatchObject({ decisions: [], headline: { autoLanded: 1, decisions: 0 } });
	});

	it("queues a sensitive change for a human, holds its claims, and lands it on approval", async () => {
		const t = await composing();
		const a = await t.file("a", ["src/auth/"]);
		const b = await t.file("b", ["src/auth/session.ts"]);
		await t.push(a.plan.id, { ...SEED, "src/auth/session.ts": "export const ttl = 1;\n" });
		const res = await t.land(a.plan.id);
		expect(res.status).toBe(202);
		expect(res.body.review).toMatchObject({ level: "review", reasons: ["sensitive: auth (src/auth/session.ts)"], group: { key: "sensitive:auth" } });
		expect(t.landed).toHaveLength(0);

		// Still cleared and holding its airspace; can't be landed again or released by a sweep.
		expect(await t.plan(a.plan.id)).toMatchObject({ status: "cleared", review: { paths: ["src/auth/session.ts"] } });
		expect((await t.plan(b.plan.id)).status).toBe("holding");
		expect((await t.land(a.plan.id)).status).toBe(409);
		expect((await t.call("POST", `/plans/${a.plan.id}/release`)).status).toBe(409);

		const box = await t.inbox();
		expect(box.decisions).toMatchObject([{ key: "sensitive:auth", label: "1 auth change", count: 1, plans: [{ id: a.plan.id, agent: "a", summary: "s" }] }]);
		expect(box.headline).toMatchObject({ agents: 2, conflictsReachedHuman: 0, decisions: 1, text: "2 agents, 0 conflicts reached a human, 1 decision required" });

		const decided = await t.decide({ decision: "approve", group: "sensitive:auth" });
		expect(decided.body.results).toMatchObject([{ id: a.plan.id, outcome: "landed", paths: ["src/auth/session.ts"] }]);
		expect(t.landed).toHaveLength(1);
		expect(await t.plan(a.plan.id)).toMatchObject({ status: "landed", review: null });
		expect((await t.plan(b.plan.id)).status).toBe("cleared");
		expect((await t.inbox()).headline.text).toBe("2 agents, 0 conflicts reached a human, 1 decision required");
		expect((await t.call("GET", "/state")).body.stats).toMatchObject({ reviews_queued: 1, reviews_approved: 1, decisions: 1, landed: 1 });
	});

	it("groups similar changes into one decision", async () => {
		const t = await composing();
		const ids = [];
		for (const n of ["a", "b", "c"]) {
			const p = await t.file(n, [`.github/workflows/${n}.yml`]);
			await t.push(p.plan.id, { ...SEED, [`.github/workflows/${n}.yml`]: "on: push\n" });
			expect((await t.land(p.plan.id)).status).toBe(202);
			ids.push(p.plan.id);
		}
		const box = await t.inbox();
		expect(box.decisions).toHaveLength(1);
		expect(box.decisions[0]).toMatchObject({ key: "sensitive:CI config", label: "3 CI config changes", count: 3 });

		const res = await t.decide({ decision: "approve", group: "sensitive:CI config" });
		expect(res.body.results.map((r: Body) => r.outcome)).toEqual(["landed", "landed", "landed"]);
		expect(t.landed).toHaveLength(3);
		expect(Object.keys(await snapshot(t.trunk)).filter((p) => p.startsWith(".github/")).sort()).toEqual(
			[".github/workflows/a.yml", ".github/workflows/b.yml", ".github/workflows/c.yml"],
		);
		expect((await t.inbox()).headline).toMatchObject({ agents: 3, decisions: 1 });
	});

	it("rejects (releasing the plan) and sends back (the agent may push and land again)", async () => {
		const t = await composing();
		const a = await t.file("a", ["src/billing/"]);
		const b = await t.file("b", ["src/billing/plan.ts"]);
		await t.push(a.plan.id, { ...SEED, "src/billing/plan.ts": "x\n" });
		await t.land(a.plan.id);
		const back = await t.decide({ decision: "send_back", plans: [a.plan.id], note: "add a test" });
		expect(back.body.results).toEqual([{ id: a.plan.id, outcome: "sent_back" }]);
		expect(await t.plan(a.plan.id)).toMatchObject({ status: "cleared", review: null });
		const { events } = (await t.call("GET", `/events?plan=${a.plan.id}`)).body;
		expect(events.find((e: Body) => e.type === "sent_back")).toMatchObject({ note: "add a test" });

		await t.push(a.plan.id, { ...SEED, "src/billing/plan.ts": "y\n", "src/billing/plan.test.ts": "t\n" });
		expect((await t.land(a.plan.id)).status).toBe(202);
		expect((await t.decide({ decision: "reject", plans: [a.plan.id] })).body.results).toEqual([{ id: a.plan.id, outcome: "rejected" }]);
		expect((await t.plan(a.plan.id)).status).toBe("released");
		expect((await t.plan(b.plan.id)).status).toBe("cleared");
		expect(t.landed).toHaveLength(0);
		expect((await t.decide({ decision: "approve", plans: [a.plan.id] })).body.results).toMatchObject([{ outcome: "error" }]);
		expect((await t.decide({ decision: "maybe", plans: [a.plan.id] })).status).toBe(400);
		expect((await t.decide({ decision: "approve", group: "nope" })).status).toBe(400);
	});

	it("sends an approval back if the fork moved after it was scored", async () => {
		const t = await composing();
		const a = await t.file("a", ["src/auth/"]);
		await t.push(a.plan.id, { ...SEED, "src/auth/x.ts": "1\n" });
		await t.land(a.plan.id);
		await t.push(a.plan.id, { ...SEED, "src/auth/x.ts": "2\n" });
		const res = await t.decide({ decision: "approve", plans: [a.plan.id] });
		expect(res.body.results).toEqual([{ id: a.plan.id, outcome: "sent_back", reason: "fork changed since it was reviewed" }]);
		expect(t.landed).toHaveLength(0);
		expect(await t.plan(a.plan.id)).toMatchObject({ status: "cleared", review: null });
	});

	it("catches a semantic conflict: a call added since the fork to a module this change edits", async () => {
		const t = await composing();
		await t.trunk.commit({ ...SEED, "src/a.ts": "export function f(x: number) {}\n" });
		const a = await t.file("a", ["src/a.ts"]);
		const b = await t.file("b", ["src/b.ts"]);
		const base = await snapshot(t.trunk);

		// B adds a call to f in b.ts; it touches nothing A holds, so it lands on its own.
		await t.push(b.plan.id, { ...base, "src/b.ts": 'import { f } from "./a";\nf(1);\n' });
		const landedB = await t.land(b.plan.id);
		expect(landedB).toMatchObject({ status: 200, body: { risk: { level: "low" } } });

		// A changes f's signature, from a fork made before B landed: a human has to look.
		await t.push(a.plan.id, { ...base, "src/a.ts": "export function f(x: string, y: string) {}\n" });
		const res = await t.land(a.plan.id);
		expect(res.status).toBe(202);
		expect(res.body.review.reasons).toEqual([
			`semantic overlap: landed since this fork, src/b.ts (b, ${landedB.body.sha.slice(0, 8)}) imports src/a.ts`,
		]);
		expect(res.body.review.group.key).toBe("semantic:src/");
	});

	it("flags deleting a module trunk still imports", async () => {
		const t = await composing();
		await t.trunk.commit({ ...SEED, "src/b.ts": 'import { a } from "./a";\n' });
		const a = await t.file("a", ["src/a.ts"]);
		const files = await snapshot(t.trunk);
		delete files["src/a.ts"];
		await t.push(a.plan.id, files);
		const res = await t.land(a.plan.id);
		expect(res.status).toBe(202);
		expect(res.body.review.reasons).toContain("deletes src/a.ts, still imported by src/b.ts");
	});

	it("pauses the lease while a change waits for a human, and restarts it on send-back", async () => {
		const t = await composing();
		const a = await t.file("a", ["src/auth/"]);
		await t.push(a.plan.id, { ...SEED, "src/auth/x.ts": "1\n" });
		await t.land(a.plan.id);
		await runInDurableObject(t.stub, (instance: Tower) => {
			(instance as any).sql.exec("UPDATE plans SET last_seen_at = ? WHERE id = ?", Date.now() - 10_000_000, a.plan.id);
		});
		await runDurableObjectAlarm(t.stub);
		expect((await t.plan(a.plan.id)).status).toBe("cleared");

		await t.decide({ decision: "send_back", plans: [a.plan.id] });
		const { body } = await t.call("POST", `/plans/${a.plan.id}/heartbeat`);
		expect(body.expiresAt).toBeGreaterThan(Date.now() + 800_000);
	});
});

describe("scale", () => {
	it("a land clears the next plan in a long line without re-announcing everyone behind it", async () => {
		const t = await tower();
		const a = await t.file("a", ["src/a.ts"]);
		const queued = [];
		for (const name of ["b", "c", "d", "e"]) queued.push((await t.file(name, ["src/a.ts"])).plan.id);
		await t.push(a.plan.id, { ...SEED, "src/a.ts": "a2\n" });
		expect((await t.call("POST", `/plans/${a.plan.id}/land`, { summary: "s" })).status).toBe(200);

		expect((await t.plan(queued[0])).status).toBe("cleared");
		for (const id of queued.slice(1)) expect((await t.plan(id)).status).toBe("holding");
		const { events } = (await t.call("GET", "/events")).body;
		// One holding event per queued plan (when it was filed), none after the land.
		expect(events.filter((e: Body) => e.type === "holding").map((e: Body) => e.planId)).toEqual(queued);
	});

	it("counts calls into Artifacts in stats, without logging an event for each", async () => {
		const t = await tower();
		const a = await t.file("a", ["src/a.ts"]);
		await t.plan(a.plan.id);
		const state = (await t.call("GET", "/state")).body;
		expect(state.stats.artifacts_calls).toBeGreaterThan(0);
		const { events } = (await t.call("GET", "/events")).body;
		expect(events.some((e: Body) => e.type === "stat" && e.key === "artifacts_calls")).toBe(false);
	});

	it("reuses one trunk write token across lands", async () => {
		const t = await tower();
		const trunk = t.artifacts.repos.get(REPO)!;
		await runInDurableObject(t.stub, (instance: Tower) => {
			let n = 0;
			(instance as any).workspace = { branch: "main", land: async () => String(++n).repeat(40) };
		});
		let tokens = 0;
		const create = trunk.createToken.bind(trunk);
		trunk.createToken = async (...args: Parameters<typeof create>) => {
			tokens++;
			return create(...args);
		};
		for (const [agent, path] of [["a", "src/a.ts"], ["b", "src/b.ts"]]) {
			const p = await t.file(agent, [path]);
			await t.push(p.plan.id, { ...SEED, [path]: `${agent}2\n` });
			expect((await t.call("POST", `/plans/${p.plan.id}/land`, { summary: agent })).status).toBe(200);
		}
		expect(tokens).toBe(1);
	});

	// A workspace that commits each land onto the fake trunk and, like TrunkWorkspace, knows the
	// HEAD it left. `failOnce` pushes the first land, then reports failure.
	async function landsOntoTrunk(t: Awaited<ReturnType<typeof tower>>, opts: { failOnce?: boolean } = {}) {
		const trunk = t.artifacts.repos.get(REPO)!;
		const files: Snapshot = { ...SEED };
		let fail = opts.failOnce;
		await runInDurableObject(t.stub, (instance: Tower) => {
			const workspace = {
				branch: "main",
				current: null as string | null,
				land: async (o: { fork: ArtifactsRepo; changes: { op: string; path: string; hash?: string }[]; message: string }) => {
					for (const c of o.changes) {
						if (c.op === "delete") delete files[c.path];
						else files[c.path] = await (await o.fork.readBlob(c.hash!))!.text();
					}
					const sha = await trunk.commit(files, o.message);
					if (fail) {
						fail = false;
						throw new Error("push reported failure");
					}
					workspace.current = sha;
					return sha;
				},
			};
			(instance as any).workspace = workspace;
		});
		return trunk;
	}

	const evidence = { summary: "s", evidence: { checks: "npm test: ok" } };

	it("carries trunk's file list over a land instead of walking trunk again", async () => {
		const t = await tower();
		const trunk = await landsOntoTrunk(t);
		expect((await t.call("GET", "/tree")).body.paths).toEqual(["README.md", "docs/guide.md", "src/a.ts", "src/b.ts"]);
		const p = await t.file("a", ["src/a.ts", "src/new/c.ts", "docs/guide.md"]);
		const { "docs/guide.md": _, ...kept } = SEED;
		await t.push(p.plan.id, { ...kept, "src/a.ts": "a2\n", "src/new/c.ts": "c\n" });
		expect((await t.call("POST", `/plans/${p.plan.id}/land`, evidence)).status).toBe(200);

		let reads = 0;
		const readTree = trunk.readTree.bind(trunk);
		trunk.readTree = (hash: string) => (reads++, readTree(hash));
		const logs = t.artifacts.calls.log;
		expect((await t.call("GET", "/tree")).body).toEqual({
			head: await trunk.head(),
			paths: ["README.md", "src/a.ts", "src/b.ts", "src/new/c.ts"],
			truncated: false,
		});
		expect(reads).toBe(0);
		expect(t.artifacts.calls.log).toBe(logs);
	});

	it("lands with one commit read on the fork, using the head that log returned", async () => {
		const t = await tower();
		await landsOntoTrunk(t);
		const p = await t.file("a", ["src/a.ts"]);
		await t.push(p.plan.id, { ...SEED, "src/a.ts": "a2\n" });
		const fork = t.artifacts.repos.get((await t.plan(p.plan.id)).fork)!;
		let reads = 0;
		const readCommit = fork.readCommit.bind(fork);
		fork.readCommit = (hash: string) => (reads++, readCommit(hash));
		const landed = await t.call("POST", `/plans/${p.plan.id}/land`, { evidence: evidence.evidence });
		expect(landed.status).toBe(200);
		expect(reads).toBe(1);
		const [top] = await t.artifacts.repos.get(REPO)!.log({ limit: 1 });
		expect(top.message.split("\n")[0]).toBe("a work");
	});

	it("takes a push that went through but reported failure as the land, not a reason to land twice", async () => {
		const t = await tower();
		const trunk = await landsOntoTrunk(t, { failOnce: true });
		const p = await t.file("a", ["src/a.ts"]);
		await t.push(p.plan.id, { ...SEED, "src/a.ts": "a2\n" });
		const landed = await t.call("POST", `/plans/${p.plan.id}/land`, evidence);
		expect(landed.status).toBe(200);
		expect(landed.body.sha).toBe(await trunk.head());
		expect((await trunk.log()).map((c) => c.message.split("\n")[0])).toEqual(["s", "seed"]);
	});
});
