// The trunk repo itself: creating it, read tokens for operators, teardown, and the file tree.

import { branch, type Core, deleteRepo, repo, serial, setMeta } from "./core";
import { reset } from "./events";
import { schema } from "./schema";

const TREE_LIMIT = 5000;

export async function init(t: Core, importUrl?: string) {
	const name = repo(t);
	const created = importUrl
		? await t.env.ARTIFACTS.import({ source: { url: importUrl }, target: { name } })
		: await t.env.ARTIFACTS.create(name, { setDefaultBranch: "main" });
	// An imported repo keeps its own default branch (often "master"); every clone, push and
	// fork base follows it. An import still in progress can't answer info() yet, so fall back
	// to what the create/import call reported.
	let br = created.defaultBranch;
	try {
		using trunk = await t.env.ARTIFACTS.get(name);
		br = (await trunk.info()).defaultBranch;
	} catch (err) {
		const code = (err as ArtifactsError).code;
		if (code !== "IMPORT_IN_PROGRESS" && code !== "CREATE_IN_PROGRESS") throw err;
	}
	setMeta(t, "branch", br);
	t.workspace = null;
	// The initial token lets an operator seed trunk; agents never get trunk write access.
	return { name: created.name, remote: created.remote, token: created.token, branch: br };
}

// A short-lived, read-only trunk token, so an operator can fetch landed work (e.g. into a PR).
export async function readToken(t: Core) {
	using trunk = await t.env.ARTIFACTS.get(repo(t));
	const [info, token] = await Promise.all([trunk.info(), trunk.createToken("read", 600)]);
	return { remote: info.remote, token: token.plaintext, expiresAt: token.expiresAt };
}

// Tear down a trunk completely: every fork, the trunk repo, and this Tower's own state.
export async function destroy(t: Core) {
	return serial(t, async () => {
		const forks = t.sql
			.exec<{ fork: string }>("SELECT fork FROM plans WHERE fork IS NOT NULL")
			.toArray()
			.map((r) => r.fork);
		const repos = [...forks, repo(t)];
		const deleted = (await Promise.all(repos.map((name) => deleteRepo(t, name)))).filter(Boolean).length;
		reset(t);
		await t.ctx.storage.deleteAll();
		t.workspace = null;
		schema(t.sql);
		return { deleted };
	});
}

// Every file path on trunk HEAD, for the dashboard's codebase map. Walking the tree costs
// one readTree per directory, so the result is cached until trunk HEAD moves.
export async function tree(t: Core) {
	const br = await branch(t);
	using trunk = await t.env.ARTIFACTS.get(repo(t));
	const [head] = await trunk.log({ ref: br, limit: 1 });
	if (!head) return { head: null, paths: [], truncated: false };
	if (t.treeCache?.head !== head.hash) {
		const tree = walk(t, head.hash).catch((err) => {
			t.treeCache = null;
			throw err;
		});
		t.treeCache = { head: head.hash, tree };
	}
	return t.treeCache.tree;
}

async function walk(t: Core, sha: string) {
	using trunk = await t.env.ARTIFACTS.get(repo(t));
	const commit = await trunk.readCommit(sha);
	const paths: string[] = [];
	const dirs: [string, string][] = [["", commit!.treeHash]];
	while (dirs.length && paths.length < TREE_LIMIT) {
		const [prefix, hash] = dirs.shift()!;
		for (const e of (await trunk.readTree(hash)) ?? []) {
			if (e.type === "tree") dirs.push([`${prefix}${e.name}/`, e.hash]);
			else paths.push(prefix + e.name);
		}
	}
	const truncated = dirs.length > 0 || paths.length > TREE_LIMIT;
	return { head: sha, paths: paths.slice(0, TREE_LIMIT).sort(), truncated };
}
