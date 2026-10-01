// One Tower per trunk repo. It is the single source of truth for who holds which airspace,
// the only writer to trunk, and the keeper of why each landed change was made.
//
//   plan ──overlap?──▶ holding ──(blocker lands/releases)──▶ cleared ──▶ fork + scoped token
//                         │                                                │
//                         └──────────── no overlap ───────────────────────┘
//   cleared ──amend──▶ new paths free? ──▶ claims extended
//                        └─held─▶ amendment waits (keeping fork + lease) until its blockers close;
//                                 one that would close a wait-for cycle is refused (409 deadlock)
//   cleared ──land──▶ diff fork vs base ──outside lease?──▶ 409 drift (stays cleared)
//                                        └─inside lease──▶ overlay onto trunk, push, landed
//
// This class is the router; the logic lives in src/tower/: plans.ts (file, clear, amend,
// release), landing.ts (check, land, why), trunk.ts (init, teardown, tree, blob), events.ts
// (the persisted event log and live feed, stats, dashboard state), schema.ts, and core.ts
// (shared types and helpers).

import { DurableObject } from "cloudflare:workers";
import type { TrunkWorkspace } from "./land";
import { type Core, json, setMeta, type Tree } from "./tower/core";
import { events, live, state } from "./tower/events";
import { check, land, why } from "./tower/landing";
import { amend, file, release, status } from "./tower/plans";
import { schema } from "./tower/schema";
import { blob, destroy, init, readToken, tree } from "./tower/trunk";

export class Tower extends DurableObject<Env> implements Core {
	declare readonly ctx: DurableObjectState<{}>;
	declare readonly env: Env;
	readonly sql: SqlStorage;
	queue: Promise<unknown> = Promise.resolve();
	workspace: TrunkWorkspace | null = null;
	provisioning = new Map<string, Promise<void>>();
	treeCache: { head: string; tree: Promise<Tree> } | null = null;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sql = ctx.storage.sql;
		schema(this.sql);
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const repo = request.headers.get("X-Tower-Repo");
		if (repo) setMeta(this, "repo", repo);
		const parts = url.pathname.split("/").filter(Boolean);
		const body = request.method === "POST" ? await request.json<any>().catch(() => ({})) : {};

		try {
			if (request.headers.get("Upgrade") === "websocket") return live(this, url.searchParams.get("since"));
			if (request.method === "POST" && parts[0] === "init") return json(await init(this, body.importUrl));
			if (request.method === "DELETE" && parts.length === 0) return json(await destroy(this));
			if (request.method === "POST" && parts[0] === "token") return json(await readToken(this));
			if (request.method === "GET" && parts[0] === "state") return json(state(this));
			if (request.method === "GET" && parts[0] === "events") {
				const q = url.searchParams;
				return json(events(this, { since: q.get("since"), plan: q.get("plan"), limit: q.get("limit") }));
			}
			if (request.method === "GET" && parts[0] === "tree") return json(await tree(this));
			if (request.method === "GET" && parts[0] === "blob") {
				const file = await blob(this, url.searchParams.get("path") ?? "");
				return file ? json(file) : json({ error: "no such file on trunk" }, 404);
			}
			if (request.method === "GET" && parts[0] === "why") {
				return json(why(this, url.searchParams.get("path") ?? "", url.searchParams.get("limit")));
			}
			if (parts[0] === "plans") {
				if (request.method === "POST" && parts.length === 1) return json(await file(this, body), 201);
				const id = parts[1];
				if (request.method === "GET" && parts.length === 2) return json(await status(this, id));
				if (request.method === "POST" && parts[2] === "check") return json(await check(this, id));
				if (request.method === "POST" && parts[2] === "amend") return amend(this, id, body.claims);
				if (request.method === "POST" && parts[2] === "land") return await land(this, id, body);
				if (request.method === "POST" && parts[2] === "release") return json(await release(this, id));
			}
			return json({ error: "not found" }, 404);
		} catch (err) {
			console.error(`${request.method} ${url.pathname}:`, err);
			return json({ error: (err as Error).message }, 400);
		}
	}
}
