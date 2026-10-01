// Who may call a /repos/:repo route. The operator key opens everything. The optional
// dashboard key only watches: the live WebSocket, the state snapshot, the event log and
// the trunk file tree. It never reaches MCP, tokens, plans, init or teardown, so it is safe to put in a
// dashboard URL shown on screen.

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
	return rest === "/state" || rest === "/events" || rest === "/tree";
}
