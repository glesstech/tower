// Which /repos/:repo routes are UI pages. A page is web/<name>.html, served as the static
// asset /<name> at GET /repos/:repo/<name> without a key (it has no data of its own and calls
// the API with the ?key= from its URL). Adding web/<name>.html is all it takes to add one.
//
// Names the Tower answers to GET are never pages, so a stray web/state.html cannot shadow the
// API. Any other name that has no asset falls through to auth and the Tower.

const API_READS = new Set(["state", "tree", "why", "live", "mcp"]);

export function pageAsset(req: { method: string; rest: string; websocket: boolean }): string | null {
	if (req.method !== "GET" || req.websocket) return null;
	const name = req.rest.match(/^\/([a-z][a-z0-9-]*)$/)?.[1];
	if (!name || API_READS.has(name)) return null;
	return "/" + name;
}
