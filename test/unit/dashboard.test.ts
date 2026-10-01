import { describe, expect, it } from "vitest";
import { access } from "../../src/dashboard/access";
import { pageAsset } from "../../src/dashboard/pages";

const keys = { operator: "op", dashboard: "view" };
const get = (rest: string, websocket = false) => ({ method: "GET", rest, websocket });

describe("access", () => {
	it("lets the operator key reach every route", () => {
		expect(access(keys, "op", { method: "POST", rest: "/plans", websocket: false })).toBe("operator");
		expect(access(keys, "op", { method: "DELETE", rest: "/", websocket: false })).toBe("operator");
		expect(access(keys, "op", get("/mcp"))).toBe("operator");
	});

	it("lets the dashboard key watch: live feed, state and tree", () => {
		expect(access(keys, "view", get("/live", true))).toBe("dashboard");
		expect(access(keys, "view", get("/state"))).toBe("dashboard");
		expect(access(keys, "view", get("/tree"))).toBe("dashboard");
	});

	it("keeps the dashboard key away from everything else", () => {
		expect(access(keys, "view", { method: "POST", rest: "/plans", websocket: false })).toBeNull();
		expect(access(keys, "view", { method: "POST", rest: "/token", websocket: false })).toBeNull();
		expect(access(keys, "view", { method: "POST", rest: "/init", websocket: false })).toBeNull();
		expect(access(keys, "view", { method: "DELETE", rest: "/", websocket: false })).toBeNull();
		expect(access(keys, "view", get("/mcp"))).toBeNull();
		expect(access(keys, "view", get("/why"))).toBeNull();
		expect(access(keys, "view", get("/plans/abc"))).toBeNull();
		// The Tower answers any upgrade with the live feed, so only /live may upgrade.
		expect(access(keys, "view", get("/state", true))).toBeNull();
		expect(access(keys, "view", { method: "POST", rest: "/live", websocket: true })).toBeNull();
	});

	it("rejects missing, wrong and unconfigured keys", () => {
		expect(access(keys, null, get("/state"))).toBeNull();
		expect(access(keys, "", get("/state"))).toBeNull();
		expect(access(keys, "nope", get("/state"))).toBeNull();
		expect(access({ operator: "op" }, "", get("/live", true))).toBeNull();
		expect(access({ operator: "op", dashboard: "" }, "", get("/live", true))).toBeNull();
		expect(access({}, "", get("/state"))).toBeNull();
	});
});

describe("pageAsset", () => {
	it("serves GET /<name> as the web/<name>.html asset", () => {
		expect(pageAsset(get("/dashboard"))).toBe("/dashboard");
		expect(pageAsset(get("/plans"))).toBe("/plans");
		expect(pageAsset(get("/code-explorer"))).toBe("/code-explorer");
	});

	it("never shadows the API", () => {
		for (const rest of ["/state", "/tree", "/why", "/live", "/mcp"]) expect(pageAsset(get(rest))).toBeNull();
		expect(pageAsset(get("/dashboard", true))).toBeNull();
		expect(pageAsset({ method: "POST", rest: "/plans", websocket: false })).toBeNull();
		expect(pageAsset({ method: "DELETE", rest: "/", websocket: false })).toBeNull();
		expect(pageAsset(get("/plans/abc"))).toBeNull();
		expect(pageAsset(get("/"))).toBeNull();
	});

	it("only maps plain page names", () => {
		expect(pageAsset(get("/client.js"))).toBeNull();
		expect(pageAsset(get("/../secret"))).toBeNull();
		expect(pageAsset(get("/Dashboard"))).toBeNull();
	});
});
