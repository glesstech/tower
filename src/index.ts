// Routes /repos/:repo/* to that repo's Tower. Every route issues or reveals repo access,
// so all of them require the operator key (WebSocket clients may pass it as ?key=).

export { Tower } from "./tower";

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);
		const match = url.pathname.match(/^\/repos\/([A-Za-z0-9][A-Za-z0-9._-]*)(\/.*)?$/);
		if (!match) return Response.json({ error: "use /repos/:repo/..." }, { status: 404 });

		const key = request.headers.get("Authorization")?.replace(/^Bearer /, "") ?? url.searchParams.get("key");
		if (!env.TOWER_API_KEY || key !== env.TOWER_API_KEY) {
			return Response.json({ error: "unauthorized" }, { status: 401 });
		}

		const [, repo, rest = "/"] = match;
		const forward = new Request(new URL(rest + url.search, url.origin), request);
		forward.headers.set("X-Tower-Repo", repo);
		return env.TOWER.getByName(repo).fetch(forward);
	},
} satisfies ExportedHandler<Env>;
