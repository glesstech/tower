import { describe, expect, it } from "vitest";
import { ClaimTooBroad, claimsOverlap, covers, LIMITS, measure, parseClaim, suggest, tooBroad, warnings, words } from "../../src/claims";

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

// A trunk shaped like tower's own: most files under src/, a web/ UI, a few at the root.
const TRUNK = [
	...Array.from({ length: 20 }, (_, i) => `src/tower/m${i}.ts`),
	"src/claims.ts", "src/mcp.ts", "src/tower/plans.ts", "src/tower/events.ts",
	...Array.from({ length: 10 }, (_, i) => `web/w${i}.js`),
	"web/dashboard.js", "README.md", "wrangler.jsonc", "package.json",
];

describe("measure", () => {
	it("counts files per claim and for the plan, as shares of trunk", () => {
		const m = measure(["src/tower/", "README.md", "src/tower/plans.ts"].map(parseClaim), TRUNK);
		expect(m.trunk).toBe(TRUNK.length);
		expect(m.claims.map((c) => [c.path, c.files])).toEqual([["src/tower/", 22], ["README.md", 1], ["src/tower/plans.ts", 1]]);
		expect(m.files).toBe(23);
		expect(m.share).toBeCloseTo(23 / TRUNK.length, 3);
	});

	it("is zero for an empty trunk", () => {
		expect(measure([parseClaim("src/")], [])).toMatchObject({ files: 0, share: 0, trunk: 0 });
	});
});

describe("tooBroad", () => {
	const cov = (path: string) => measure([parseClaim(path)], TRUNK).claims[0];

	it("refuses a top-level directory, a large share of trunk, or too many files", () => {
		expect(tooBroad(cov("src/"))).toMatch(/covers 24 files/);
		expect(tooBroad(cov("web/"))).toMatch(/web\/` covers 11 files, 29% of trunk/);
		expect(tooBroad({ path: "x/y/", files: 41, share: 0.01 })).toMatch(/limit is 40/);
		expect(tooBroad({ path: "x/", files: 9, share: 0.01 })).toMatch(/whole top-level directory/);
	});

	it("allows files, and directories under the floor", () => {
		expect(tooBroad(cov("src/tower/plans.ts"))).toBeNull();
		expect(tooBroad({ path: "swarm/", files: 2, share: 0.5 })).toBeNull();
		expect(tooBroad({ path: "src/auth/", files: 9, share: 0.1 })).toBeNull();
	});

	it("takes per-trunk limits", () => {
		expect(tooBroad({ path: "src/auth/", files: 3, share: 0.01 }, { ...LIMITS, maxFiles: 2 })).toMatch(/limit is 2/);
		expect(tooBroad({ path: "src/", files: 24, share: 0.6 }, { maxFiles: 1000, maxShare: 1, minFiles: 1000 })).toBeNull();
	});
});

describe("ClaimTooBroad", () => {
	it("says what to claim instead, and how to override", () => {
		const err = new ClaimTooBroad([{ path: "src/", files: 24, share: 0.6, reason: "`src/` is big" }], ["src/claims.ts"], measure([], TRUNK));
		expect(err.message).toMatch(/^claim_too_broad: `src\/` is big\. Claim the files you will change instead, e\.g\. src\/claims\.ts/);
		expect(err.message).toMatch(/force: true/);
		expect(err.body).toMatchObject({ error: "claim_too_broad", suggested: ["src/claims.ts"], broad: [{ path: "src/" }] });
	});
});

describe("warnings", () => {
	const warn = (...claims: string[]) => warnings(claims.map(parseClaim), TRUNK);

	it("says nothing about paths on trunk, or new files in existing directories", () => {
		expect(warn("src/claims.ts", "src/tower/", "src/tower/new-module.ts", "CHANGELOG.md")).toEqual([]);
	});

	it("flags a new file whose directory does not exist either", () => {
		expect(warn("src/server/blob.ts")).toEqual([expect.stringMatching(/`src\/server\/blob\.ts` does not exist on trunk and neither does `src\/server\/`/)]);
	});

	it("flags a directory with no files on trunk", () => {
		expect(warn("public/")).toEqual([expect.stringMatching(/`public\/` has no files on trunk/)]);
	});

	it("flags a file claim naming a directory", () => {
		expect(warn("src/tower")).toEqual([expect.stringMatching(/is a directory on trunk/)]);
	});

	it("suggests a sibling with the same name and another extension", () => {
		expect(warn("wrangler.toml")).toEqual([expect.stringMatching(/did you mean `wrangler\.jsonc`/)]);
	});
});

describe("suggest", () => {
	it("ranks files whose names match the task first", () => {
		const got = suggest("Show plan events on the dashboard", TRUNK).map((s) => s.path);
		expect(got.slice(0, 3).sort()).toEqual(["src/tower/events.ts", "src/tower/plans.ts", "web/dashboard.js"]);
	});

	it("ranks a path the task names outright highest", () => {
		expect(suggest("touch up src/mcp.ts wording for plans", TRUNK)[0].path).toBe("src/mcp.ts");
	});

	it("learns from what lands of similar tasks changed, and stays within a claim", () => {
		const history = [{ task: "lease expiry heartbeat", paths: ["src/tower/m3.ts", "web/w1.js"] }];
		const got = suggest("Lease heartbeat for silent agents", TRUNK, history, { within: [parseClaim("src/")] });
		expect(got).toEqual([{ path: "src/tower/m3.ts", score: 2 }]);
	});

	it("returns nothing for a task that matches nothing", () => {
		expect(suggest("zzz", TRUNK)).toEqual([]);
	});
});

describe("words", () => {
	it("splits camelCase and punctuation, drops filler, short words and plurals", () => {
		expect(words("Fix the claimTooBroad error in plans.ts for #32 agents")).toEqual(["claim", "too", "broad", "error", "plan"]);
	});
});
