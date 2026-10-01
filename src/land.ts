// Landing composes a new trunk commit: trunk HEAD's tree with one lease's changes overlaid.
// Leases guarantee no two in-flight agents touch the same paths, so this overlay never
// has a textual merge conflict by construction. The Artifacts binding can read objects
// but not write them, so the commit is built and pushed with isomorphic-git in memory.

import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { MemoryFS } from "./memory-fs";
import type { Change } from "./treediff";

const DIR = "/trunk";
const BRANCH = "main";

type TreeEntry = { mode: string; path: string; oid: string; type: "blob" | "tree" | "commit" };
type Nested = { rest: string; change: Change };

export type Author = { name: string; email: string };

// The tower is the only writer to trunk, so a workspace kept in memory between lands stays
// current; it is rebuilt whenever the Durable Object is evicted or trunk moved unexpectedly.
export class TrunkWorkspace {
	private fs: MemoryFS | null = null;
	private head: string | null = null;

	constructor(private remote: string) {}

	async land(opts: {
		token: string;
		trunkHead: string;
		fork: ArtifactsRepo;
		changes: Change[];
		message: string;
		author: Author;
	}): Promise<string> {
		const fs = await this.checkout(opts.token, opts.trunkHead);
		const onAuth = () => ({ username: "x", password: secret(opts.token) });

		for (const c of opts.changes) {
			if (c.op !== "upsert") continue;
			if (c.mode === "160000") throw new Error(`submodules are not supported: ${c.path}`);
			const blob = await opts.fork.readBlob(c.hash);
			if (!blob) throw new Error(`blob missing in fork: ${c.path}`);
			const oid = await git.writeBlob({ fs, dir: DIR, blob: new Uint8Array(await blob.arrayBuffer()) });
			if (oid !== c.hash) throw new Error(`blob hash mismatch for ${c.path}`);
		}

		const { commit } = await git.readCommit({ fs, dir: DIR, oid: opts.trunkHead });
		const tree = await rewriteTree(
			fs,
			commit.tree,
			opts.changes.map((change) => ({ rest: change.path, change })),
		);
		const now = Math.floor(Date.now() / 1000);
		const sig = { ...opts.author, timestamp: now, timezoneOffset: 0 };
		const oid = await git.writeCommit({
			fs,
			dir: DIR,
			commit: {
				message: opts.message,
				tree: tree ?? (await git.writeTree({ fs, dir: DIR, tree: [] })),
				parent: [opts.trunkHead],
				author: sig,
				committer: { name: "tower", email: "tower@tower.local", timestamp: now, timezoneOffset: 0 },
			},
		});

		await git.writeRef({ fs, dir: DIR, ref: `refs/heads/${BRANCH}`, value: oid, force: true });
		try {
			const res = await git.push({ fs, http, dir: DIR, url: this.remote, ref: BRANCH, onAuth });
			if (!res.ok) throw new Error(res.error ?? "push rejected");
		} catch (err) {
			this.fs = null; // local state no longer matches trunk; rebuild next time
			throw err;
		}
		this.head = oid;
		return oid;
	}

	private async checkout(token: string, trunkHead: string): Promise<MemoryFS> {
		if (this.fs && this.head === trunkHead) return this.fs;
		const fs = new MemoryFS();
		await git.clone({
			fs,
			http,
			dir: DIR,
			url: this.remote,
			ref: BRANCH,
			singleBranch: true,
			depth: 1,
			noCheckout: true,
			noTags: true,
			onAuth: () => ({ username: "x", password: secret(token) }),
		});
		const head = await git.resolveRef({ fs, dir: DIR, ref: `refs/heads/${BRANCH}` });
		if (head !== trunkHead) throw new Error(`trunk moved during land: ${head} != ${trunkHead}`);
		this.fs = fs;
		this.head = head;
		return fs;
	}
}

export async function rewriteTree(fs: MemoryFS, oid: string | null, changes: Nested[]): Promise<string | null> {
	const entries = new Map<string, TreeEntry>();
	if (oid) for (const e of (await git.readTree({ fs, dir: DIR, oid })).tree) entries.set(e.path, e);

	const nested = new Map<string, Nested[]>();
	for (const { rest, change } of changes) {
		const slash = rest.indexOf("/");
		if (slash >= 0) {
			const seg = rest.slice(0, slash);
			nested.set(seg, [...(nested.get(seg) ?? []), { rest: rest.slice(slash + 1), change }]);
		} else if (change.op === "upsert") {
			entries.set(rest, { mode: change.mode, path: rest, oid: change.hash, type: "blob" });
		} else {
			entries.delete(rest);
		}
	}

	for (const [seg, sub] of nested) {
		const existing = entries.get(seg);
		const subOid = await rewriteTree(fs, existing?.type === "tree" ? existing.oid : null, sub);
		if (subOid) entries.set(seg, { mode: "040000", path: seg, oid: subOid, type: "tree" });
		else if (existing?.type === "tree") entries.delete(seg); // a directory replaced by a file keeps the file
	}

	if (entries.size === 0) return null;
	return git.writeTree({ fs, dir: DIR, tree: [...entries.values()] });
}

// Tokens look like art_v1_<secret>?expires=<unix>; Basic auth wants only the secret.
export function secret(token: string): string {
	return token.split("?expires=")[0];
}
