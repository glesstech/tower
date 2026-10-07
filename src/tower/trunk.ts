// The trunk repo itself: creating it, read tokens for operators, teardown, the file tree, and
// file contents.

import type { Change } from "../treediff";
import { branch, type Core, deleteRepo, repo, serial, setMeta } from "./core";
import { reset } from "./events";
import { schema } from "./schema";

const TREE_LIMIT = 5000;
const BLOB_LIMIT = 1024 * 1024;

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
	// The tower is trunk's only writer: when its workspace left HEAD where the cache is, the
	// cache is current without asking Artifacts.
	const cached = t.treeCache;
	if (cached && t.workspace?.branch === br && t.workspace.current === cached.head) return cached.tree;
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

// One file's contents on trunk HEAD, for the code explorer. The path is resolved one tree at a
// time from HEAD's root; a missing path or a directory is null (404). Binary files (a NUL in
// the first 8 KB) and files over BLOB_LIMIT come back without text.
export async function blob(t: Core, path: string) {
	const parts = path.split("/");
	if (!path || parts.some((p) => !p || p === "." || p === "..")) throw new Error("a repo-relative file path is required");
	const br = await branch(t);
	using trunk = await t.env.ARTIFACTS.get(repo(t));
	const [head] = await trunk.log({ ref: br, limit: 1 });
	if (!head) return null;
	let hash = (await trunk.readCommit(head.hash))!.treeHash;
	for (const [i, name] of parts.entries()) {
		const entry = (await trunk.readTree(hash))?.find((e) => e.name === name);
		const last = i === parts.length - 1;
		if (!entry || entry.type !== (last ? "blob" : "tree")) return null;
		hash = entry.hash;
	}
	const data = await trunk.readBlob(hash);
	if (!data) return null;
	const size = data.size;
	const bytes = new Uint8Array(await data.slice(0, BLOB_LIMIT).arrayBuffer());
	const binary = bytes.subarray(0, 8192).includes(0);
	const text = binary || size > BLOB_LIMIT ? null : new TextDecoder().decode(bytes);
	return { head: head.hash, path, hash, size, binary, text };
}

// Carry the cached file list over a land from `parent` to `sha`, so the next claim measure or
// map load needn't walk trunk again.
export function advanceTree(t: Core, parent: string, sha: string, changed: Change[]) {
	const prev = t.treeCache;
	if (prev?.head !== parent) {
		t.treeCache = null;
		return;
	}
	const tree = prev.tree.then(({ paths, truncated }) => {
		const files = new Set(paths);
		for (const c of changed) {
			if (c.op === "upsert") files.add(c.path);
			else files.delete(c.path);
		}
		const sorted = [...files].sort();
		return { head: sha, paths: sorted.slice(0, TREE_LIMIT), truncated: truncated || sorted.length > TREE_LIMIT };
	});
	tree.catch(() => {
		if (t.treeCache?.tree === tree) t.treeCache = null;
	});
	t.treeCache = { head: sha, tree };
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
