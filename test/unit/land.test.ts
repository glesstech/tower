import git from "isomorphic-git";
import { describe, expect, it } from "vitest";
import { rewriteTree, secret } from "../../src/land";
import { MemoryFS } from "../../src/memory-fs";
import { diffTrees } from "../../src/treediff";
import { FakeRepo, type Snapshot, writeSnapshot } from "../fake-artifacts";
import { fsck, readSnapshot } from "./git-helpers";

const DIR = "/trunk"; // rewriteTree works on the TrunkWorkspace's repo at /trunk
const SIG = { name: "t", email: "t@tower.local", timestamp: 1_700_000_000, timezoneOffset: 0 };

// Simulate a land: an agent forks at `base` and commits `fork`, while trunk has moved on to
// `trunk`. The lease's changes (base -> fork) are overlaid onto trunk's tree, exactly as
// TrunkWorkspace.land does after copying the fork's blobs into the trunk workspace.
async function overlay(base: Snapshot, trunk: Snapshot, fork: Snapshot) {
	const agent = await FakeRepo.create("fork");
	const baseTree = (await agent.readCommit(await agent.commit(base)))!.treeHash;
	const forkTree = (await agent.readCommit(await agent.commit(fork)))!.treeHash;
	const changes = await diffTrees(agent, baseTree, forkTree);

	const fs = new MemoryFS();
	await git.init({ fs, dir: DIR, defaultBranch: "main" });
	const trunkTree = await writeSnapshot(fs, DIR, trunk);
	const trunkHead = await git.writeCommit({ fs, dir: DIR, commit: { message: "trunk\n", tree: trunkTree, parent: [], author: SIG, committer: SIG } });
	await writeSnapshot(fs, DIR, fork); // the fork's blobs, as land() writes them before rewriting

	const tree = await rewriteTree(fs, trunkTree, changes.map((change) => ({ rest: change.path, change })));
	const commit = await git.writeCommit({
		fs,
		dir: DIR,
		commit: { message: "land\n", tree: tree ?? (await git.writeTree({ fs, dir: DIR, tree: [] })), parent: [trunkHead], author: SIG, committer: SIG },
	});
	await git.writeRef({ fs, dir: DIR, ref: "refs/heads/main", value: commit, force: true });
	return { fs, tree, result: await readSnapshot(fs, DIR, tree) };
}

describe("rewriteTree", () => {
	it("overlays a lease onto an advanced trunk and keeps trunk's own changes", async () => {
		const base = { "README.md": "readme", "src/a.ts": "a", "src/b.ts": "b", "src/gone.ts": "g", "lib/x.ts": "x" };
		// Meanwhile other agents landed: b modified, a new docs file, lib/x deleted.
		const trunk = { "README.md": "readme", "src/a.ts": "a", "src/b.ts": "b2", "src/gone.ts": "g", "docs/n.md": "n" };
		// This agent's lease: modify a, add src/new/c.ts, delete gone.
		const fork = { "README.md": "readme", "src/a.ts": "a2", "src/b.ts": "b", "src/new/c.ts": "c", "lib/x.ts": "x" };

		const { fs, result } = await overlay(base, trunk, fork);
		expect(result).toEqual({
			"README.md": "readme",
			"src/a.ts": "a2",
			"src/b.ts": "b2",
			"src/new/c.ts": "c",
			"docs/n.md": "n",
		});
		await expect(fsck(fs, DIR)).resolves.toBeDefined();
	});

	it("replaces a file with a directory", async () => {
		const base = { "a.txt": "a", p: "file" };
		const { fs, result } = await overlay(base, { ...base, "t.txt": "t" }, { "a.txt": "a", "p/inner.txt": "i" });
		expect(result).toEqual({ "a.txt": "a", "t.txt": "t", "p/inner.txt": "i" });
		await expect(fsck(fs, DIR)).resolves.toBeDefined();
	});

	it("replaces a directory with a file", async () => {
		const base = { "a.txt": "a", "p/inner.txt": "i", "p/q/deep.txt": "d" };
		const { fs, result } = await overlay(base, { ...base, "t.txt": "t" }, { "a.txt": "a", p: "file" });
		expect(result).toEqual({ "a.txt": "a", "t.txt": "t", p: "file" });
		await expect(fsck(fs, DIR)).resolves.toBeDefined();
	});

	it("removes directories the lease emptied", async () => {
		const base = { "a.txt": "a", "x/y/z.txt": "z", "x/keep/k.txt": "k" };
		const fork = { "a.txt": "a", "x/keep/k.txt": "k" };
		const { fs, result } = await overlay(base, base, fork);
		expect(result).toEqual({ "a.txt": "a", "x/keep/k.txt": "k" });
		await expect(fsck(fs, DIR)).resolves.toBeDefined();
	});

	it("keeps a directory trunk added to while the lease emptied it", async () => {
		const base = { "a.txt": "a", "d/mine.txt": "m" };
		const { fs, result } = await overlay(base, { ...base, "d/theirs.txt": "t" }, { "a.txt": "a" });
		expect(result).toEqual({ "a.txt": "a", "d/theirs.txt": "t" });
		await expect(fsck(fs, DIR)).resolves.toBeDefined();
	});

	it("returns null when the lease deletes everything", async () => {
		const base = { "a.txt": "a", "d/b.txt": "b" };
		const { fs, tree } = await overlay(base, base, {});
		expect(tree).toBeNull();
		await expect(fsck(fs, DIR)).resolves.toBeDefined();
	});
});

describe("secret", () => {
	it("strips the expiry from a token", () => {
		expect(secret("art_v1_abc?expires=123")).toBe("art_v1_abc");
		expect(secret("art_v1_abc")).toBe("art_v1_abc");
	});
});
