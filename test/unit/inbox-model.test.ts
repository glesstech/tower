import { describe, expect, it } from "vitest";
import { cards, keyAction, outcome, REFETCH, refocus, step } from "../../web/inbox-model.js";

const item = (id: string, score: number, reasons: string[], requestedAt: number, key = "g") => ({
	id, agent: "agent-" + id, task: "do " + id, summary: null, paths: ["src/" + id + ".ts"],
	risk: { score, level: "review", reasons, group: { key, label: key } }, requestedAt,
});
const card = (key: string) => ({ key, label: key, count: 1, score: 50, reasons: [], plans: [] });
const list = [card("a"), card("b"), card("c")];

describe("cards", () => {
	it("puts the riskiest group first, its riskiest plan first, and each reason once", () => {
		const out = cards([
			{ key: "deps", label: "2 dependency bumps", count: 2, plans: [item("p", 30, ["diff size", "no tests"], 100, "deps"), item("q", 45, ["no tests", "blast radius 4"], 200, "deps")] },
			{ key: "auth", label: "1 change to src/auth/", count: 1, plans: [item("r", 80, ["sensitive path src/auth/"], 300, "auth")] },
		]);
		expect(out.map((c) => [c.key, c.label, c.count, c.score])).toEqual([["auth", "1 change to src/auth/", 1, 80], ["deps", "2 dependency bumps", 2, 45]]);
		expect(out[1].plans.map((p) => p.id)).toEqual(["q", "p"]);
		expect(out[1].reasons).toEqual(["no tests", "blast radius 4", "diff size"]);
	});

	it("breaks a tie in score by which group has waited longest", () => {
		const out = cards([
			{ key: "new", label: "new", count: 1, plans: [item("n", 60, [], 500, "new")] },
			{ key: "old", label: "old", count: 2, plans: [item("o1", 60, [], 900, "old"), item("o2", 10, [], 100, "old")] },
		]);
		expect(out.map((c) => c.key)).toEqual(["old", "new"]);
	});
});

describe("keyAction", () => {
	it("reads letters as shortcuts while browsing", () => {
		const browse = { mode: "browse" as const, focus: "a" };
		expect(keyAction(browse, "j")).toEqual({ type: "move", by: 1 });
		expect(keyAction(browse, "ArrowUp")).toEqual({ type: "move", by: -1 });
		expect(keyAction(browse, "a")).toEqual({ type: "approve" });
		expect(keyAction(browse, "r")).toEqual({ type: "start", decision: "reject" });
		expect(keyAction(browse, "s")).toEqual({ type: "start", decision: "send_back" });
		expect(keyAction(browse, "Enter")).toEqual({ type: "open" });
		expect(keyAction(browse, "x")).toBeNull();
		expect(keyAction(browse, "toString")).toBeNull();
	});

	it("leaves letters to the note input and makes Enter submit", () => {
		const note = { mode: "note" as const, focus: "a", decision: "reject" as const, note: "" };
		expect(keyAction(note, "a")).toBeNull();
		expect(keyAction(note, "j")).toBeNull();
		expect(keyAction(note, "Enter")).toEqual({ type: "submit" });
		expect(keyAction(note, "Escape")).toEqual({ type: "cancel" });
		expect(keyAction({ mode: "deciding", focus: "a", decision: "approve" }, "Escape")).toBeNull();
	});
});

