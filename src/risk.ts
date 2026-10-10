// Review by exception: score each land by how much could go wrong, so low-risk changes land on
// their own and only the rest reach a human. Pure logic; src/tower/review.ts gathers the inputs
// (what changed, who imports it on trunk, what landed since the fork) and keeps the inbox.
//
//   blast radius   files on trunk that import what the change touched
//   sensitive      auth, billing, CI config, migrations, deploy config, secrets
//   evidence       the agent's checks: missing, failing, or a coverage drop
//   diff size      lines and files changed
//   semantic       leases stop textual conflicts, not semantic ones: a land since this fork's
//                  base touched a file that imports, or is imported by, what this change touched
//                  (A changes a signature in a.ts while B adds a call in b.ts), or the change
//                  deletes a module trunk still imports
//
// Any "hard" reason (sensitive path, failing checks, semantic overlap) sends the change to
// review whatever its score.

export type FileChange = { path: string; op: "upsert" | "delete"; added: number; removed: number };

export type Overlap = { path: string; via: string; sha: string; agent: string };

export type RiskInput = {
	changes: FileChange[];
	// Changed path -> trunk files that import it.
	importers: Record<string, string[]>;
	// Lands since the fork's base that touched a neighbor of this change.
	overlaps: Overlap[];
	evidence: unknown;
};

export type Risk = {
	score: number;
	level: "low" | "review";
	reasons: string[];
	group: { key: string; label: string };
};

export const REVIEW_THRESHOLD = 40;

