// Which /repos/:repo routes are UI pages. A page is web/<name>.html, served as the static
// asset /<name> at GET /repos/:repo/<name> without a key (it has no data of its own and calls
// the API with the ?key= from its URL). Adding web/<name>.html is all it takes to add one.
//
// Names the Tower answers to GET are never pages, so a stray web/state.html cannot shadow the
// API. Any other name that has no asset falls through to auth and the Tower.
//
// Two pages share their URL with the API, so each is the page only for a browser navigating to
// it (Accept: text/html) and API clients get the Tower's JSON as before: a plan's page is
// web/plan.html at /repos/:repo/plans/:id, which agents poll for clearance, and the inbox is
// web/inbox.html at /repos/:repo/inbox, which is also GET /inbox.

const API_READS = new Set(["state", "events", "tree", "blob", "why", "live", "mcp", "inbox"]);

export function pageAsset(req: { method: string; rest: string; websocket: boolean; html?: boolean }): string | null {
	if (req.method !== "GET" || req.websocket) return null;
	if (req.html && /^\/plans\/[A-Za-z0-9_-]+$/.test(req.rest)) return "/plan";
	if (req.html && req.rest === "/inbox") return "/inbox";
	const name = req.rest.match(/^\/([a-z][a-z0-9-]*)$/)?.[1];
	if (!name || API_READS.has(name)) return null;
	return "/" + name;
}