describe("step", () => {
	it("moves focus within the list, starting at the top", () => {
		expect(step({ mode: "browse", focus: null }, { type: "move", by: 1 }, list)).toEqual({ mode: "browse", focus: "a" });
		expect(step({ mode: "browse", focus: "a" }, { type: "move", by: 1 }, list)).toEqual({ mode: "browse", focus: "b" });
		expect(step({ mode: "browse", focus: "c" }, { type: "move", by: 1 }, list)).toEqual({ mode: "browse", focus: "c" });
		expect(step({ mode: "browse", focus: "a" }, { type: "move", by: -1 }, list)).toEqual({ mode: "browse", focus: "a" });
		expect(step({ mode: "browse", focus: "b" }, { type: "focus", key: "c" }, list)).toEqual({ mode: "browse", focus: "c" });
		expect(step({ mode: "browse", focus: null }, { type: "move", by: 1 }, [])).toEqual({ mode: "browse", focus: null });
	});

	it("sends an approval at once", () => {
		expect(step({ mode: "browse", focus: "b" }, { type: "approve" }, list)).toEqual({ mode: "deciding", focus: "b", decision: "approve" });
		expect(step({ mode: "browse", focus: null }, { type: "approve" }, list)).toEqual({ mode: "browse", focus: null });
		expect(step({ mode: "browse", focus: "gone" }, { type: "approve" }, list)).toEqual({ mode: "browse", focus: "gone" });
	});

	it("takes a note before rejecting or sending back, and cancels back to browsing", () => {
		const note = step({ mode: "browse", focus: "a" }, { type: "start", decision: "send_back" }, list);
		expect(note).toEqual({ mode: "note", focus: "a", decision: "send_back", note: "" });
		const typed = step(note, { type: "type", note: "add a test" }, list);
		expect(typed).toEqual({ mode: "note", focus: "a", decision: "send_back", note: "add a test" });
		expect(step(typed, { type: "move", by: 1 }, list)).toEqual(typed);
		expect(step(typed, { type: "approve" }, list)).toEqual(typed);
		expect(step(typed, { type: "cancel" }, list)).toEqual({ mode: "browse", focus: "a" });
		expect(step(typed, { type: "submit" }, list)).toEqual({ mode: "deciding", focus: "a", decision: "send_back" });
	});

	it("ignores everything but done while a decision is in flight", () => {
		const deciding = { mode: "deciding" as const, focus: "b", decision: "reject" as const };
		expect(step(deciding, { type: "move", by: 1 }, list)).toEqual(deciding);
		expect(step(deciding, { type: "approve" }, list)).toEqual(deciding);
		expect(step(deciding, { type: "cancel" }, list)).toEqual(deciding);
		expect(step(deciding, { type: "done" }, list)).toEqual({ mode: "browse", focus: "b" });
	});
});

describe("refocus", () => {
	it("keeps focus on a group that is still waiting", () => {
		expect(refocus({ mode: "browse", focus: "b" }, list, [card("c"), card("b")])).toEqual({ mode: "browse", focus: "b" });
		const note = { mode: "note" as const, focus: "b", decision: "reject" as const, note: "no" };
		expect(refocus(note, list, [card("b")])).toEqual(note);
	});

	it("moves to the card now in the decided group's place", () => {
		expect(refocus({ mode: "browse", focus: "b" }, list, [card("a"), card("c")])).toEqual({ mode: "browse", focus: "c" });
		expect(refocus({ mode: "browse", focus: "c" }, list, [card("a"), card("b")])).toEqual({ mode: "browse", focus: "b" });
		expect(refocus({ mode: "note", focus: "b", decision: "reject", note: "x" }, list, [card("a")])).toEqual({ mode: "browse", focus: "a" });
	});

	it("focuses the first card on first load and nothing when the inbox empties", () => {
		expect(refocus({ mode: "browse", focus: null }, [], list)).toEqual({ mode: "browse", focus: "a" });
		expect(refocus({ mode: "browse", focus: "a" }, list, [])).toEqual({ mode: "browse", focus: null });
	});
});

describe("outcome", () => {
	it("counts each outcome with its reasons", () => {
		expect(outcome([
			{ id: "p", outcome: "landed" },
			{ id: "q", outcome: "sent_back", reason: "fork changed since it was reviewed" },
			{ id: "r", outcome: "landed" },
		])).toBe("2 landed, 1 sent back (fork changed since it was reviewed)");
		expect(outcome([{ id: "p", outcome: "rejected" }])).toBe("1 rejected");
		expect(outcome([{ id: "p", outcome: "sent_back" }, { id: "q", outcome: "sent_back" }])).toBe("2 sent back");
	});

	it("shows errors with their message", () => {
		expect(outcome([{ id: "p", outcome: "error", error: "plan p is not awaiting review" }, { id: "q", outcome: "rejected" }]))
			.toBe("1 rejected, 1 failed (plan p is not awaiting review)");
		expect(outcome([])).toBe("nothing was decided");
	});
});

describe("REFETCH", () => {
	it("refetches when a change enters or leaves review, not on agent chatter", () => {
		expect(["review", "sent_back", "landed", "released", "heartbeat", "filed", "drift"].filter((t) => REFETCH.has(t)))
			.toEqual(["review", "sent_back", "landed", "released"]);
	});
});
