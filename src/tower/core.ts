// What every Tower module shares: the plan types, the Durable Object state they act on, and
// small helpers for meta, trunk lookup and cleanup.

import type { Claim } from "../claims";
import type { Author, TrunkWorkspace } from "../land";
import type { Risk } from "../risk";

export type Status = "holding" | "cleared" | "landed" | "released" | "expired";

export type Amendment = { claims: Claim[]; blockedBy: string[]; requestedAt: number };

// A land waiting in the human inbox: the fork head that was scored, and the land request to
// replay if a human approves it (see review.ts).
export type Review = {
	head: string;
	summary?: string;
	evidence?: unknown;
	author?: Author;
	risk: Risk;
	paths: string[];
	requestedAt: number;
};

export type Plan = {
	id: string;
	agent: string;
	task: string;
	claims: Claim[];
	status: Status;
	blockedBy: string[];
	amendment: Amendment | null;
	review: Review | null;
	fork: string | null;
	base: string | null;
	createdAt: number;
	lastSeenAt: number;
	ttl: number;
};

export type PlanRow = {
	id: string;
	agent: string;
	task: string;
	claims: string;
	status: Status;
	blocked_by: string;
	amendment: string | null;
	review: string | null;
	fork: string | null;
	base: string | null;
	created_at: number;
	last_seen_at: number | null;
	ttl: number | null;
};

export type Tree = { head: string; paths: string[]; truncated: boolean };

// The Tower instance as its modules see it. Fields are read live from the instance, so
// anything that swaps env or workspace after construction (as the DO tests do) takes effect.
export interface Core {
	readonly ctx: DurableObjectState<{}>;
	readonly env: Env;
	readonly sql: SqlStorage;
	queue: Promise<unknown>;
	workspace: TrunkWorkspace | null;
	provisioning: Map<string, Promise<void>>;
	treeCache: { head: string; tree: Promise<Tree> } | null;
	// Relative import specifiers per source blob hash, for blast radius (see review.ts).
	importSpecs: Map<string, string[]>;
	// Trunk HEAD's blob paths and hashes. The tower is trunk's only writer, so each land moves
	// it forward without re-walking trunk (see landing.ts and review.ts).
	trunkFiles: { head: string; files: Map<string, string> } | null;
	// Blob contents by hash: fork blobs read before a land takes the lock, and what scoring read.
	blobs: BlobCache;
	// A trunk write token reused across lands until it nears expiry; it never leaves the tower.
	trunkToken: { id: string; plaintext: string; expiresAt: number } | null;
	// Cleanup started inside the serial queue but not worth holding it for (see later()).
	pending: Set<Promise<unknown>>;
}

// Run cleanup (deleting a closed plan's fork) without holding the serial queue for it. The
// router awaits it before the request that started it ends (see settle()), so it isn't cut off.
export function later(t: Core, work: Promise<unknown>) {
	const p = work.catch((err) => console.error("cleanup:", err)).finally(() => t.pending.delete(p));
	t.pending.add(p);
}

export async function settle(t: Core) {
	while (t.pending.size) await Promise.all([...t.pending]);
}

// Blob bytes by hash, bounded by total size; it is emptied when full rather than evicting
// one by one, which is plenty for a cache that only has to bridge one land's two phases.
export class BlobCache {
	private map = new Map<string, Uint8Array>();
	private bytes = 0;
	constructor(private limit = 32 * 1024 * 1024) {}

	get(hash: string): Uint8Array | undefined {
		return this.map.get(hash);
	}

	set(hash: string, data: Uint8Array) {
		if (this.map.has(hash) || data.byteLength > this.limit) return;
		if (this.bytes + data.byteLength > this.limit) this.clear();
		this.map.set(hash, data);
		this.bytes += data.byteLength;
	}

	clear() {
		this.map.clear();
		this.bytes = 0;
	}

	// A blob from the cache, else read from `repo` and cached. Null if the repo doesn't have it.
	async read(repo: Pick<ArtifactsRepo, "readBlob">, hash: string): Promise<Uint8Array | null> {
		const hit = this.get(hash);
		if (hit) return hit;
		const blob = await repo.readBlob(hash);
		if (!blob) return null;
		const data = new Uint8Array(await blob.arrayBuffer());
		this.set(hash, data);
		return data;
	}
}

// Every call the tower makes into the Artifacts binding, and into the repo handles it returns,
// counted in stats as artifacts_calls: an upper bound on the operations Artifacts bills. Counted
// straight into the stats table (no event), so it costs the live feed nothing.
const METERED = new WeakSet<object>();
const UNCOUNTED = new Set(["then", "constructor", "toString", "toJSON", "valueOf"]);

export function meter(t: Core) {
	const raw = t.env.ARTIFACTS;
	if (!raw || METERED.has(raw)) return;
	(t as { env: Env }).env = { ...t.env, ARTIFACTS: metered(t, raw) };
}

