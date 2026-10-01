// Routes /repos/:repo/* to that repo's Tower, and /repos/:repo/mcp to the same Tower as MCP
// tools. Every route issues or reveals repo access, so all of them require the operator key
// (WebSocket clients may pass it as ?key=). The read-only dashboard key, if set, may only
// watch (see src/dashboard/access.ts). UI pages such as /repos/:repo/dashboard are static
// assets from web/ with no data of its own, so they are served without a key; they call the
// API with the ?key= from their own URL (see src/dashboard/pages.ts).
//
// The home page at / is web/index.html, served by the assets layer before this Worker runs.
// It reads GET /repos: every trunk with counts for the operator key, else only the public
// demo trunk (TOWER_DEMO_REPO), whose read-only routes need no key at all (see src/home.ts).

import { createMcpHandler } from "agents/mcp/server";
import { access } from "./dashboard/access";
import { pageAsset } from "./dashboard/pages";
import { demoAccess, home } from "./home";
import { createServer } from "./mcp";

export { Tower } from "./tower";

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);
		const key = request.headers.get("Authorization")?.replace(/^Bearer /, "") ?? url.searchParams.get("key");
		if (url.pathname === "/repos" && request.method === "GET") {
			return Response.json(await home(env, !!env.TOWER_API_KEY && key === env.TOWER_API_KEY));
		}

		const match = url.pathname.match(/^\/repos\/([A-Za-z0-9][A-Za-z0-9._-]*)(\/.*)?$/);
		if (!match) return Response.json({ error: "use /repos/:repo/..." }, { status: 404 });

		const [, repo, rest = "/"] = match;
		const websocket = request.headers.get("Upgrade") === "websocket";
		const page = pageAsset({ method: request.method, rest, websocket });
		if (page) {
			const asset = await env.ASSETS.fetch(new Request(new URL(page, url.origin), request));
			if (asset.status !== 404) return asset;
		}

		const keys = { operator: env.TOWER_API_KEY, dashboard: env.TOWER_DASHBOARD_KEY };
		const req = { method: request.method, rest, websocket };
		if (!access(keys, key, req) && !demoAccess(env.TOWER_DEMO_REPO, repo, req)) {
			return Response.json({ error: "unauthorized" }, { status: 401 });
		}

		if (rest === "/mcp") {
			return createMcpHandler(() => createServer(env, repo), { route: url.pathname })(request, env, ctx);
		}
		const forward = new Request(new URL(rest + url.search, url.origin), request);
		forward.headers.set("X-Tower-Repo", repo);
		return env.TOWER.getByName(repo).fetch(forward);
	},
} satisfies ExportedHandler<Env>;
