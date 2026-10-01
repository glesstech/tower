import { describe, expect, it } from "vitest";
import { type Change, diffTrees } from "../../src/treediff";
import { FakeRepo, type Snapshot } from "../fake-artifacts";

// Commit `before` then `after` into one repo and diff their root trees.
async function diff(before: Snapshot, after: Snapshot) {
	const repo = await FakeRepo.create("t");
	const a = (await repo.readCommit(await repo.commit(before)))!.treeHash;
	const b = (await repo.readCommit(await repo.commit(after)))!.treeHash;
	const changes = await diffTrees(repo, a, b);
	return { repo, changes: sorted(changes) };
}

const sorted = (changes: Change[]) => [...changes].sort((x, y) => x.path.localeCompare(y.path) || x.op.localeCompare(y.op));
const summary = (changes: Change[]) => changes.map((c) => `${c.op} ${c.path}`);

describe("diffTrees", () => {
	it("reports nothing for identical trees", async () => {
		const files = { "a.txt": "a", "src/b.ts": "b" };
		expect((await diff(files, { ...files })).changes).toEqual([]);
	});

	it("reports nothing when both sides are empty", async () => {
		const repo = await FakeRepo.create("t");
		expect(await diffTrees(repo, null, null)).toEqual([]);
	});

	it("reports an added file with its blob hash and mode", async () => {
		const { repo, changes } = await diff({ "a.txt": "a" }, { "a.txt": "a", "b.txt": "b" });
		expect(changes).toHaveLength(1);
		const [c] = changes;
		expect(c).toMatchObject({ op: "upsert", path: "b.txt", mode: "100644" });
		const blob = await repo.readBlob((c as Extract<Change, { op: "upsert" }>).hash);
		expect(await blob!.text()).toBe("b");
	});

	it("reports a modified file", async () => {
		const { changes } = await diff({ "a.txt": "a", "b.txt": "b" }, { "a.txt": "A", "b.txt": "b" });
		expect(summary(changes)).toEqual(["upsert a.txt"]);
	});

	it("reports a deleted file", async () => {
		const { changes } = await diff({ "a.txt": "a", "b.txt": "b" }, { "a.txt": "a" });
		expect(changes).toEqual([{ op: "delete", path: "b.txt" }]);
	});

	it("reports every file of an added or deleted directory", async () => {
		const added = await diff({ "a.txt": "a" }, { "a.txt": "a", "d/x": "x", "d/e/y": "y" });
		expect(summary(added.changes)).toEqual(["upsert d/e/y", "upsert d/x"]);
		const deleted = await diff({ "a.txt": "a", "d/x": "x", "d/e/y": "y" }, { "a.txt": "a" });
		expect(summary(deleted.changes)).toEqual(["delete d/e/y", "delete d/x"]);
	});

	it("descends only into changed subtrees and reports nested paths", async () => {
		const before = { "src/a/x.ts": "x", "src/a/y.ts": "y", "src/b/z.ts": "z", "docs/r.md": "r" };
		const { changes } = await diff(before, { ...before, "src/a/y.ts": "Y", "src/b/new.ts": "n" });
		expect(summary(changes)).toEqual(["upsert src/a/y.ts", "upsert src/b/new.ts"]);
	});

	it("handles a file replaced by a directory", async () => {
		const { changes } = await diff({ "a.txt": "a", p: "file" }, { "a.txt": "a", "p/inner.txt": "i" });
		expect(summary(changes)).toEqual(["delete p", "upsert p/inner.txt"]);
	});

	it("handles a directory replaced by a file", async () => {
		const { changes } = await diff({ "a.txt": "a", "p/inner.txt": "i", "p/q/deep": "d" }, { "a.txt": "a", p: "file" });
		expect(summary(changes)).toEqual(["upsert p", "delete p/inner.txt", "delete p/q/deep"]);
	});

	it("diffs against an empty tree", async () => {
		const repo = await FakeRepo.create("t");
		const tree = (await repo.readCommit(await repo.commit({ "a.txt": "a", "d/b": "b" })))!.treeHash;
		expect(summary(sorted(await diffTrees(repo, null, tree)))).toEqual(["upsert a.txt", "upsert d/b"]);
		expect(summary(sorted(await diffTrees(repo, tree, null)))).toEqual(["delete a.txt", "delete d/b"]);
	});

	it("throws on a missing tree", async () => {
		const repo = await FakeRepo.create("t");
		await expect(diffTrees(repo, null, "0".repeat(40))).rejects.toThrow(/tree not found/);
	});
});
