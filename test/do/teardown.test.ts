import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Tower } from "../../src/tower";
import { artifactsError, FakeArtifacts } from "../fake-artifacts";

const REPO = "trunk";

// A Tower over a fake Artifacts namespace holding a seeded trunk (see tower.test.ts).
async function tower() {
	const artifacts = new FakeArtifacts();
	await artifacts.seed(REPO, { "src/a.ts": "a\n", "src/b.ts": "b\n" });
	const stub = env.TOWER.getByName(crypto.randomUUID());
	await runInDurableObject(stub, (instance: Tower) => {
		const t = instance as any;
		t.env = { ...t.env, ARTIFACTS: artifacts };
	});
	const call = async (method: string, path: string, body?: unknown) => {
		const res = await stub.fetch(`https://tower${path}`, {
			method,
			headers: { "X-Tower-Repo": REPO, "Content-Type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		return { status: res.status, body: (await res.json()) as Record<string, any> };
	};
	const file = async (agent: string, claims: string[]) => {
		await new Promise((r) => setTimeout(r, 5));
		const res = await call("POST", "/plans", { agent, task: `${agent} task`, claims });
		expect(res.status).toBe(201);
		return res.body;
	};
	return { artifacts, call, file };
}

describe("teardown", () => {
	it("deletes a fork that has no plan row, found by name in the namespace", async () => {
		const t = await tower();
		await t.file("a", ["src/a.ts"]);
		// A fork made by trunk.fork() whose plan row was never written.
		await t.artifacts.seed(`${REPO}--deadbeef`);
		// Another trunk's repos sharing the prefix stay.
		await t.artifacts.seed(`${REPO}--other`);
		await t.artifacts.seed(`${REPO}--other--0badf00d`);
		const res = await t.call("DELETE", "/");
		expect(res.body).toEqual({ deleted: 3 });
		expect([...t.artifacts.repos.keys()].sort()).toEqual([`${REPO}--other`, `${REPO}--other--0badf00d`]);
	});

	it("pages through the namespace to find leftover forks", async () => {
		const t = await tower();
		for (let i = 0; i < 205; i++) await t.artifacts.seed(`unrelated-${i}`);
		await t.artifacts.seed(`${REPO}--0000beef`);
		const res = await t.call("DELETE", "/");
		expect(res.body).toEqual({ deleted: 2 });
		expect(t.artifacts.repos.has(`${REPO}--0000beef`)).toBe(false);
		expect(t.artifacts.repos.size).toBe(205);
	});

	it("retries a failed delete", async () => {
		const t = await tower();
		const a = await t.file("a", ["src/a.ts"]);
		t.artifacts.failNext("delete", "INTERNAL_ERROR", { times: 2 });
		const res = await t.call("DELETE", "/");
		expect(res.body).toEqual({ deleted: 2 });
		expect(t.artifacts.repos.has(a.plan.fork)).toBe(false);
		expect(t.artifacts.repos.size).toBe(0);
	});

	it("reports a fork it failed to delete, and a second DELETE finishes the job", async () => {
		const t = await tower();
		const a = await t.file("a", ["src/a.ts"]);
		const b = await t.file("b", ["src/b.ts"]);
		const remove = t.artifacts.delete.bind(t.artifacts);
		t.artifacts.delete = async (name: string) => {
			if (name === b.plan.fork) throw artifactsError("UPSTREAM_UNAVAILABLE");
			return remove(name);
		};
		const res = await t.call("DELETE", "/");
		expect(res.body).toEqual({ deleted: 2, failed: [b.plan.fork] });
		expect(t.artifacts.repos.has(a.plan.fork)).toBe(false);
		expect(t.artifacts.repos.has(REPO)).toBe(false);
		expect(t.artifacts.repos.has(b.plan.fork)).toBe(true);

		// The tower's state is gone and so is the trunk; the fork is found by name.
		t.artifacts.delete = remove;
		const again = await t.call("DELETE", "/");
		expect(again.body).toEqual({ deleted: 1 });
		expect(t.artifacts.repos.size).toBe(0);
	});

	it("retries the fork delete after a release", async () => {
		const t = await tower();
		const a = await t.file("a", ["src/a.ts"]);
		t.artifacts.failNext("delete", "INTERNAL_ERROR");
		await t.call("POST", `/plans/${a.plan.id}/release`);
		expect(t.artifacts.repos.has(a.plan.fork)).toBe(false);
	});
});
