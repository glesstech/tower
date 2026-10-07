import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Tower } from "../../src/tower";
import { planDiff } from "../../src/tower/diff";
import { FakeArtifacts, type Snapshot } from "../fake-artifacts";

const SEED: Snapshot = { "README.md": "# trunk\n", "src/a.ts": "a\n", "src/b.ts": "b\n" };

// A Tower over a fake Artifacts namespace whose trunk workspace commits lands onto the fake
// trunk, so a landed plan has a real commit (and parent) to diff. The Tower is looked up by
// its repo name, as planDiff does, so each test gets its own repo name.
async function tower() {
	const repo = "t-" + crypto.randomUUID().slice(0, 8);
	const artifacts = new FakeArtifacts();
	const trunk = await artifacts.seed(repo, SEED);
	const stub = env.TOWER.getByName(repo);
	await runInDurableObject(stub, (instance: Tower) => {
		const t = instance as any;
		t.env = { ...t.env, ARTIFACTS: artifacts };
		t.workspace = {
			branch: "main",
			land: async (o: { fork: ArtifactsRepo; changes: { op: string; path: string; hash?: string }[] }) => {
				const files: Snapshot = { ...SEED };
				for (const c of o.changes) {
					if (c.op === "delete") delete files[c.path];
					else files[c.path] = await (await o.fork.readBlob(c.hash!))!.text();
				}
				return trunk.commit(files, "land");
			},
		};
	});
	const call = async (method: string, path: string, body?: unknown) => {
		const res = await stub.fetch(`https://tower${path}`, {
			method,
			headers: { "X-Tower-Repo": repo, "Content-Type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		return { status: res.status, body: (await res.json()) as any };
	};
	const file = async (agent: string, claims: string[]) => (await call("POST", "/plans", { agent, task: `${agent} task`, claims })).body.plan;
	const diff = (id: string) => planDiff({ TOWER: env.TOWER, ARTIFACTS: artifacts }, repo, id);
	return { repo, artifacts, call, file, diff };
}

describe("plan diff", () => {
	it("shows an in-flight plan's touched paths, with drift, in its fork", async () => {
		const t = await tower();
		const p = await t.file("a", ["src/a.ts"]);
		await t.artifacts.repos.get(p.fork)!.commit({ ...SEED, "src/a.ts": "a2\n", "docs/new.md": "n\n" }, "work");

		const d = (await t.diff(p.id))!;
		expect(d).toMatchObject({ source: "fork", fork: p.fork, base: p.base, sha: null, truncated: false });
		expect(d.plan).toMatchObject({ id: p.id, status: "cleared" });
		expect(d.files).toEqual([
			{ path: "docs/new.md", op: "added", old: null, new: expect.objectContaining({ text: "n\n" }), outside: true },
			{ path: "src/a.ts", op: "modified", old: expect.objectContaining({ text: "a\n" }), new: expect.objectContaining({ text: "a2\n", size: 3 }), outside: false },
		]);
	});

	it("does not count as the agent's heartbeat", async () => {
		const t = await tower();
		const p = await t.file("a", ["src/a.ts"]);
		const seen = (await t.call("GET", "/state")).body.plans[0].lastSeenAt;
		await new Promise((r) => setTimeout(r, 5));
		await t.diff(p.id);
		expect((await t.call("GET", "/state")).body.plans[0].lastSeenAt).toBe(seen);
	});

	it("diffs a landed plan on trunk: its commit against the parent, old and new contents", async () => {
		const t = await tower();
		const p = await t.file("a", ["src/"]);
		await t.artifacts.repos.get(p.fork)!.commit({ "README.md": "# trunk\n", "src/a.ts": "a\nmore\n", "src/c.ts": "c\n" }, "work");
		const landed = await t.call("POST", `/plans/${p.id}/land`, { summary: "a lands", evidence: { checks: "ok" } });
		expect(landed.status).toBe(200);

		const d = (await t.diff(p.id))!;
		expect(d).toMatchObject({ source: "trunk", sha: landed.body.sha, head: landed.body.sha });
		expect(d.plan.status).toBe("landed");
		expect(d.files.map((f) => [f.path, f.op, f.old?.text ?? null, f.new?.text ?? null])).toEqual([
			["src/a.ts", "modified", "a\n", "a\nmore\n"],
			["src/b.ts", "deleted", "b\n", null],
			["src/c.ts", "added", null, "c\n"],
		]);
	});

	it("explains plans with nothing to diff, and knows no unknown plan", async () => {
		const t = await tower();
		const a = await t.file("a", ["src/a.ts"]);
		const b = await t.file("b", ["src/a.ts"]);
		expect(await t.diff(b.id)).toMatchObject({ source: null, files: [], note: "holding: no fork yet" });
		await t.call("POST", `/plans/${a.id}/release`);
		expect(await t.diff(a.id)).toMatchObject({ source: null, files: [], note: expect.stringContaining("released") });
		expect(await t.diff("nope")).toBeNull();
	});
});