function metered<T extends object>(t: Core, target: T): T {
	const proxy = new Proxy(target, {
		get(obj, prop) {
			const value = Reflect.get(obj, prop);
			if (typeof value !== "function") return value;
			// Reflect, not value.apply/bind: on an RPC stub those would be remote method names.
			if (typeof prop !== "string" || UNCOUNTED.has(prop)) return (...args: unknown[]) => Reflect.apply(value, obj, args);
			return (...args: unknown[]) => {
				t.sql.exec("INSERT INTO stats (key, value) VALUES ('artifacts_calls', 1) ON CONFLICT (key) DO UPDATE SET value = value + 1");
				const out = Reflect.apply(value, obj, args);
				// The repo handles get() returns are counted too.
				return prop === "get" ? Promise.resolve(out).then((r) => (r && typeof r === "object" ? metered(t, r) : r)) : out;
			};
		},
	});
	METERED.add(proxy);
	return proxy;
}

export const ACTIVE = "('holding', 'cleared')";

// Seconds a cleared plan may go without an agent call before its lease expires (see leases.ts):
// the default, and the range a plan may ask for when it is filed.
export const LEASE_TTL = 15 * 60;
export const LEASE_TTL_MIN = 60;
export const LEASE_TTL_MAX = 60 * 60;

export function leaseTtl(ttl: unknown): number {
	if (ttl === undefined || ttl === null) return LEASE_TTL;
	const n = Number(ttl);
	if (!Number.isFinite(n)) throw new Error("ttl must be a number of seconds");
	return Math.min(Math.max(Math.round(n), LEASE_TTL_MIN), LEASE_TTL_MAX);
}

// Trunk writes and releases run one at a time; Durable Object input gates
// open across awaited I/O, so this is what keeps two lands from racing on trunk.
export function serial<T>(t: Core, fn: () => Promise<T>): Promise<T> {
	const run = t.queue.then(fn, fn);
	t.queue = run.catch(() => {});
	return run;
}

// Trunk HEAD as the tower last left it, if it holds a workspace; else read from trunk.
export async function trunkHead(t: Core, trunk: ArtifactsRepo, br: string): Promise<string | null> {
	const known = t.workspace?.branch === br ? t.workspace.current : null;
	if (known) return known;
	const [head] = await trunk.log({ ref: br, limit: 1 });
	return head?.hash ?? null;
}

export function plan(t: Core, id: string): Plan {
	const row = t.sql.exec<PlanRow>("SELECT * FROM plans WHERE id = ?", id).toArray()[0];
	if (!row) throw new Error(`unknown plan ${id}`);
	return toPlan(row);
}

export function toPlan(r: PlanRow): Plan {
	return {
		id: r.id,
		agent: r.agent,
		task: r.task,
		claims: JSON.parse(r.claims),
		status: r.status,
		blockedBy: JSON.parse(r.blocked_by),
		amendment: r.amendment ? JSON.parse(r.amendment) : null,
		review: r.review ? JSON.parse(r.review) : null,
		fork: r.fork,
		base: r.base,
		createdAt: r.created_at,
		// Plans filed before leases existed count from creation, with the default TTL.
		lastSeenAt: r.last_seen_at ?? r.created_at,
		ttl: r.ttl ?? LEASE_TTL,
	};
}

export function repo(t: Core): string {
	const repo = getMeta(t, "repo");
	if (!repo) throw new Error("tower has no repo");
	return repo;
}

export function getMeta(t: Core, key: string): string | null {
	return t.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = ?", key).toArray()[0]?.value ?? null;
}

export function setMeta(t: Core, key: string, value: string) {
	t.sql.exec("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", key, value);
}

// Trunk's branch, from meta; Towers initialized before it was recorded look it up once.
export async function branch(t: Core): Promise<string> {
	const cached = getMeta(t, "branch");
	if (cached) return cached;
	using trunk = await t.env.ARTIFACTS.get(repo(t));
	const { defaultBranch } = await trunk.info();
	setMeta(t, "branch", defaultBranch);
	return defaultBranch;
}

// Cleanup is best-effort: a failed delete must never fail the land or release around it. A
// fork it can't delete keeps its plan row, so teardown (see trunk.ts) tries it again.
export async function deleteRepo(t: Core, name: string): Promise<boolean> {
	try {
		return await removeRepo(t, name);
	} catch (err) {
		console.error(`delete ${name}:`, err);
		return false;
	}
}

// Delete a repo, retrying failures that may pass (load, upstream errors). True if this call
// deleted it, false if it was already gone; throws the last error if it couldn't be deleted.
export async function removeRepo(t: Core, name: string, attempts = 3): Promise<boolean> {
	for (let i = 1; ; i++) {
		try {
			return await t.env.ARTIFACTS.delete(name);
		} catch (err) {
			const code = (err as ArtifactsError).code;
			if (code === "NOT_FOUND") return false;
			if (i >= attempts || code === "INVALID_REPO_NAME") throw err;
			await new Promise((r) => setTimeout(r, 100 * i));
		}
	}
}

export function json(data: unknown, status = 200): Response {
	return Response.json(data, { status });
}

// A new fork is briefly unreadable (FORK_IN_PROGRESS) while Artifacts copies it, and a
// trunk that is already being forked rejects another fork with the same code.
export async function retry<T>(fn: () => Promise<T>, attempts = 10): Promise<T> {
	for (let i = 1; ; i++) {
		try {
			return await fn();
		} catch (err) {
			if (i >= attempts || (err as ArtifactsError).code !== "FORK_IN_PROGRESS") throw err;
			await new Promise((r) => setTimeout(r, 200 * i));
		}
	}
}
