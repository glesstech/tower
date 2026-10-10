// An in-memory stand-in for the Artifacts binding, backed by isomorphic-git over MemoryFS.
// Artifacts has no local emulator, so unit and Durable Object tests run against this instead.
// Repos are written as whole snapshots (path -> contents) rather than through a working tree.

import git from "isomorphic-git";
import { MemoryFS } from "../src/memory-fs";

const DIR = "/repo";
const BRANCH = "main";
const AUTHOR = { name: "test", email: "test@tower.local", timestamp: 1_700_000_000, timezoneOffset: 0 };

export type Snapshot = Record<string, string>;

export function artifactsError(code: ArtifactsErrorCode, message: string = code): ArtifactsError {
	return Object.assign(new Error(message), { name: "ArtifactsError" as const, code, numericCode: 0 });
}

// Canonical Git modes as Artifacts reports them ("40000", not isomorphic-git's "040000").
function entryType(mode: string): ArtifactsTreeEntryType {
	if (mode === "40000") return "tree";
	if (mode === "100755") return "exec";
	if (mode === "120000") return "symlink";
	if (mode === "160000") return "gitlink";
	return "blob";
}

export class FakeRepo implements ArtifactsRepo {
	readonly dir = DIR;
	fs = new MemoryFS();
	private tokens = 0;

	constructor(
		public name: string,
		private ns?: FakeArtifacts,
	) {}

	static async create(name: string, ns?: FakeArtifacts): Promise<FakeRepo> {
		const repo = new FakeRepo(name, ns);
		await git.init({ fs: repo.fs, dir: DIR, defaultBranch: BRANCH });
		return repo;
	}

	// Commit a full snapshot of the tree on top of the current head. Returns the commit hash.
	async commit(files: Snapshot, message = "change"): Promise<string> {
		const tree = await writeSnapshot(this.fs, DIR, files);
		const parent = await this.head();
		const oid = await git.writeCommit({
			fs: this.fs,
			dir: DIR,
			commit: { message: `${message}\n`, tree, parent: parent ? [parent] : [], author: AUTHOR, committer: AUTHOR },
		});
		await git.writeRef({ fs: this.fs, dir: DIR, ref: `refs/heads/${BRANCH}`, value: oid, force: true });
		return oid;
	}

	async head(): Promise<string | null> {
		return git.resolveRef({ fs: this.fs, dir: DIR, ref: `refs/heads/${BRANCH}` }).catch(() => null);
	}

	async createToken(scope: "write" | "read" = "write", ttl = 86400): Promise<ArtifactsCreateTokenResult> {
		this.ns?.hit("createToken");
		const id = `tok-${this.name}-${++this.tokens}`;
		const expires = Math.floor(Date.now() / 1000) + ttl;
		return { id, plaintext: `art_v1_${id}?expires=${expires}`, scope, expiresAt: new Date(expires * 1000).toISOString() };
	}

	async listTokens(): Promise<ArtifactsTokenListResult> {
		return { tokens: [], total: 0 };
	}

	async revokeToken(): Promise<boolean> {
		return true;
	}

	async info(): Promise<ArtifactsRepoInfo> {
		const now = new Date(0).toISOString();
		return {
			id: this.name,
			name: this.name,
			description: null,
			defaultBranch: BRANCH,
			createdAt: now,
			updatedAt: now,
			lastPushAt: null,
			source: null,
			readOnly: false,
			remote: `https://artifacts.test/git/${this.name}.git`,
		};
	}

	async readBlob(hash: string): Promise<Blob | null> {
		try {
			const { blob } = await git.readBlob({ fs: this.fs, dir: DIR, oid: hash });
			return new Blob([blob]);
		} catch {
			return null;
		}
	}

	async readTree(hash: string): Promise<ArtifactsTreeEntry[] | null> {
		try {
			const { tree } = await git.readTree({ fs: this.fs, dir: DIR, oid: hash });
			return tree.map((e) => {
				const mode = e.mode.replace(/^0+/, "");
				return { name: e.path, mode, hash: e.oid, type: entryType(mode) };
			});
		} catch {
			return null;
		}
	}

	async readCommit(hash: string): Promise<ArtifactsCommitMetadata | null> {
		try {
			const { oid, commit } = await git.readCommit({ fs: this.fs, dir: DIR, oid: hash });
			return toMetadata(oid, commit);
		} catch {
			return null;
		}
	}

	async readFile(): Promise<Blob | null> {
		throw new Error("FakeRepo.readFile is not implemented");
	}

	async log(opts: { ref?: string; limit?: number } = {}): Promise<ArtifactsCommitMetadata[]> {
		this.ns?.hit("log");
		if (!(await this.head())) return [];
		const commits = await git.log({ fs: this.fs, dir: DIR, ref: opts.ref ?? BRANCH, depth: opts.limit ?? 50 });
		return commits.map((c) => toMetadata(c.oid, c.commit));
	}

	async fork(name: string, opts?: { description?: string }): Promise<ArtifactsCreateRepoResult> {
		if (!this.ns) throw new Error("fork needs a namespace");
		return this.ns.fork(this, name, opts?.description);
	}