const SENSITIVE: [RegExp, string][] = [
	[/(^|\/)(auth|authn|authz|oauth|session|sessions|security|crypto|secrets?|permissions?|access)(\/|\.|$)/i, "auth"],
	[/(^|\/)(billing|payments?|invoices?|stripe|checkout|subscriptions?)(\/|\.|$)/i, "billing"],
	[/(^|\/)(\.github\/workflows|\.circleci|\.buildkite)\/|(^|\/)(\.gitlab-ci\.ya?ml|Jenkinsfile|\.travis\.ya?ml)$/, "CI config"],
	[/(^|\/)(migrations?|migrate)\//i, "migrations"],
	[/(^|\/)(wrangler\.(toml|jsonc?)|Dockerfile|docker-compose\.ya?ml)$/, "deploy config"],
	[/(^|\/)\.env(\.|$)/, "secrets"],
];

const DEPENDENCY = /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|go\.(mod|sum)|Cargo\.(toml|lock)|requirements[^/]*\.txt|poetry\.lock|Pipfile(\.lock)?|Gemfile(\.lock)?|composer\.(json|lock))$/;
const DOCS = /(^|\/)docs?\/|\.(md|mdx|txt|rst)$|(^|\/)LICENSE$/i;
const TESTS = /(^|\/)(test|tests|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$/;

export function score(input: RiskInput): Risk {
	const reasons: string[] = [];
	let points = 0;
	let hard = false;
	const paths = input.changes.map((c) => c.path);
	const changed = new Set(paths);

	// Blast radius: distinct importers outside the change itself.
	const importers = new Set(Object.values(input.importers).flat().filter((p) => !changed.has(p)));
	points += Math.min(importers.size * 3, 30);
	if (importers.size >= 5) reasons.push(`blast radius: ${importers.size} files import what changed`);

	const deletedButImported = input.changes.filter(
		(c) => c.op === "delete" && (input.importers[c.path] ?? []).some((p) => !changed.has(p)),
	);
	for (const c of deletedButImported) {
		hard = true;
		reasons.push(`deletes ${c.path}, still imported by ${input.importers[c.path].filter((p) => !changed.has(p)).join(", ")}`);
	}

	const sensitive = sensitiveAreas(paths);
	if (sensitive.length) {
		hard = true;
		points += 40;
		reasons.push(`sensitive: ${sensitive.map(([area, p]) => `${area} (${p})`).join(", ")}`);
	}

	const ev = evidence(input.evidence);
	if (ev.status === "missing") {
		points += 15;
		reasons.push("no test evidence");
	} else if (ev.status === "failing") {
		hard = true;
		points += 50;
		reasons.push("checks reported failures");
	}
	if (ev.coverageDelta !== null && ev.coverageDelta < -1) {
		points += 15;
		reasons.push(`coverage dropped ${Math.abs(ev.coverageDelta)}%`);
	}

	const lines = input.changes.reduce((n, c) => n + c.added + c.removed, 0);
	if (lines > 400) {
		points += 30;
		reasons.push(`large diff: ${lines} lines`);
	} else if (lines > 150) {
		points += 15;
		reasons.push(`diff: ${lines} lines`);
	}
	if (input.changes.length > 20) {
		points += 10;
		reasons.push(`${input.changes.length} files`);
	}

	if (input.overlaps.length) {
		hard = true;
		points += 50;
		const shown = input.overlaps.slice(0, 3).map((o) => `${o.path} (${o.agent}, ${o.sha.slice(0, 8)}) ${o.via}`);
		const more = input.overlaps.length > 3 ? ` and ${input.overlaps.length - 3} more` : "";
		reasons.push(`semantic overlap: landed since this fork, ${shown.join("; ")}${more}`);
	}

	const level = hard || points >= REVIEW_THRESHOLD ? "review" : "low";
	return { score: Math.min(points, 100), level, reasons, group: group(paths, sensitive, input.overlaps.length > 0) };
}

function sensitiveAreas(paths: string[]): [string, string][] {
	const found: [string, string][] = [];
	for (const p of paths) {
		const hit = SENSITIVE.find(([re]) => re.test(p));
		if (hit && !TESTS.test(p) && !found.some(([area]) => area === hit[1])) found.push([hit[1], p]);
	}
	return found;
}

// Similar changes share a key, so a human decides them together ("40 dependency bumps").
function group(paths: string[], sensitive: [string, string][], semantic: boolean): { key: string; label: string } {
	if (paths.every((p) => DEPENDENCY.test(p))) return { key: "dependencies", label: "dependency bumps" };
	if (paths.every((p) => DOCS.test(p))) return { key: "docs", label: "docs changes" };
	if (paths.every((p) => TESTS.test(p))) return { key: "tests", label: "test-only changes" };
	const area = topArea(paths);
	if (semantic) return { key: `semantic:${area}`, label: `semantic overlaps in ${area}` };
	if (sensitive.length) {
		const areas = sensitive.map(([a]) => a).sort().join("+");
		return { key: `sensitive:${areas}`, label: `${areas} changes` };
	}
	return { key: `area:${area}`, label: `changes in ${area}` };
}

// A group's label with its count: "3 CI config changes", "1 CI config change". Labels from
// group() are plural; stored reviews carry them as they were scored, so this reads either.
export function counted(n: number, label: string): string {
	return `${n} ${n === 1 ? label.replace(/\b(bump|change|overlap)s\b/, "$1") : label}`;
}

// The deepest directory (up to two levels) shared by every path, or "/" for the root.
function topArea(paths: string[]): string {
	const dirs = paths.map((p) => p.split("/").slice(0, -1).slice(0, 2));
	const common: string[] = [];
	for (let i = 0; i < 2; i++) {
		const seg = dirs[0]?.[i];
		if (!seg || dirs.some((d) => d[i] !== seg)) break;
		common.push(seg);
	}
	return common.length ? `${common.join("/")}/` : "/";
}

export type Evidence = { status: "missing" | "passing" | "failing" | "unknown"; coverageDelta: number | null };

// The agent's `checks` text (or a plain-string evidence). "0 failed" and "no errors" pass.
export function evidence(raw: unknown): Evidence {
	const text =
		typeof raw === "string" ? raw : raw && typeof raw === "object" && typeof (raw as any).checks === "string" ? (raw as any).checks : "";
	if (!text.trim()) return { status: "missing", coverageDelta: null };
	const cov = text.match(/coverage[^\n]*?([+-]\s?\d+(?:\.\d+)?)\s*%/i);
	const coverageDelta = cov ? Number(cov[1].replace(/\s/g, "")) : null;
	const failing =
		/\b[1-9]\d*\s+(failed|failing|failures?|errors?)\b/i.test(text) ||
		/\b(failed|failing|fails)\s*[:=]\s*[1-9]/i.test(text) ||
		/\berror TS\d+|\bnpm ERR!|\bexit(ed)?( code)? [1-9]\d*\b|\bFAIL\b/.test(text);
	if (failing) return { status: "failing", coverageDelta };
	const passing = /\b(pass(ed|es|ing)?|ok|success(ful)?|green|clean|✓|0 (errors?|failed|failures?))\b/i.test(text);
	return { status: passing ? "passing" : "unknown", coverageDelta };
}

// Lines added and removed between two versions of a text file (a line-multiset diff: cheap,
// and exact enough to size a change).
export function lineDelta(before: string | null, after: string | null): { added: number; removed: number } {
	const a = before ? before.split("\n") : [];
	const b = after ? after.split("\n") : [];
	const counts = new Map<string, number>();
	for (const l of a) counts.set(l, (counts.get(l) ?? 0) + 1);
	let added = 0;
	for (const l of b) {
		const n = counts.get(l) ?? 0;
		if (n > 0) counts.set(l, n - 1);
		else added++;
	}
	let removed = 0;
	for (const n of counts.values()) removed += n;
	return { added, removed };
}

export const SOURCE = /\.(m?[jt]sx?|c[jt]s)$/;

// Relative module specifiers in a JS/TS source: import/export ... from, import(), require().
export function importSpecifiers(text: string): string[] {
	const out = new Set<string>();
	const re = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["'](\.{1,2}\/[^"']*|\.{1,2})["']/gm;
	for (const m of text.matchAll(re)) out.add(m[1]);
	return [...out];
}

const EXTENSIONS = [".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs", ".cjs", "/index.ts", "/index.tsx", "/index.js", "/index.mjs"];

// Resolve a relative specifier from `from` to a path in `files`, the way TS/Node would for
// the common cases (extensionless, "./x.js" meaning x.ts, directory index).
export function resolveImport(from: string, spec: string, files: Set<string>): string | null {
	const parts = from.split("/").slice(0, -1);
	for (const seg of spec.split("/")) {
		if (seg === "" || seg === ".") continue;
		if (seg === "..") {
			if (!parts.length) return null;
			parts.pop();
		} else parts.push(seg);
	}
	const base = parts.join("/");
	if (files.has(base)) return base;
	const stem = base.replace(/\.([cm]?js|jsx)$/, "");
	for (const ext of EXTENSIONS) if (files.has(stem + ext)) return stem + ext;
	for (const ext of EXTENSIONS) if (files.has(base + ext)) return base + ext;
	return null;
}

// Invert an import graph: for each target, the files that import it.
export function importersOf(graph: Map<string, string[]>, targets: string[]): Record<string, string[]> {
	const files = new Set(graph.keys());
	const wanted = new Set(targets);
	const out: Record<string, string[]> = Object.fromEntries(targets.map((t) => [t, []]));
	for (const [file, specs] of graph) {
		for (const spec of specs) {
			const hit = resolveImport(file, spec, files);
			if (hit && wanted.has(hit) && hit !== file && !out[hit].includes(file)) out[hit].push(file);
		}
	}
	return out;
}
