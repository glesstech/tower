import { describe, expect, it } from "vitest";
import { counts, demoAccess, home, trunkNames } from "../../src/home";

const get = (rest: string, websocket = false) => ({ method: "GET", rest, websocket });

describe("trunkNames", () => {
	it("keeps trunks and drops forks", () => {
		expect(trunkNames([{ name: "web" }, { name: "web--ab12cd34" }, { name: "api" }, { name: "api--ffff0000" }])).toEqual(["api", "web"]);
	});
});

describe("counts", () => {
	it("counts cleared plans as in flight, holding plans, landed and conflicts prevented", () => {
		const state = {
			plans: [{ status: "cleared" }, { status: "cleared" }, { status: "holding" }],
			stats: { landed: 7, conflicts_prevented: 3, drift_blocked: 1 },
		};
		expect(counts(state)).toEqual({ in_flight: 2, holding: 1, landed: 7, conflicts_prevented: 3 });
	});

	it("reads an empty Tower as zeros", () => {
		expect(counts({ plans: [], stats: {} })).toEqual({ in_flight: 0, holding: 0, landed: 0, conflicts_prevented: 0 });
	});
});

describe("demoAccess", () => {
	it("lets anyone watch the demo trunk", () => {
		expect(demoAccess("demo", "demo", get("/state"))).toBe(true);
		expect(demoAccess("demo", "demo", get("/events"))).toBe(true);
		expect(demoAccess("demo", "demo", get("/tree"))).toBe(true);
		expect(demoAccess("demo", "demo", get("/live", true))).toBe(true);
		// The code explorer reads trunk files and land history; /state already shows the lands.
		expect(demoAccess("demo", "demo", get("/blob"))).toBe(true);
		expect(demoAccess("demo", "demo", get("/why"))).toBe(true);
		expect(demoAccess("demo", "demo", get("/inbox"))).toBe(true);
	});

	it("keeps everything else on the demo trunk behind the key", () => {
		expect(demoAccess("demo", "demo", get("/mcp"))).toBe(false);
		expect(demoAccess("demo", "demo", get("/plans/abc"))).toBe(false);
		expect(demoAccess("demo", "demo", { method: "POST", rest: "/plans", websocket: false })).toBe(false);
		expect(demoAccess("demo", "demo", { method: "POST", rest: "/token", websocket: false })).toBe(false);
		expect(demoAccess("demo", "demo", { method: "POST", rest: "/inbox/decide", websocket: false })).toBe(false);
		expect(demoAccess("demo", "demo", { method: "DELETE", rest: "/", websocket: false })).toBe(false);
	});

	it("opens nothing on other trunks, or when no demo is configured", () => {
		expect(demoAccess("demo", "other", get("/state"))).toBe(false);
		expect(demoAccess(undefined, "demo", get("/state"))).toBe(false);
		expect(demoAccess("", "", get("/state"))).toBe(false);
	});
});

describe("home", () => {
	const state = { plans: [{ status: "cleared" }, { status: "holding" }], stats: { landed: 4, conflicts_prevented: 2 } };
	const env = (demo?: string, gone: string[] = []) =>
		({
			TOWER_DEMO_REPO: demo,
			ARTIFACTS: {
				get: async (name: string) => {
					if (gone.includes(name)) throw Object.assign(new Error(`Repository not found: ${name}.`), { code: "NOT_FOUND" });
					return { info: async () => ({ name }), [Symbol.dispose]() {} };
				},
				list: async ({ cursor }: { cursor?: string } = {}) =>
					cursor
						? { repos: [{ name: "b" }, { name: "b--2" }], total: 4 }
						: { repos: [{ name: "a" }, { name: "a--1" }], total: 4, cursor: "next" },
			},
			TOWER: {
				getByName: () => ({ fetch: async () => Response.json(state) }),
			},
		}) as unknown as Env;
	const c = { in_flight: 1, holding: 1, landed: 4, conflicts_prevented: 2 };

	it("lists every trunk across pages, with counts, for the operator", async () => {
		expect(await home(env("a"), true)).toEqual({ demo: "a", trunks: [{ repo: "a", counts: c }, { repo: "b", counts: c }] });
	});

	it("shows only the demo trunk without the operator key", async () => {
		expect(await home(env("b"), false)).toEqual({ demo: "b", trunks: [{ repo: "b", counts: c }] });
		expect(await home(env(), false)).toEqual({ demo: null, trunks: [] });
	});

	it("never shows a demo trunk that was torn down", async () => {
		expect(await home(env("gone", ["gone"]), false)).toEqual({ demo: null, trunks: [] });
		expect(await home(env("gone", ["gone"]), true)).toEqual({ demo: null, trunks: [{ repo: "a", counts: c }, { repo: "b", counts: c }] });
	});
});