	// A copy that shares no mutable state with this repo.
	clone(name: string, ns?: FakeArtifacts): FakeRepo {
		const copy = new FakeRepo(name, ns);
		copy.fs.entries = new Map(
			[...this.fs.entries].map(([path, e]) => [path, e.kind === "dir" ? { ...e, children: new Set(e.children) } : { ...e }]),
		);
		return copy;
	}

	[Symbol.dispose]() {}
}

type Fault = { code: ArtifactsErrorCode; after: boolean };

// The namespace-level binding. `failNext` queues faults per method so tests can script
// transient errors (FORK_IN_PROGRESS), races (ALREADY_EXISTS) and hard failures.
export class FakeArtifacts implements Artifacts {
	repos = new Map<string, FakeRepo>();
	calls: Record<string, number> = {};
	private faults: Record<string, Fault[]> = {};

	failNext(method: string, code: ArtifactsErrorCode, opts: { after?: boolean; times?: number } = {}) {
		for (let i = 0; i < (opts.times ?? 1); i++) (this.faults[method] ??= []).push({ code, after: !!opts.after });
	}

	hit(method: string): Fault | undefined {
		this.calls[method] = (this.calls[method] ?? 0) + 1;
		const fault = this.faults[method]?.shift();
		if (fault && !fault.after) throw artifactsError(fault.code);
		return fault;
	}

	// Seed a repo directly, e.g. a trunk with an initial commit.
	async seed(name: string, files?: Snapshot): Promise<FakeRepo> {
		const repo = await FakeRepo.create(name, this);
		if (files) await repo.commit(files, "seed");
		this.repos.set(name, repo);
		return repo;
	}

	async create(name: string): Promise<ArtifactsCreateRepoResult> {
		this.hit("create");
		if (this.repos.has(name)) throw artifactsError("ALREADY_EXISTS");
		return this.result(await this.seed(name));
	}

	async get(name: string): Promise<ArtifactsRepo> {
		this.hit("get");
		const repo = this.repos.get(name);
		if (!repo) throw artifactsError("NOT_FOUND", `repo ${name} not found`);
		return repo;
	}

	async import(): Promise<ArtifactsCreateRepoResult> {
		throw new Error("FakeArtifacts.import is not implemented");
	}

	// Paged like Artifacts: `limit` (default 50, at most 200) repos per page, and a cursor
	// while more remain.
	async list(opts: { limit?: number; cursor?: string } = {}): Promise<ArtifactsRepoListResult> {
		this.hit("list");
		const limit = Math.min(opts.limit ?? 50, 200);
		const start = Number(opts.cursor ?? 0);
		const all = [...this.repos.values()];
		const repos = await Promise.all(all.slice(start, start + limit).map(async (r) => {
			const { remote: _, ...info } = await r.info();
			return info;
		}));
		const next = start + limit;
		return { repos, total: all.length, ...(next < all.length ? { cursor: String(next) } : {}) };
	}

	async delete(name: string): Promise<boolean> {
		this.hit("delete");
		return this.repos.delete(name);
	}

	async fork(source: FakeRepo, name: string, description?: string): Promise<ArtifactsCreateRepoResult> {
		const fault = this.hit("fork");
		if (this.repos.has(name)) throw artifactsError("ALREADY_EXISTS");
		const copy = source.clone(name, this);
		this.repos.set(name, copy);
		// An "after" fault models a fork that was created but whose response never arrived.
		if (fault) throw artifactsError(fault.code);
		void description;
		return this.result(copy);
	}

	private async result(repo: FakeRepo): Promise<ArtifactsCreateRepoResult> {
		const info = await repo.info();
		const token = await repo.createToken();
		return { id: info.id, name: info.name, description: null, defaultBranch: BRANCH, remote: info.remote, token: token.plaintext };
	}
}

// Write a snapshot's blobs and trees into `fs` and return the root tree hash.
export async function writeSnapshot(fs: MemoryFS, dir: string, files: Snapshot): Promise<string> {
	type Node = Map<string, Node | string>;
	const root: Node = new Map();
	for (const [path, contents] of Object.entries(files)) {
		const parts = path.split("/");
		let node = root;
		for (const part of parts.slice(0, -1)) {
			let next = node.get(part);
			if (typeof next !== "object") node.set(part, (next = new Map()));
			node = next;
		}
		node.set(parts[parts.length - 1], contents);
	}

	const encoder = new TextEncoder();
	const write = async (node: Node): Promise<string> => {
		const tree = [];
		for (const [name, child] of node) {
			if (typeof child === "string") {
				const oid = await git.writeBlob({ fs, dir, blob: encoder.encode(child) });
				tree.push({ mode: "100644", path: name, oid, type: "blob" as const });
			} else {
				tree.push({ mode: "040000", path: name, oid: await write(child), type: "tree" as const });
			}
		}
		return git.writeTree({ fs, dir, tree });
	};
	return write(root);
}

function toMetadata(oid: string, commit: Awaited<ReturnType<typeof git.readCommit>>["commit"]): ArtifactsCommitMetadata {
	return {
		hash: oid,
		treeHash: commit.tree,
		message: commit.message.replace(/\n$/, ""),
		author: { name: commit.author.name, email: commit.author.email },
		committer: { name: commit.committer.name, email: commit.committer.email },
		parents: commit.parent,
		authoredAt: commit.author.timestamp,
		committedAt: commit.committer.timestamp,
	};
}
