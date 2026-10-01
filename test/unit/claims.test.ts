import { describe, expect, it } from "vitest";
import { claimsOverlap, covers, parseClaim } from "../../src/claims";

describe("parseClaim", () => {
	it("parses a file claim", () => {
		expect(parseClaim("src/a.ts")).toEqual({ path: "src/a.ts", dir: false });
	});

	it("parses a directory claim by its trailing slash", () => {
		expect(parseClaim("src/auth/")).toEqual({ path: "src/auth/", dir: true });
	});

	it("accepts dir/** as a directory claim", () => {
		expect(parseClaim("src/auth/**")).toEqual({ path: "src/auth/", dir: true });
	});

	it("trims whitespace and leading ./ or /", () => {
		expect(parseClaim("  ./src/a.ts ")).toEqual({ path: "src/a.ts", dir: false });
		expect(parseClaim("/src/a.ts")).toEqual({ path: "src/a.ts", dir: false });
	});

	it.each(["../etc/passwd", "src/../secret", "src/*.ts", "src/**/a.ts", "**", "", "  ", "/"])("rejects %j", (raw) => {
		expect(() => parseClaim(raw)).toThrow(/invalid claim/);
	});
});

describe("claimsOverlap", () => {
	const c = parseClaim;

	it("overlaps equal files", () => {
		expect(claimsOverlap(c("src/a.ts"), c("src/a.ts"))).toBe(true);
	});

	it("overlaps equal directories", () => {
		expect(claimsOverlap(c("src/"), c("src/**"))).toBe(true);
	});

	it("overlaps a directory with a file inside it, in either order", () => {
		expect(claimsOverlap(c("src/"), c("src/deep/a.ts"))).toBe(true);
		expect(claimsOverlap(c("src/deep/a.ts"), c("src/"))).toBe(true);
	});

	it("overlaps nested directories", () => {
		expect(claimsOverlap(c("src/"), c("src/auth/"))).toBe(true);
	});

	it("does not overlap sibling directories", () => {
		expect(claimsOverlap(c("src/a/"), c("src/b/"))).toBe(false);
	});

	it("does not overlap different files", () => {
		expect(claimsOverlap(c("src/a.ts"), c("src/b.ts"))).toBe(false);
	});

	it("does not treat a path prefix as a directory", () => {
		expect(claimsOverlap(c("src/a"), c("src/ab"))).toBe(false);
		expect(claimsOverlap(c("src/a/"), c("src/ab"))).toBe(false);
		expect(claimsOverlap(c("src/a/"), c("src/ab/"))).toBe(false);
	});

	it("does not let a file claim cover paths beneath it", () => {
		expect(claimsOverlap(c("src/a"), c("src/a/b.ts"))).toBe(false);
	});
});

describe("covers", () => {
	const claims = ["src/auth/", "README.md"].map(parseClaim);

	it("covers files inside a claimed directory", () => {
		expect(covers(claims, "src/auth/session.ts")).toBe(true);
		expect(covers(claims, "src/auth/deep/x.ts")).toBe(true);
	});

	it("covers exactly a claimed file", () => {
		expect(covers(claims, "README.md")).toBe(true);
	});

	it("does not cover anything else", () => {
		expect(covers(claims, "README.md.bak")).toBe(false);
		expect(covers(claims, "src/authz.ts")).toBe(false);
		expect(covers(claims, "src/index.ts")).toBe(false);
		expect(covers([], "README.md")).toBe(false);
	});
});
