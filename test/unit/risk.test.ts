import { describe, expect, it } from "vitest";
import { evidence, type FileChange, importersOf, importSpecifiers, lineDelta, resolveImport, type RiskInput, score } from "../../src/risk";

const edit = (path: string, added = 1, removed = 1): FileChange => ({ path, op: "upsert", added, removed });
const input = (over: Partial<RiskInput> = {}): RiskInput => ({
	changes: [edit("src/a.ts")],
	importers: {},
	overlaps: [],
	evidence: { checks: "npm test: 12 passed" },
	...over,
});

describe("score", () => {
	it("lets a small, tested change with few importers land on its own", () => {
		const r = score(input({ importers: { "src/a.ts": ["src/b.ts"] } }));
		expect(r).toMatchObject({ level: "low", reasons: [] });
		expect(r.score).toBeLessThan(40);
	});

	it("does not send a small change to review for missing evidence alone", () => {
		const r = score(input({ evidence: undefined }));
		expect(r).toMatchObject({ level: "low", reasons: ["no test evidence"] });
	});

	it("sends sensitive paths to review whatever the score", () => {
		for (const path of ["src/auth/session.ts", "billing/invoice.ts", ".github/workflows/ci.yml", "db/migrations/001.sql", "wrangler.jsonc", ".env.production"]) {
			const r = score(input({ changes: [edit(path)] }));
			expect(r.level, path).toBe("review");
			expect(r.reasons.join(), path).toMatch(/^sensitive: /);
		}
		// Tests about auth are not auth.
		expect(score(input({ changes: [edit("test/auth.test.ts")] })).level).toBe("low");
	});

	it("sends failing checks to review", () => {
		const r = score(input({ evidence: { checks: "Tests 1 failed | 20 passed" } }));
		expect(r).toMatchObject({ level: "review", reasons: ["checks reported failures"] });
	});

	it("scores blast radius, coverage drops and diff size", () => {
		const importers = { "src/core.ts": Array.from({ length: 8 }, (_, i) => `src/m${i}.ts`) };
		const wide = score(input({ changes: [edit("src/core.ts")], importers }));
		expect(wide.reasons).toEqual(["blast radius: 8 files import what changed"]);
		expect(wide.level).toBe("low");

		const big = score(input({ changes: [edit("src/core.ts", 300, 200)], importers, evidence: { checks: "passed; coverage -3.5%" } }));
		expect(big.level).toBe("review");
		expect(big.reasons).toEqual(["blast radius: 8 files import what changed", "coverage dropped 3.5%", "large diff: 500 lines"]);
	});

	it("ignores importers that are part of the change itself", () => {
		const importers = { "src/a.ts": ["src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts", "src/f.ts"] };
		const changes = ["a", "b", "c", "d", "e", "f"].map((n) => edit(`src/${n}.ts`));
		expect(score(input({ changes, importers })).reasons).toEqual([]);
	});

	it("flags semantic overlap with lands since the fork, and deleting a module trunk imports", () => {
		const overlap = score(input({ overlaps: [{ path: "src/b.ts", via: "imports src/a.ts", sha: "abcdef0123", agent: "b" }] }));
		expect(overlap.level).toBe("review");
		expect(overlap.reasons).toEqual(["semantic overlap: landed since this fork, src/b.ts (b, abcdef01) imports src/a.ts"]);
		expect(overlap.group.key).toBe("semantic:src/");

		const del = score(input({ changes: [{ path: "src/a.ts", op: "delete", added: 0, removed: 3 }], importers: { "src/a.ts": ["src/b.ts"] } }));
		expect(del).toMatchObject({ level: "review", reasons: ["deletes src/a.ts, still imported by src/b.ts"] });
	});

	it("groups similar changes under one key", () => {
		const key = (...paths: string[]) => score(input({ changes: paths.map((p) => edit(p)) })).group;
		expect(key("package.json", "package-lock.json")).toEqual({ key: "dependencies", label: "dependency bumps" });
		expect(key("services/api/package.json")).toEqual({ key: "dependencies", label: "dependency bumps" });
		expect(key("README.md", "docs/guide.md").key).toBe("docs");
		expect(key(".github/workflows/a.yml")).toEqual({ key: "sensitive:CI config", label: "CI config changes" });
		expect(key("src/tower/a.ts", "src/tower/b.ts").key).toBe("area:src/tower/");
		expect(key("src/a.ts", "web/b.js").key).toBe("area:/");
	});
});

describe("evidence", () => {
	it("reads pass, fail and missing from the checks text", () => {
		expect(evidence(undefined).status).toBe("missing");
		expect(evidence({ request: "x" }).status).toBe("missing");
		expect(evidence({ checks: "ok" }).status).toBe("passing");
		expect(evidence("typecheck clean; Tests 110 passed (110), 0 failed").status).toBe("passing");
		expect(evidence({ checks: "Tests 2 failed | 108 passed" }).status).toBe("failing");
		expect(evidence({ checks: "src/a.ts(3,1): error TS2304: Cannot find name" }).status).toBe("failing");
		expect(evidence({ checks: "ran it by hand" }).status).toBe("unknown");
	});

	it("reads a coverage delta", () => {
		expect(evidence({ checks: "passed, coverage +1.2%" }).coverageDelta).toBe(1.2);
		expect(evidence({ checks: "coverage delta: -4%" }).coverageDelta).toBe(-4);
		expect(evidence({ checks: "coverage 85%" }).coverageDelta).toBeNull();
	});
});

describe("lineDelta", () => {
	it("counts added and removed lines", () => {
		expect(lineDelta(null, "a\nb\n")).toEqual({ added: 3, removed: 0 });
		expect(lineDelta("a\nb\nc", "a\nB\nc")).toEqual({ added: 1, removed: 1 });
		expect(lineDelta("a\nb", null)).toEqual({ added: 0, removed: 2 });
	});
});

describe("imports", () => {
	it("finds relative specifiers in import, export, dynamic import and require", () => {
		const src = `import { a } from "./a";
import type { B } from '../b.js';
import "./side";
export * from "./c";
const d = await import("./d");
const e = require("../e");
import { z } from "zod";`;
		expect(importSpecifiers(src).sort()).toEqual(["../b.js", "../e", "./a", "./c", "./d", "./side"]);
	});

	it("resolves specifiers the way TS and Node do", () => {
		const files = new Set(["src/a.ts", "src/b/index.ts", "src/c.mjs", "lib/d.js"]);
		expect(resolveImport("src/x.ts", "./a", files)).toBe("src/a.ts");
		expect(resolveImport("src/x.ts", "./a.js", files)).toBe("src/a.ts");
		expect(resolveImport("src/x.ts", "./b", files)).toBe("src/b/index.ts");
		expect(resolveImport("src/x.ts", "./c.mjs", files)).toBe("src/c.mjs");
		expect(resolveImport("src/deep/x.ts", "../../lib/d.js", files)).toBe("lib/d.js");
		expect(resolveImport("src/x.ts", "./missing", files)).toBeNull();
		expect(resolveImport("x.ts", "../../a", files)).toBeNull();
	});

	it("inverts an import graph", () => {
		const graph = new Map([
			["src/a.ts", []],
			["src/b.ts", ["./a"]],
			["src/c.ts", ["./a.js", "./b"]],
			["test/a.test.ts", ["../src/a"]],
		]);
		expect(importersOf(graph, ["src/a.ts", "src/b.ts", "src/new.ts"])).toEqual({
			"src/a.ts": ["src/b.ts", "src/c.ts", "test/a.test.ts"],
			"src/b.ts": ["src/c.ts"],
			"src/new.ts": [],
		});
	});
});
