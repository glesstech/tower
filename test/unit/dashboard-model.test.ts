import { beforeEach, describe, expect, it } from "vitest";
import {
	PALETTE, activePlans, amendmentOn, apply, applyState, behindBroad, color, coverageText, createModel, describe as describeEvent, holdingOn,
	queues, remember, replayDelays, resetColors, sample, shortName, throughput,
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

describe("claim coverage", () => {
	it("keeps each plan's coverage and forced claims from filed and amended events, across snapshots", () => {
		const m = createModel();
		const a = plan("a", "x-1", "cleared", ["src/"], 1);
		const b = plan("b", "x-2", "holding", ["src/tower/events.ts"], 2);
		applyState(m, { seq: 0, plans: [a, b], lands: [], stats: {} });
		// Backfilled history: only remember() runs, and /state plans carry no coverage.
		remember(m, { seq: 1, at: 1, type: "filed", planId: "a", agent: "x-1", plan: a, forced: ["src/"], coverage: { files: 15, share: 0.75, trunk: 20, claims: [] } });
		remember(m, { seq: 2, at: 2, type: "filed", planId: "b", agent: "x-2", plan: b, coverage: { files: 1, share: 0.05, trunk: 20, claims: [] } });
		expect(m.hygiene.a).toEqual({ coverage: { files: 15, share: 0.75, trunk: 20 }, forced: ["src/"] });
		expect(m.hygiene.b).toEqual({ coverage: { files: 1, share: 0.05, trunk: 20 }, forced: [] });
		applyState(m, { seq: 2, plans: [a, b], lands: [], stats: {} });
		expect(m.hygiene.a.forced).toEqual(["src/"]);
		expect(behindBroad(m, b, [a, b])).toBe(true);

		// A granted amendment carries the whole lease's coverage.
		remember(m, { seq: 3, at: 3, type: "amended", planId: "b", agent: "x-2", plan: b, added: ["web/model.js"], coverage: { files: 2, share: 0.1, trunk: 20, claims: [] } });
		expect(m.hygiene.b.coverage).toEqual({ files: 2, share: 0.1, trunk: 20 });
		expect(behindBroad(m, a, [a, b])).toBe(false);
	});

	it("flags forced claims in the feed", () => {
		const m = createModel();
		const a = plan("a", "x-1", "cleared", ["src/"], 1);
		const e = describeEvent(m, { seq: 1, at: 1, type: "filed", planId: "a", agent: "x-1", plan: a, forced: ["src/"] })!;
		expect(e).toMatchObject({ kind: "drift", paths: ["src/"] });
		expect(e.text).toContain("forced broad claim");
		expect(describeEvent(m, { seq: 2, at: 2, type: "filed", planId: "a", agent: "x-1", plan: a })!.kind).toBe("info");
	});

	it("says how much of trunk a plan covers", () => {
		expect(coverageText({ files: 12, share: 0.03, trunk: 400 })).toBe("12 files · 3% of trunk");
		expect(coverageText({ files: 1, share: 0.002, trunk: 500 })).toBe("1 file · <1% of trunk");
		expect(coverageText({ files: 0, share: 0, trunk: 20 })).toBe("0 files · 0% of trunk");
	});
});

describe("replayDelays", () => {
	it("caps idle gaps and scales by speed", () => {
		expect(replayDelays([{ at: 0 }, { at: 1000 }, { at: 600_000 }], 4)).toEqual([0, 250, 500]);
	});
});

describe("throughput", () => {
	const ev = (type: string, p: ReturnType<typeof plan>, at: number, extra = {}) => ({ type, at, planId: p.id, agent: p.agent, plan: p, ...extra });

	it("samples queue depth and agents in flight from plan events, merging bursts within a second", () => {
		const m = createModel();
		apply(m, ev("filed", plan("a", "agent-a", "cleared", ["x"], 1000), 1000));
		apply(m, ev("filed", plan("b", "agent-b", "holding", ["x"], 1100), 1100));
		apply(m, ev("filed", plan("c", "agent-c", "holding", ["x"], 1200), 1200));
		expect(m.samples).toEqual([{ at: 1000, holding: 2, flying: 1 }]);
		apply(m, ev("landed", plan("a", "agent-a", "landed", ["x"], 1000), 5000, { sha: "s1", paths: ["x"] }));
		apply(m, ev("cleared", plan("b", "agent-b", "cleared", ["x"], 1100), 5000));
		// Same instant: the land left 2 holding, then b cleared (1 in flight); the merge keeps the most.
		expect(m.samples.at(-1)).toEqual({ at: 5000, holding: 2, flying: 1 });
		apply(m, ev("filed", plan("d", "agent-d", "cleared", ["y"], 7000), 7000));
		expect(m.samples.at(-1)).toEqual({ at: 7000, holding: 1, flying: 2 });
		expect(m.landedAt).toEqual({ s1: 5000 });
	});

	it("buckets lands as a per-minute rate and carries counts across quiet buckets", () => {
		const m = createModel();
		m.samples = [{ at: 0, holding: 5, flying: 2 }, { at: 16_000, holding: 9, flying: 3 }, { at: 17_000, holding: 7, flying: 3 }];
		m.landedAt = { a: 1000, b: 2000, c: 31_000, old: -100_000 };
		m.plans = { p: plan("p", "agent-p", "holding", ["x"], 0) };
		const t = throughput(m, 60_000, { buckets: 4, bucketMs: 15_000 });
		expect(t.lands).toEqual([8, 0, 4, 0]); // 2 lands in 15s is 8/min
		expect(t.holding).toEqual([5, 9, 7, 7]);
		expect(t.flying).toEqual([2, 3, 3, 3]);
		expect(t.now).toEqual({ landsPerMin: 3, holding: 1, flying: 0 });
		expect(t.peak).toEqual({ landsPerMin: 8, holding: 9, flying: 3 });
	});

	it("keeps a bounded number of samples", () => {
		const m = createModel();
		for (let i = 0; i < 6000; i++) sample(m, i * 1000);
		expect(m.samples.length).toBe(5000);
		expect(m.samples[0].at).toBe(1_000_000);
	});

	it("reads land times from a snapshot", () => {
		const m = createModel();
		applyState(m, { plans: [], lands: [{ sha: "s", plan_id: "p", agent: "a", summary: "x", paths: [], landed_at: 42 }], stats: {} });
		expect(m.landedAt).toEqual({ s: 42 });
	});
});

describe("queues", () => {
	it("groups holding plans by the paths they claim, biggest line first, with the next few in line", () => {
		const plans = [
			plan("a", "a", "cleared", ["m0"], 1),
			...Array.from({ length: 5 }, (_, i) => plan("h" + i, "h" + i, "holding", ["m0"], 2 + i)),
			plan("x", "x", "holding", ["m1", "m2"], 10),
			plan("y", "y", "holding", ["m2", "m1"], 11),
		];
		const q = queues(plans);
		expect(q.map((g) => [g.paths, g.count])).toEqual([[["m0"], 5], [["m1", "m2"], 2]]);
		expect(q[0].next.map((p) => p.id)).toEqual(["h0", "h1", "h2"]);
	});
});

describe("feed in a long line", () => {
	it("names the first three plans ahead and counts the rest", () => {
		const m = createModel();
		const ahead = ["a", "b", "c", "d", "e"];
		ahead.forEach((id) => { m.names[id] = "agent-" + id; });
		const e = describeEvent(m, { type: "holding", seq: 1, at: 1, planId: "z", agent: "agent-z", blockedBy: ahead });
		expect(e?.text).toBe("holding behind agent-a, agent-b, agent-c and 2 more");
		expect(describeEvent(m, { type: "holding", seq: 2, at: 2, planId: "y", agent: "agent-y", blockedBy: ["a"] })?.text).toBe("holding behind agent-a");
	});
});
