// Who may call a /repos/:repo route. The operator key opens everything. The optional
// dashboard key only watches: the live WebSocket, the state snapshot, the event log, the
// trunk file tree, trunk file contents (/blob) and land history (/why, which carries nothing
// /state's lands do not already show), and a plan's diff (GET /plans/:id/diff, landed or in
// flight). It never reaches MCP, tokens, plan polls, init or teardown, so it is safe to put in
// a dashboard URL shown on screen.

export type Access = "operator" | "dashboard" | null;

export function access(
	keys: { operator?: string; dashboard?: string },
	key: string | null,
	req: { method: string; rest: string; websocket: boolean },
): Access {
	if (!key) return null;
	if (keys.operator && key === keys.operator) return "operator";
	if (keys.dashboard && key === keys.dashboard && readOnly(req)) return "dashboard";
	return null;
}

// The Tower answers any WebSocket upgrade with the live feed, so the path is matched exactly.
function readOnly({ method, rest, websocket }: { method: string; rest: string; websocket: boolean }): boolean {
	if (method !== "GET") return false;
	if (websocket) return rest === "/live";
	return ["/state", "/events", "/tree", "/blob", "/why"].includes(rest) || /^\/plans\/[^/]+\/diff$/.test(rest);
}
