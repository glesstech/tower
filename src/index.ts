// Routes /repos/:repo/* to that repo's Tower, and /repos/:repo/mcp to the same Tower as MCP
// tools. Every route issues or reveals repo access, so all of them require the operator key
// (WebSocket clients may pass it as ?key=). The read-only dashboard key, if set, may only
// watch (see src/dashboard/access.ts). /repos/:repo/dashboard is a static page with no data
// of its own, so it is served without a key; it connects with the ?key= from its own URL.

import { createMcpHandler } from "agents/mcp/server";
import { access } from "./dashboard/access";
import { dashboardPage } from "./dashboard/page";
import { createServer } from "./mcp";

export { Tower } from "./tower";

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);
		const match = url.pathname.match(/^\/repos\/([A-Za-z0-9][A-Za-z0-9._-]*)(\/.*)?$/);
		if (!match) return Response.json({ error: "use /repos/:repo/..." }, { status: 404 });

		const [, repo, rest = "/"] = match;
		if (request.method === "GET" && rest === "/dashboard") {
			return new Response(dashboardPage(repo), { headers: { "Content-Type": "text/html; charset=utf-8" } });
		}

		const key = request.headers.get("Authorization")?.replace(/^Bearer /, "") ?? url.searchParams.get("key");
		const websocket = request.headers.get("Upgrade") === "websocket";
		const keys = { operator: env.TOWER_API_KEY, dashboard: env.TOWER_DASHBOARD_KEY };
		if (!access(keys, key, { method: request.method, rest, websocket })) {
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
