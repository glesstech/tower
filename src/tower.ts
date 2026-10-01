// One Tower per trunk repo. It is the single source of truth for who holds which airspace,
// the only writer to trunk, and the keeper of why each landed change was made.
//
//   plan ──overlap?──▶ holding ──(blocker lands/releases)──▶ cleared ──▶ fork + scoped token
//                         │                                                │
//                         └──────────── no overlap ───────────────────────┘
//   cleared ──land──▶ diff fork vs base ──outside lease?──▶ 409 drift (stays cleared)
//                                        └─inside lease──▶ overlay onto trunk, push, landed

import { DurableObject } from "cloudflare:workers";
import { type Claim, claimsOverlap, covers, parseClaim } from "./claims";
import { type Author, TrunkWorkspace } from "./land";
import { type Change, diffTrees } from "./treediff";

type Status = "holding" | "cleared" | "landed" | "released";

type Plan = {
	id: string;
	agent: string;
	task: string;
	claims: Claim[];
	status: Status;
	blockedBy: string[];
	fork: string | null;
	base: string | null;
	createdAt: number;
};

type PlanRow = {
	id: string;
	agent: string;
	task: string;
	claims: string;
	status: Status;
	blocked_by: string;
	fork: string | null;
	base: string | null;
	created_at: number;
};

const ACTIVE = "('holding', 'cleared')";
const TOKEN_TTL = 3600;
const TREE_LIMIT = 5000;

