import { describe, expect, it } from "vitest";
import { counts, dur, fold, inline, lineDiff, listApply, listRows, markdown, phaseLength, stat, story } from "../../web/plan-model.js";

const claim = (path: string) => ({ path, dir: path.endsWith("/") });
const plan = (id: string, status: string, extra = {}) => ({
	id, agent: "agent-" + id, task: "do " + id, status, claims: [claim("src/a.ts")], blockedBy: [], amendment: null, fork: null, base: null, createdAt: 1000, ...extra,
});

describe("story", () => {
	const events = [
		{ seq: 1, at: 1000, type: "filed", planId: "p", plan: plan("p", "holding") },
		{ seq: 2, at: 1000, type: "holding", planId: "p", plan: plan("p", "holding"), blockedBy: ["q"] },
		{ seq: 5, at: 4000, type: "cleared", planId: "p", plan: plan("p", "cleared") },
		{ seq: 6, at: 4500, type: "provisioned", planId: "p", plan: plan("p", "cleared", { fork: "t--p" }), fork: "t--p", base: "abcdef1234" },
		{ seq: 7, at: 5000, type: "amendment_held", planId: "p", plan: plan("p", "cleared"), paths: ["src/b.ts"], blockedBy: ["r"] },
		{ seq: 8, at: 6000, type: "amended", planId: "p", plan: plan("p", "cleared"), added: ["src/b.ts"] },
		{ seq: 9, at: 7000, type: "drift", planId: "p", agent: "agent-p", paths: ["docs/x.md"], blocked: true },
		{ seq: 10, at: 9000, type: "landed", planId: "p", plan: plan("p", "landed"), sha: "f".repeat(40), summary: "did p", paths: ["src/a.ts", "src/b.ts"] },
	];
	const names: Record<string, string> = { q: "agent-q", r: "agent-r" };

	it("splits the plan's life into the statuses it was in", () => {
		const s = story(events, (id) => names[id] ?? id);
		expect(s.plan?.status).toBe("landed");
		expect(s.phases).toEqual([
			{ status: "holding", from: 1000, to: 4000 },
			{ status: "cleared", from: 4000, to: 9000 },
			{ status: "landed", from: 9000, to: null },
		]);
		expect(phaseLength(s.phases[1], 99_999)).toBe(5000);
		expect(phaseLength(s.phases[2], 9500)).toBe(500);
		expect(s).toMatchObject({ sha: "f".repeat(40), summary: "did p", paths: ["src/a.ts", "src/b.ts"] });
	});

	it("tells the lifecycle with blockers by name and drift with its paths", () => {
		const steps = story(events, (id) => names[id] ?? id).steps;
		expect(steps.map((x) => x.text)).toEqual([
			"filed",
			"holding behind agent-q",
			"cleared for takeoff",
			"got fork t--p at abcdef1",
			"amendment held behind agent-r",
			"amendment granted",
			"land rejected: changes outside claims",
			"landed fffffff: did p",
		]);
		expect(steps[1]).toMatchObject({ kind: "held", ids: ["q"] });
		expect(steps[6]).toMatchObject({ kind: "drift", paths: ["docs/x.md"] });
		expect(steps[7].kind).toBe("land");
	});

	it("tells a land that went through human review, with its risk", () => {
		const risk = { score: 7, level: "review", reasons: ["no test evidence"] };
		const s = story([
			{ seq: 1, at: 0, type: "filed", plan: plan("p", "cleared") },
			{ seq: 2, at: 1, type: "review", plan: plan("p", "cleared"), risk },
			{ seq: 3, at: 2, type: "sent_back", plan: plan("p", "cleared"), note: "add tests", risk },
			{ seq: 4, at: 3, type: "review", plan: plan("p", "cleared"), risk },
			{ seq: 5, at: 4, type: "released", plan: plan("p", "released"), rejected: true, note: "no", risk },
		]);
		expect(s.steps.map((x) => x.text)).toEqual([
			"filed",
			"waiting for human review (risk 7: no test evidence)",
			"sent back by review: add tests",
			"waiting for human review (risk 7: no test evidence)",
			"rejected in review: no",
		]);
		expect(s.risk).toEqual(risk);
	});

	it("covers expiry, release and event types it doesn't know", () => {
		const s = story([
			{ seq: 1, at: 0, type: "filed", plan: plan("p", "cleared") },
			{ seq: 2, at: 1, type: "needs_review", plan: plan("p", "review") },
			{ seq: 3, at: 2, type: "stat", key: "landed" },
			{ seq: 4, at: 3, type: "expired", plan: plan("p", "expired"), silentFor: 900_000 },
		]);
		expect(s.steps.map((x) => x.text)).toEqual(["filed", "needs review", "lease expired after 15m 0s of silence"]);
		expect(s.phases.map((p) => p.status)).toEqual(["cleared", "review", "expired"]);
	});
});

