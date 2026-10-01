import { env, runInDurableObject } from "cloudflare:test";
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
