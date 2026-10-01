import { beforeEach, describe, expect, it } from "vitest";
import {
	PALETTE, activePlans, amendmentOn, apply, applyState, color, createModel, describe as describeEvent, holdingOn,
	remember, replayDelays, resetColors, shortName,
} from "../../web/model.js";

const claim = (path: string) => ({ path, dir: path.endsWith("/") });
const plan = (id: string, agent: string, status: string, paths: string[], createdAt: number, extra = {}) => ({
	id, agent, task: "task of " + agent + "\nmore detail", status, claims: paths.map(claim), blockedBy: [], fork: null, createdAt, ...extra,
});

describe("color", () => {
	beforeEach(() => resetColors());

	it("gives agents that differ in one character different palette colors, in first-seen order", () => {
		const a = color("claude-issue-21");
		const b = color("claude-issue-22");
		expect(a).toBe(PALETTE[0]);
		expect(b).toBe(PALETTE[1]);
		expect(color("claude-issue-21")).toBe(a);
	});

	it("falls back to spread hashes once the palette runs out, and stays stable", () => {
		const names = Array.from({ length: PALETTE.length + 3 }, (_, i) => "sim-agent-" + i);
		const colors = names.map(color);
		expect(new Set(colors.slice(0, PALETTE.length))).toEqual(new Set(PALETTE));
		const hues = colors.slice(PALETTE.length).map((c) => Number(c.match(/hsl\(([\d.]+)/)![1]));
		expect(Math.abs(hues[0] - hues[1])).toBeGreaterThan(5);
		expect(names.map(color)).toEqual(colors);
	});
});

describe("shortName", () => {
	it("keeps the part that tells swarm agents apart", () => {
		expect(shortName("claude-issue-21")).toBe("21");
		expect(shortName("sim_7")).toBe("7");
		expect(shortName("alice")).toBe("alice");
	});
});

describe("who waits on whom", () => {
	const a = plan("a", "claude-issue-11", "cleared", ["src/tower.ts", "test/"], 1);
	const b = plan("b", "claude-issue-12", "holding", ["src/tower.ts"], 2);
	const c = plan("c", "claude-issue-13", "holding", ["test/x.test.ts", "src/tower.ts"], 3);

	it("names the blocking agent and the paths it holds", () => {
		expect(holdingOn(b, [a, b, c]).map((w) => [w.plan.agent, w.paths])).toEqual([["claude-issue-11", ["src/tower.ts"]]]);
		// Earlier holding plans count too: c queues behind b as well as a.
		expect(holdingOn(c, [a, b, c]).map((w) => [w.plan.agent, w.paths])).toEqual([
			["claude-issue-11", ["src/tower.ts", "test/x.test.ts"]],
			["claude-issue-12", ["src/tower.ts"]],
		]);
	});

	it("shows what a held amendment waits on (only cleared plans block it)", () => {
		const d = plan("d", "claude-issue-14", "cleared", ["README.md"], 4, {
			amendment: { claims: [claim("test/"), claim("src/tower.ts")], blockedBy: ["a"], requestedAt: 5 },
		});
		expect(amendmentOn(d, [a, b, c, d]).map((w) => [w.plan.agent, w.paths])).toEqual([["claude-issue-11", ["src/tower.ts", "test/"]]]);
	});
});

describe("reducing events", () => {
	it("rebuilds plans, lands, stats and the feed from events alone (replay)", () => {
		const m = createModel();
		const p = plan("a", "claude-issue-11", "cleared", ["src/a.ts"], 1);
		apply(m, { seq: 1, at: 10, type: "filed", planId: "a", agent: p.agent, plan: { ...p, status: "cleared" } });
		apply(m, { seq: 2, at: 11, type: "cleared", planId: "a", agent: p.agent, plan: p });
		apply(m, { seq: 3, at: 12, type: "drift", planId: "a", agent: p.agent, paths: ["README.md"], blocked: true });
		apply(m, { seq: 4, at: 13, type: "stat", key: "drift_blocked" });
		expect(activePlans(m).map((x) => x.id)).toEqual(["a"]);
		expect(m.clearedAt.a).toBe(11);
		const land = apply(m, { seq: 5, at: 14, type: "landed", planId: "a", agent: p.agent, plan: { ...p, status: "landed" }, sha: "abc1234def", summary: "Add a", paths: ["src/a.ts"] });
		expect(land?.sha).toBe("abc1234def");
		expect(activePlans(m)).toEqual([]);
		expect(m.lands.map((l) => l.summary)).toEqual(["Add a"]);
		expect(m.stats.drift_blocked).toBe(1);
		const drift = m.feed.find((f) => f.kind === "drift")!;
		expect(drift.text).toContain("land rejected");
		expect(drift.paths).toEqual(["README.md"]);
		expect(m.feed.at(-1)!.kind).toBe("land");
	});

	it("keeps deadlock refusals per plan until the plan amends, lands or releases", () => {
		const m = createModel();
		applyState(m, { seq: 0, plans: [plan("a", "x-1", "cleared", ["a"], 1), plan("b", "x-2", "cleared", ["b"], 2)], lands: [], stats: {} });
		remember(m, { seq: 1, at: 5, type: "deadlock", planId: "a", agent: "x-1", paths: ["b"], cycle: ["a", "b", "a"] });
		expect(m.deadlocks.a).toEqual({ at: 5, paths: ["b"], cycle: ["a", "b", "a"] });
		expect(describeEvent(m, { seq: 1, at: 5, type: "deadlock", planId: "a", agent: "x-1", paths: ["b"], cycle: ["a", "b", "a"] })!.text).toContain("x-1 → x-2 → x-1");
		remember(m, { seq: 2, at: 6, type: "released", planId: "a", agent: "x-1" });
		expect(m.deadlocks.a).toBeUndefined();
	});

	it("does not duplicate feed entries when backfilled history overlaps live events", () => {
		const m = createModel();
		const ev = { seq: 7, at: 1, type: "released", planId: "a", agent: "x-1" };
		remember(m, ev);
		remember(m, ev);
		expect(m.feed).toHaveLength(1);
	});

	it("takes lands with evidence from a state snapshot, oldest first", () => {
		const m = createModel();
		applyState(m, {
			seq: 9, plans: [], stats: { landed: 2 },
			lands: [
				{ sha: "2", plan_id: "b", agent: "y", task: "t", summary: "second", evidence: { checks: "ok" }, landed_at: 2, paths: ["b"] },
				{ sha: "1", plan_id: "a", agent: "x", task: "t", summary: "first", evidence: null, landed_at: 1, paths: ["a"] },
			],
		});
		expect(m.lands.map((l) => l.summary)).toEqual(["first", "second"]);
		expect(m.lands[1].evidence).toEqual({ checks: "ok" });
		expect(m.seq).toBe(9);
	});
});

describe("replayDelays", () => {
	it("caps idle gaps and scales by speed", () => {
		expect(replayDelays([{ at: 0 }, { at: 1000 }, { at: 600_000 }], 4)).toEqual([0, 250, 500]);
	});
});