describe("plan list", () => {
	it("keeps every plan with its latest status, when it entered it, and its trunk SHA", () => {
		const rows = {};
		listApply(rows, { at: 1, type: "filed", plan: plan("a", "cleared", { createdAt: 1 }) });
		listApply(rows, { at: 2, type: "filed", plan: plan("b", "holding", { createdAt: 2 }) });
		listApply(rows, { at: 3, type: "amended", plan: plan("a", "cleared", { createdAt: 1 }) });
		listApply(rows, { at: 5, type: "landed", plan: plan("a", "landed", { createdAt: 1 }), sha: "abc" });
		listApply(rows, { at: 6, type: "stat", key: "landed" });
		expect(listRows(rows).map((r) => r.plan.id)).toEqual(["b", "a"]);
		expect(listRows(rows, "landed")).toMatchObject([{ plan: { id: "a" }, since: 5, sha: "abc", filedAt: 1 }]);
		expect(counts(rows)).toEqual({ landed: 1, holding: 1 });
	});
});

describe("lineDiff", () => {
	it("marks added, removed and kept lines with both sides' line numbers", () => {
		const d = lineDiff("a\nb\nc\n", "a\nB\nc\nd\n");
		expect(d.map((l) => l.op + l.text)).toEqual([" a", "-b", "+B", " c", "+d"]);
		expect(d[0]).toMatchObject({ a: 1, b: 1 });
		expect(d[3]).toMatchObject({ a: 3, b: 3 });
		expect(d[4]).toMatchObject({ a: null, b: 4 });
		expect(stat(d)).toEqual({ added: 2, removed: 1 });
	});

	it("treats a missing side as empty", () => {
		expect(lineDiff(null, "x\ny").map((l) => l.op)).toEqual(["+", "+"]);
		expect(lineDiff("x\n", null).map((l) => l.op)).toEqual(["-"]);
		expect(lineDiff("same\n", "same\n").map((l) => l.op)).toEqual([" "]);
	});

	it("folds long unchanged runs, keeping context around changes", () => {
		const before = Array.from({ length: 20 }, (_, i) => "l" + i).join("\n");
		const after = before.replace("l10", "L10");
		const rows = fold(lineDiff(before, after), 2);
		expect(rows.map((r) => (r.op === "skip" ? "skip" + r.count : r.op + r.text))).toEqual([
			"skip8", " l8", " l9", "-l10", "+L10", " l11", " l12", "skip7",
		]);
	});
});

describe("markdown", () => {
	it("parses headings, paragraphs, lists and fenced code", () => {
		const blocks = markdown("# Title\n\nSome **bold** and `code`.\nSame paragraph.\n\n- one\n- two\n  continued\n\n1. first\n\n```\n<b>raw</b>\n```");
		expect(blocks.map((b) => b.type)).toEqual(["h", "p", "ul", "ol", "code"]);
		expect(blocks[1]).toEqual({
			type: "p",
			inline: [
				{ type: "text", text: "Some " }, { type: "strong", text: "bold" }, { type: "text", text: " and " },
				{ type: "code", text: "code" }, { type: "text", text: ". Same paragraph." },
			],
		});
		expect(blocks[2]).toMatchObject({ items: [[{ text: "one" }], [{ text: "two" }, { text: " " }, { text: "continued" }]] });
		expect(blocks[4]).toEqual({ type: "code", text: "<b>raw</b>" });
	});

	it("keeps only http(s) links", () => {
		expect(inline("[ok](https://x.dev/a) [bad](javascript:alert(1)) see https://y.dev/b.")).toEqual([
			{ type: "link", text: "ok", href: "https://x.dev/a" },
			{ type: "text", text: " " },
			{ type: "text", text: "bad" },
			{ type: "text", text: ") see " },
			{ type: "link", text: "https://y.dev/b", href: "https://y.dev/b" },
			{ type: "text", text: "." },
		]);
	});
});

describe("dur", () => {
	it("reads at a glance", () => {
		expect([dur(850), dur(42_000), dur(252_000), dur(3_600_000 * 3 + 300_000), dur(86_400_000 * 2 + 3_600_000 * 4)]).toEqual([
			"850ms", "42s", "4m 12s", "3h 5m", "2d 4h",
		]);
	});
});
