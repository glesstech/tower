import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Tower } from "../../src/tower";
import { setMeta } from "../../src/tower/core";
import { FakeArtifacts, type Snapshot } from "../fake-artifacts";

// Claim hygiene against a trunk big enough for "too broad" to mean something: 20 files, most
// of them under src/ (see LIMITS in src/claims.ts).
const REPO = "trunk";
const SEED: Snapshot = {
	"README.md": "# trunk\n",
	"wrangler.jsonc": "{}\n",
	"src/claims.ts": "c\n",
	"src/mcp.ts": "m\n",
	"src/tower/plans.ts": "p\n",
	"src/tower/events.ts": "e\n",
	"src/tower/leases.ts": "l\n",
	...Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`src/tower/m${i}.ts`, `${i}\n`])),
	"web/dashboard.js": "d\n",
	"web/model.js": "m\n",
	"docs/guide.md": "g\n",
};

type Body = Record<string, any>;

async function tower() {
	const artifacts = new FakeArtifacts();
	await artifacts.seed(REPO, SEED);
	const stub = env.TOWER.getByName(crypto.randomUUID());
	await runInDurableObject(stub, (instance: Tower) => {
		const t = instance as any;
		t.env = { ...t.env, ARTIFACTS: artifacts };
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
	const file = async (agent: string, claims: string[], extra: Body = {}) => {
		await new Promise((r) => setTimeout(r, 5));
		return call("POST", "/plans", { agent, task: `${agent} task`, claims, ...extra });
	};
	const stats = async () => (await call("GET", "/state")).body.stats;
	const meta = (key: string, value: string) => runInDurableObject(stub, (instance: Tower) => setMeta(instance as any, key, value));
	return { artifacts, call, file, stats, meta };
}

describe("claim hygiene", () => {
	it("refuses a claim on a top-level directory, suggesting the files under it that fit the task", async () => {
		const t = await tower();
		const res = await t.call("POST", "/plans", { agent: "a", task: "Show lease expiry on plans", claims: ["src/", "README.md"] });
		expect(res.status).toBe(422);
		expect(res.body).toMatchObject({ error: "claim_too_broad", broad: [{ path: "src/", files: 15 }] });
		expect(res.body.suggested.slice(0, 2)).toEqual(["src/tower/leases.ts", "src/tower/plans.ts"]);
		expect(res.body.message).toMatch(/^claim_too_broad: `src\/` covers 15 files, 75% of trunk/);
		expect(res.body.message).toMatch(/force: true/);
		expect((await t.call("GET", "/state")).body.plans).toEqual([]);
		expect(await t.stats()).toMatchObject({ claims_refused: 1 });
	});

	it("files a broad claim with force, counts it, and counts the agents it blocks", async () => {
		const t = await tower();
		const a = await t.file("a", ["src/"], { force: true });
		expect(a.status).toBe(201);
		expect(a.body).toMatchObject({ plan: { status: "cleared" }, forced: ["src/"], coverage: { files: 15, trunk: 20, share: 0.75 } });

		const b = await t.file("b", ["src/tower/events.ts"]);
		expect(b.body.plan).toMatchObject({ status: "holding", blockedBy: [a.body.plan.id] });
		expect(b.body.waiting).toEqual([
			expect.objectContaining({ agent: "a", held: "src/", yours: "src/tower/events.ts", reason: expect.stringMatching(/`src\/` is held by a \(in flight\)/) }),
		]);
		expect(await t.stats()).toMatchObject({ claims_forced: 1, blocked_by_broad: 1, conflicts_prevented: 1 });

		// The filed event carries the coverage, for the dashboard.
		const filed = (await t.call("GET", "/events")).body.events.find((e: Body) => e.type === "filed" && e.agent === "a");
		expect(filed).toMatchObject({ forced: ["src/"], coverage: { files: 15 } });
	});

	it("warns about guessed paths but files the plan", async () => {
		const t = await tower();
		const res = await t.file("a", ["src/server/blob.ts", "public/", "wrangler.toml", "src/tower/new.ts"]);
		expect(res.status).toBe(201);
		expect(res.body.plan.status).toBe("cleared");
		expect(res.body.warnings).toEqual([
			expect.stringMatching(/`src\/server\/blob\.ts` does not exist on trunk and neither does `src\/server\/`/),
			expect.stringMatching(/`public\/` has no files on trunk/),
			expect.stringMatching(/`wrangler\.toml` does not exist on trunk; did you mean `wrangler\.jsonc`/),
		]);
		expect(res.body.coverage).toMatchObject({ files: 0, trunk: 20 });
	});

	it("says nothing for narrow claims on real files", async () => {
		const t = await tower();
		const res = await t.file("a", ["src/tower/plans.ts", "docs/"]);
		expect(res.body.warnings).toBeUndefined();
		expect(res.body.forced).toBeUndefined();
		expect(res.body.coverage).toMatchObject({ files: 2, share: 0.1 });
	});

	it("refuses a broad amendment with 422 and grants a narrow one", async () => {
		const t = await tower();
		const a = await t.file("a", ["src/mcp.ts"]);
		const id = a.body.plan.id;
		const refused = await t.call("POST", `/plans/${id}/amend`, { claims: ["src/tower/"] });
		expect(refused.status).toBe(422);
		expect(refused.body).toMatchObject({ granted: false, error: "claim_too_broad", broad: [{ path: "src/tower/", files: 13 }] });
		expect(refused.body.message).toMatch(/force: true/);

		const granted = await t.call("POST", `/plans/${id}/amend`, { claims: ["src/tower/plans.ts"] });
		expect(granted.body).toMatchObject({ granted: true, coverage: { files: 1 } });
		expect(granted.body.plan.claims.map((c: Body) => c.path)).toEqual(["src/mcp.ts", "src/tower/plans.ts"]);

		// The amended event measures the whole lease, for the dashboard.
		const amended = (await t.call("GET", "/events")).body.events.find((e: Body) => e.type === "amended");
		expect(amended).toMatchObject({ added: ["src/tower/plans.ts"], coverage: { files: 2, trunk: 20, share: 0.1 } });
		expect(amended.forced).toBeUndefined();
	});

	it("grants a broad amendment with force and counts it", async () => {
		const t = await tower();
		const a = await t.file("a", ["src/mcp.ts"]);
		const forced = await t.call("POST", `/plans/${a.body.plan.id}/amend`, { claims: ["src/tower/"], force: true });
		expect(forced.status).toBe(200);
		expect(forced.body).toMatchObject({ granted: true });
		expect(forced.body.plan.claims.map((c: Body) => c.path)).toEqual(["src/mcp.ts", "src/tower/"]);
		expect(await t.stats()).toMatchObject({ claims_forced: 1 });
	});

	it("tells a holding plan when its own broad claim is what overlaps", async () => {
		const t = await tower();
		await t.file("a", ["src/tower/plans.ts"]);
		const b = await t.file("b", ["src/tower/"], { force: true });
		expect(b.body.waiting[0].reason).toMatch(/`src\/tower\/plans\.ts` is held by a \(in flight\), and your claim `src\/tower\/` covers it; narrow `src\/tower\/`/);
		// Polling (wait_for_clearance) gives the same answer.
		expect((await t.call("GET", `/plans/${b.body.plan.id}`)).body.waiting).toEqual(b.body.waiting);
	});

	it("takes per-trunk limits from meta", async () => {
		const t = await tower();
		await t.meta("claim_max_files", "1");
		const refused = await t.file("a", ["docs/", "web/"]);
		expect(refused.status).toBe(422);
		expect(refused.body.message).toMatch(/`web\/` covers 2 files .*the limit is 1/);
		await t.meta("claim_max_files", "1000");
		await t.meta("claim_min_files", "1000");
		expect((await t.file("a", ["src/"])).status).toBe(201);
	});

	it("files without measuring when trunk's tree can't be read", async () => {
		const t = await tower();
		t.artifacts.failNext("get", "INTERNAL_ERROR");
		const res = await t.file("a", ["src/"]);
		expect(res.status).toBe(201);
		expect(res.body.plan.status).toBe("cleared");
		expect(res.body.coverage).toBeUndefined();
	});
});