export class Tower extends DurableObject<Env> {
	private sql = this.ctx.storage.sql;
	private queue: Promise<unknown> = Promise.resolve();
	private workspace: TrunkWorkspace | null = null;
	private provisioning = new Map<string, Promise<void>>();
	private treeCache: { head: string; tree: Promise<{ head: string; paths: string[]; truncated: boolean }> } | null = null;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.schema();
	}

	private schema() {
		this.sql.exec(`
			CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS plans (
				id TEXT PRIMARY KEY, agent TEXT NOT NULL, task TEXT NOT NULL, claims TEXT NOT NULL,
				status TEXT NOT NULL, blocked_by TEXT NOT NULL DEFAULT '[]',
				fork TEXT, base TEXT, created_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS plans_status ON plans (status, created_at);
			CREATE TABLE IF NOT EXISTS lands (
				sha TEXT PRIMARY KEY, plan_id TEXT NOT NULL, agent TEXT NOT NULL, task TEXT NOT NULL,
				summary TEXT NOT NULL, evidence TEXT NOT NULL, landed_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS land_paths (sha TEXT NOT NULL, path TEXT NOT NULL);
			CREATE INDEX IF NOT EXISTS land_paths_path ON land_paths (path);
			CREATE TABLE IF NOT EXISTS stats (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
		`);
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const repo = request.headers.get("X-Tower-Repo");
		if (repo) this.setMeta("repo", repo);
		const parts = url.pathname.split("/").filter(Boolean);
		const body = request.method === "POST" ? await request.json<any>().catch(() => ({})) : {};

		try {
			if (request.headers.get("Upgrade") === "websocket") return this.live();
			if (request.method === "POST" && parts[0] === "init") return json(await this.init(body.importUrl));
			if (request.method === "DELETE" && parts.length === 0) return json(await this.destroy());
			if (request.method === "POST" && parts[0] === "token") return json(await this.readToken());
			if (request.method === "GET" && parts[0] === "state") return json(this.state());
			if (request.method === "GET" && parts[0] === "tree") return json(await this.tree());
			if (request.method === "GET" && parts[0] === "why") return json(this.why(url.searchParams.get("path") ?? ""));
			if (parts[0] === "plans") {
				if (request.method === "POST" && parts.length === 1) return json(await this.file(body), 201);
				const id = parts[1];
				if (request.method === "GET" && parts.length === 2) return json(await this.status(id));
				if (request.method === "POST" && parts[2] === "check") return json(await this.check(id));
				if (request.method === "POST" && parts[2] === "amend") return json(this.amend(id, body.claims));
				if (request.method === "POST" && parts[2] === "land") return await this.land(id, body);
				if (request.method === "POST" && parts[2] === "release") return json(await this.release(id));
			}
			return json({ error: "not found" }, 404);
		} catch (err) {
			console.error(`${request.method} ${url.pathname}:`, err);
			return json({ error: (err as Error).message }, 400);
		}
	}

	// ── trunk ────────────────────────────────────────────────────────────────

	private async init(importUrl?: string) {
		const name = this.repo();
		const created = importUrl
			? await this.env.ARTIFACTS.import({ source: { url: importUrl }, target: { name } })
			: await this.env.ARTIFACTS.create(name, { setDefaultBranch: "main" });
		// An imported repo keeps its own default branch (often "master"); every clone, push and
		// fork base follows it. An import still in progress can't answer info() yet, so fall back
		// to what the create/import call reported.
		let branch = created.defaultBranch;
		try {
			using trunk = await this.env.ARTIFACTS.get(name);
			branch = (await trunk.info()).defaultBranch;
		} catch (err) {
			const code = (err as ArtifactsError).code;
			if (code !== "IMPORT_IN_PROGRESS" && code !== "CREATE_IN_PROGRESS") throw err;
		}
		this.setMeta("branch", branch);
		this.workspace = null;
		// The initial token lets an operator seed trunk; agents never get trunk write access.
		return { name: created.name, remote: created.remote, token: created.token, branch };
	}

	// Trunk's branch, from meta; Towers initialized before it was recorded look it up once.
	private async branch(): Promise<string> {
		const cached = this.getMeta("branch");
		if (cached) return cached;
		using trunk = await this.env.ARTIFACTS.get(this.repo());
		const { defaultBranch } = await trunk.info();
		this.setMeta("branch", defaultBranch);
		return defaultBranch;
	}

	// A short-lived, read-only trunk token, so an operator can fetch landed work (e.g. into a PR).
	private async readToken() {
		using trunk = await this.env.ARTIFACTS.get(this.repo());
		const [info, token] = await Promise.all([trunk.info(), trunk.createToken("read", 600)]);
		return { remote: info.remote, token: token.plaintext, expiresAt: token.expiresAt };
	}

	// Tear down a trunk completely: every fork, the trunk repo, and this Tower's own state.
	private async destroy() {
		return this.serial(async () => {
			const forks = this.sql
				.exec<{ fork: string }>("SELECT fork FROM plans WHERE fork IS NOT NULL")
				.toArray()
				.map((r) => r.fork);
			const repos = [...forks, this.repo()];
			const deleted = (await Promise.all(repos.map((name) => this.deleteRepo(name)))).filter(Boolean).length;
			this.broadcast({ type: "reset" });
			await this.ctx.storage.deleteAll();
			this.workspace = null;
			this.schema();
			return { deleted };
		});
	}

	// ── flight plans ─────────────────────────────────────────────────────────

	private async file(body: { agent?: string; task?: string; claims?: string[] }) {
		if (!body.agent || !body.task || !body.claims?.length) throw new Error("agent, task and claims are required");
		const claims = body.claims.map(parseClaim);
		const id = crypto.randomUUID().slice(0, 8);
		const blockedBy = this.blockers(claims, Date.now());
		const status: Status = blockedBy.length ? "holding" : "cleared";
		this.sql.exec(
			"INSERT INTO plans (id, agent, task, claims, status, blocked_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			id, body.agent, body.task, JSON.stringify(claims), status, JSON.stringify(blockedBy), Date.now(),
		);
		if (blockedBy.length) this.bump("conflicts_prevented");
		this.broadcast({ type: "plan", plan: this.plan(id) });
		return this.status(id);
	}

	// Active plans this claim set overlaps: every cleared plan, plus holding plans filed earlier
	// (so a later plan queues behind an earlier one rather than jumping it).
	private blockers(claims: Claim[], before: number, self?: string): string[] {
		const rows = this.sql
			.exec<PlanRow>(`SELECT * FROM plans WHERE status IN ${ACTIVE} ORDER BY created_at`)
			.toArray()
			.filter((r) => r.id !== self && (r.status === "cleared" || r.created_at < before));
		return rows
			.filter((r) => (JSON.parse(r.claims) as Claim[]).some((a) => claims.some((b) => claimsOverlap(a, b))))
			.map((r) => r.id);
	}

	// Cleared plans get a fork and a fresh fork-scoped write token on each poll. A failed
	// provision still returns the plan, so the agent keeps its id and the next poll retries.
	private async status(id: string) {
		const plan = this.plan(id);
		if (plan.status !== "cleared") return { plan };
		if (!plan.fork) {
			try {
				await this.provision(plan);
			} catch (err) {
				console.error(`provision ${id}:`, err);
				return { plan, error: (err as Error).message };
			}
		}
		using fork = await this.env.ARTIFACTS.get(this.plan(id).fork!);
		const [info, token, branch] = await Promise.all([fork.info(), fork.createToken("write", TOKEN_TTL), this.branch()]);
		return { plan: this.plan(id), fork: { name: info.name, remote: info.remote, token: token.plaintext, branch } };
	}

	// Provisioning doesn't wait behind lands: the base is read from the fork itself, so it is
	// exact whenever the fork happens. Concurrent polls for one plan share a single fork call.
	private provision(plan: Plan): Promise<void> {
		let pending = this.provisioning.get(plan.id);
		if (!pending) {
			pending = this.forkFor(plan).finally(() => this.provisioning.delete(plan.id));
			this.provisioning.set(plan.id, pending);
		}
		return pending;
	}

	private async forkFor(plan: Plan) {
		if (this.plan(plan.id).fork) return;
		const name = `${this.repo()}--${plan.id}`;
		const branch = await this.branch();
		using trunk = await this.env.ARTIFACTS.get(this.repo());
		try {
			await retry(() => trunk.fork(name, { description: `${plan.agent}: ${plan.task}` }));
		} catch (err) {
			// An earlier attempt may have created the fork before failing to record it.
			if ((err as ArtifactsError).code !== "ALREADY_EXISTS") throw err;
		}
		using fork = await retry(() => this.env.ARTIFACTS.get(name));
		const head = await retry(async () => {
			const [commit] = await fork.log({ ref: branch, limit: 1 });
			if (!commit) throw Object.assign(new Error(`fork ${name} has no commits yet`), { code: "FORK_IN_PROGRESS" });
			return commit;
		});
		this.sql.exec("UPDATE plans SET fork = ?, base = ? WHERE id = ?", name, head.hash, plan.id);
		// Released while the fork was being made: nobody will land it, so don't leave it behind.
		if (this.plan(plan.id).status !== "cleared") await this.deleteRepo(name);
		plan.fork = name;
		plan.base = head.hash;
		this.broadcast({ type: "plan", plan: this.plan(plan.id) });
	}

	// Extend an active plan's claims. An in-flight plan gets the new paths only if nobody else
	// holds them right now; otherwise nothing changes and the caller can retry once the
	// blockers land. (Queued amendments, with deadlock detection, are a later step.)
	private amend(id: string, raw?: string[]) {
		if (!raw?.length) throw new Error("claims are required");
		const plan = this.plan(id);
		if (plan.status !== "cleared" && plan.status !== "holding") throw new Error(`plan ${id} is ${plan.status}`);
		const claims = [...plan.claims];
		for (const c of raw.map(parseClaim)) if (!claims.some((x) => x.path === c.path)) claims.push(c);
		const blockedBy = this.blockers(claims, plan.createdAt, id);

		if (plan.status === "cleared" && blockedBy.length) return { granted: false, blockedBy, plan };
		const status: Status = blockedBy.length ? "holding" : "cleared";
		this.sql.exec(
			"UPDATE plans SET claims = ?, status = ?, blocked_by = ? WHERE id = ?",
			JSON.stringify(claims), status, JSON.stringify(blockedBy), id,
		);
		this.broadcast({ type: "plan", plan: this.plan(id) });
		return { granted: true, blockedBy, plan: this.plan(id) };
	}

	private async release(id: string) {
		return this.serial(async () => {
			const plan = this.plan(id);
			if (plan.status === "landed") throw new Error("plan already landed");
			await this.close(plan, "released");
			return { plan: this.plan(id) };
		});
	}

	// Free a plan's airspace and clear whichever holding plans no longer have blockers.
	private async close(plan: Plan, status: "landed" | "released") {
		this.sql.exec("UPDATE plans SET status = ? WHERE id = ?", status, plan.id);
		// A landed fork's changes now live on trunk (and the commit trailers keep its name),
		// so the fork and its tokens go away rather than accumulating storage.
		if (plan.fork) await this.deleteRepo(plan.fork);
		this.broadcast({ type: "plan", plan: this.plan(plan.id) });

		for (const row of this.sql.exec<PlanRow>("SELECT * FROM plans WHERE status = 'holding' ORDER BY created_at").toArray()) {
			const blockedBy = this.blockers(JSON.parse(row.claims), row.created_at, row.id);
			const next: Status = blockedBy.length ? "holding" : "cleared";
			this.sql.exec("UPDATE plans SET status = ?, blocked_by = ? WHERE id = ?", next, JSON.stringify(blockedBy), row.id);
			if (next === "cleared") this.broadcast({ type: "plan", plan: this.plan(row.id) });
		}
	}

	// ── drift + landing ──────────────────────────────────────────────────────

	private async changes(plan: Plan): Promise<{ head: string; changes: Change[]; drift: string[] }> {
		if (plan.status !== "cleared" || !plan.fork || !plan.base) throw new Error(`plan ${plan.id} is not in flight`);
		const branch = await this.branch();
		using fork = await this.env.ARTIFACTS.get(plan.fork);
		const [head] = await fork.log({ ref: branch, limit: 1 });
		if (!head) throw new Error(`fork ${plan.fork} has no commits on ${branch}`);
		const [before, after] = await Promise.all([fork.readCommit(plan.base), fork.readCommit(head.hash)]);
		const changes = await diffTrees(fork, before!.treeHash, after!.treeHash);
		const drift = changes.map((c) => c.path).filter((p) => !covers(plan.claims, p));
		return { head: head.hash, changes, drift };
	}

	private async check(id: string) {
		const { head, changes, drift } = await this.changes(this.plan(id));
		if (drift.length) this.broadcast({ type: "drift", planId: id, paths: drift });
		return { head, touched: changes.map((c) => c.path), drift };
	}

	private async land(id: string, body: { summary?: string; evidence?: unknown; author?: Author }) {
		return this.serial(async () => {
			const plan = this.plan(id);
			const { head, changes, drift } = await this.changes(plan);
			if (!changes.length) return json({ error: "nothing to land" }, 400);
			if (drift.length) {
				this.bump("drift_blocked");
				this.broadcast({ type: "drift", planId: id, paths: drift });
				return json({ error: "changes outside lease", drift, claims: plan.claims.map((c) => c.path) }, 409);
			}

			using fork = await this.env.ARTIFACTS.get(plan.fork!);
			const branch = await this.branch();
			using trunk = await this.env.ARTIFACTS.get(this.repo());
			const [[trunkHead], info, token, agentCommit] = await Promise.all([
				trunk.log({ ref: branch, limit: 1 }),
				trunk.info(),
				trunk.createToken("write", 300),
				fork.readCommit(head),
			]);
			if (this.workspace?.branch !== branch) this.workspace = new TrunkWorkspace(info.remote, branch);
			const summary = body.summary?.trim() || agentCommit!.message.split("\n")[0];
			const sha = await this.workspace.land({
				token: token.plaintext,
				trunkHead: trunkHead.hash,
				fork,
				changes,
				author: body.author ?? agentCommit!.author,
				message: `${summary}\n\nTower-Plan: ${plan.id}\nTower-Agent: ${plan.agent}\nTower-Fork: ${plan.fork}@${head}\n`,
			});
			await trunk.revokeToken(token.id);

			this.sql.exec(
				"INSERT INTO lands (sha, plan_id, agent, task, summary, evidence, landed_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
				sha, plan.id, plan.agent, plan.task, summary, JSON.stringify(body.evidence ?? null), Date.now(),
			);
			for (const c of changes) this.sql.exec("INSERT INTO land_paths (sha, path) VALUES (?, ?)", sha, c.path);
			this.bump("landed");
			await this.close(plan, "landed");
			this.broadcast({ type: "land", sha, planId: plan.id, agent: plan.agent, summary, paths: changes.map((c) => c.path) });
			return json({ sha, paths: changes.map((c) => c.path) });
		});
	}

	// ── memory: why does this path look the way it does? ─────────────────────

	private why(path: string) {
		if (!path) throw new Error("path is required");
		return this.sql
			.exec<{ sha: string; plan_id: string; agent: string; task: string; summary: string; evidence: string; landed_at: number }>(
				`SELECT DISTINCT l.* FROM lands l JOIN land_paths p ON p.sha = l.sha
				 WHERE p.path = ? OR p.path LIKE ? ORDER BY l.landed_at DESC LIMIT 20`,
				path, `${path.replace(/\/?$/, "/")}%`,
			)
			.toArray()
			.map((r) => ({ ...r, evidence: JSON.parse(r.evidence) }));
	}

	// ── dashboard ────────────────────────────────────────────────────────────

	private state() {
		const plans = this.sql
			.exec<PlanRow>(`SELECT * FROM plans WHERE status IN ${ACTIVE} ORDER BY created_at`)
			.toArray()
			.map(toPlan);
		const lands = this.sql
			.exec<{ sha: string; evidence: string }>("SELECT sha, plan_id, agent, task, summary, evidence, landed_at FROM lands ORDER BY landed_at DESC LIMIT 50")
			.toArray()
			.map((r) => ({ ...r, evidence: JSON.parse(r.evidence), paths: this.landPaths(r.sha) }));
		const stats = Object.fromEntries(this.sql.exec<{ key: string; value: number }>("SELECT * FROM stats").toArray().map((r) => [r.key, r.value]));
		return { repo: this.getMeta("repo"), plans, lands, stats };
	}

	private landPaths(sha: string): string[] {
		return this.sql.exec<{ path: string }>("SELECT path FROM land_paths WHERE sha = ?", sha).toArray().map((r) => r.path);
	}

	// Every file path on trunk HEAD, for the dashboard's codebase map. Walking the tree costs
	// one readTree per directory, so the result is cached until trunk HEAD moves.
	private async tree() {
		const branch = await this.branch();
		using trunk = await this.env.ARTIFACTS.get(this.repo());
		const [head] = await trunk.log({ ref: branch, limit: 1 });
		if (!head) return { head: null, paths: [], truncated: false };
		if (this.treeCache?.head !== head.hash) {
			const tree = this.walk(head.hash).catch((err) => {
				this.treeCache = null;
				throw err;
			});
			this.treeCache = { head: head.hash, tree };
		}
		return this.treeCache.tree;
	}

	private async walk(sha: string) {
		using trunk = await this.env.ARTIFACTS.get(this.repo());
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

	private live(): Response {
		const [client, server] = Object.values(new WebSocketPair());
		this.ctx.acceptWebSocket(server);
		server.send(JSON.stringify({ type: "state", state: this.state() }));
		return new Response(null, { status: 101, webSocket: client });
	}

	private broadcast(event: object) {
		const msg = JSON.stringify({ ...event, at: Date.now() });
		for (const ws of this.ctx.getWebSockets()) {
			try {
				ws.send(msg);
			} catch {}
		}
	}

	// ── helpers ──────────────────────────────────────────────────────────────

	// Trunk writes and releases run one at a time; Durable Object input gates
	// open across awaited I/O, so this is what keeps two lands from racing on trunk.
	private serial<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.queue.then(fn, fn);
		this.queue = run.catch(() => {});
		return run;
	}

	// Cleanup is best-effort: a failed delete must never fail the land or release around it.
	private async deleteRepo(name: string): Promise<boolean> {
		try {
			return await this.env.ARTIFACTS.delete(name);
		} catch (err) {
			if ((err as ArtifactsError).code !== "NOT_FOUND") console.error(`delete ${name}:`, err);
			return false;
		}
	}

	private plan(id: string): Plan {
		const row = this.sql.exec<PlanRow>("SELECT * FROM plans WHERE id = ?", id).toArray()[0];
		if (!row) throw new Error(`unknown plan ${id}`);
		return toPlan(row);
	}

	private repo(): string {
		const repo = this.getMeta("repo");
		if (!repo) throw new Error("tower has no repo");
		return repo;
	}

	private getMeta(key: string): string | null {
		return this.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = ?", key).toArray()[0]?.value ?? null;
	}

	private setMeta(key: string, value: string) {
		this.sql.exec("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", key, value);
	}

	private bump(key: string) {
		this.sql.exec("INSERT INTO stats (key, value) VALUES (?, 1) ON CONFLICT (key) DO UPDATE SET value = value + 1", key);
		this.broadcast({ type: "stat", key });
	}
}

function toPlan(r: PlanRow): Plan {
	return {
		id: r.id,
		agent: r.agent,
		task: r.task,
		claims: JSON.parse(r.claims),
		status: r.status,
		blockedBy: JSON.parse(r.blocked_by),
		fork: r.fork,
		base: r.base,
		createdAt: r.created_at,
	};
}

function json(data: unknown, status = 200): Response {
	return Response.json(data, { status });
}

// A new fork is briefly unreadable (FORK_IN_PROGRESS) while Artifacts copies it, and a
// trunk that is already being forked rejects another fork with the same code.
async function retry<T>(fn: () => Promise<T>, attempts = 10): Promise<T> {
	for (let i = 1; ; i++) {
		try {
			return await fn();
		} catch (err) {
			if (i >= attempts || (err as ArtifactsError).code !== "FORK_IN_PROGRESS") throw err;
			await new Promise((r) => setTimeout(r, 200 * i));
		}
	}
}
