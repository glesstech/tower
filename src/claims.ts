// Claims are the airspace a flight plan reserves. v1 granularity is paths:
//   "src/auth/session.ts"  -> exactly that file
//   "src/auth/"            -> everything under that directory ("src/auth/**" is accepted too)
// Symbol-level claims (via a tree-sitter planning pass) are a later layer on top of this.

export type Claim = { path: string; dir: boolean };

export function parseClaim(raw: string): Claim {
	let path = raw.trim().replace(/^\.?\/+/, "");
	if (path.endsWith("/**")) path = path.slice(0, -2);
	if (!path || path.includes("..") || path.includes("*")) {
		throw new Error(`invalid claim: ${raw}`);
	}
	return { path, dir: path.endsWith("/") };
}

export function claimsOverlap(a: Claim, b: Claim): boolean {
	if (a.path === b.path) return true;
	if (a.dir && b.path.startsWith(a.path)) return true;
	if (b.dir && a.path.startsWith(b.path)) return true;
	return false;
}

export function covers(claims: Claim[], filePath: string): boolean {
	return claims.some((c) => (c.dir ? filePath.startsWith(c.path) : filePath === c.path));
}

// ── claim hygiene ───────────────────────────────────────────────────────────
// A lease is only as good as the claim behind it: one agent claiming "src/" queues everyone
// else behind it. So each claim is measured against trunk's file list. One that covers too much
// is refused (unless forced) with a narrower set to claim instead, and paths that look guessed
// (nothing like them on trunk) come back as warnings, since creating files is legitimate.

// Per trunk, from meta (see plans.ts). A claim is too broad when it covers more than maxFiles,
// or, once it covers at least minFiles, more than maxShare of trunk or a whole top-level
// directory. The floor keeps small repos and small directories claimable.
export type Limits = { maxFiles: number; maxShare: number; minFiles: number };
export const LIMITS: Limits = { maxFiles: 40, maxShare: 0.15, minFiles: 8 };

export type Coverage = { path: string; files: number; share: number };
export type Measure = { files: number; share: number; trunk: number; claims: Coverage[] };

// Files each claim covers, and the plan's total, as counts and shares of trunk.
export function measure(claims: Claim[], paths: string[]): Measure {
	const share = (n: number) => (paths.length ? Math.round((n / paths.length) * 1000) / 1000 : 0);
	const each = claims.map((c) => {
		const files = paths.filter((p) => covers([c], p)).length;
		return { path: c.path, files, share: share(files) };
	});
	const files = paths.filter((p) => covers(claims, p)).length;
	return { files, share: share(files), trunk: paths.length, claims: each };
}

// Why a measured claim is too broad, or null if it isn't.
export function tooBroad(c: Coverage, limits: Limits = LIMITS): string | null {
	const pct = `${Math.round(c.share * 100)}%`;
	if (c.files > limits.maxFiles) return `\`${c.path}\` covers ${c.files} files (${pct} of trunk); the limit is ${limits.maxFiles}`;
	if (c.files < limits.minFiles) return null;
	if (c.share > limits.maxShare) return `\`${c.path}\` covers ${c.files} files, ${pct} of trunk; the limit is ${Math.round(limits.maxShare * 100)}%`;
	if (/^[^/]+\/$/.test(c.path)) return `\`${c.path}\` is a whole top-level directory (${c.files} files)`;
	return null;
}

// A refused claim set, with what to claim instead. Thrown by file and amend.
export class ClaimTooBroad extends Error {
	constructor(
		readonly broad: (Coverage & { reason: string })[],
		readonly suggested: string[],
		readonly coverage: Measure,
	) {
		const reasons = broad.map((b) => b.reason).join("; ");
		const instead = suggested.length
			? `Claim the files you will change instead, e.g. ${suggested.join(", ")}`
			: `Claim the specific files under ${broad.map((b) => `\`${b.path}\``).join(", ")} that you will change instead`;
		super(
			`claim_too_broad: ${reasons}. ${instead}; add files you will create by exact path, and grow the lease with amend_claims as you go. ` +
				"Pass force: true to claim it anyway (counted, and shown on the dashboard).",
		);
	}

	get body() {
		return { error: "claim_too_broad", message: this.message, broad: this.broad, suggested: this.suggested, coverage: this.coverage };
	}
}

// Claims that look guessed: nothing on trunk at or near the path. Not errors (a new file is
// a legitimate claim), but worth a second look before the agent finds out at land time.
export function warnings(claims: Claim[], paths: string[]): string[] {
	const files = new Set(paths);
	const isDir = (dir: string) => paths.some((p) => p.startsWith(dir));
	const out: string[] = [];
	for (const c of claims) {
		if (c.dir) {
			if (!isDir(c.path)) out.push(`\`${c.path}\` has no files on trunk; check the tree unless you will create this directory`);
			continue;
		}
		if (files.has(c.path)) continue;
		if (isDir(`${c.path}/`)) {
			out.push(`\`${c.path}\` is a directory on trunk, and a file claim covers nothing in it; claim the files under \`${c.path}/\` you will change`);
			continue;
		}
		const slash = c.path.lastIndexOf("/");
		const parent = c.path.slice(0, slash + 1);
		if (parent && !isDir(parent)) {
			out.push(`\`${c.path}\` does not exist on trunk and neither does \`${parent}\`; check the path unless you will create both`);
			continue;
		}
		const stem = (p: string) => p.slice(p.lastIndexOf("/") + 1).replace(/\.[^.]*$/, "");
		const like = paths.filter((p) => p.slice(0, p.lastIndexOf("/") + 1) === parent && stem(p) === stem(c.path));
		if (like.length) out.push(`\`${c.path}\` does not exist on trunk; did you mean ${like.map((p) => `\`${p}\``).join(" or ")}?`);
	}
	return out;
}

// Trunk files ranked for a task: words of the task that match a file's name or directories,
// paths the task names outright, and files that past lands of similar tasks changed (newest
// first in `history`). Optionally only files under `within`.
export function suggest(
	task: string,
	paths: string[],
	history: { task: string; paths: string[] }[] = [],
	opts: { within?: Claim[]; limit?: number } = {},
): { path: string; score: number }[] {
	const pool = opts.within ? paths.filter((p) => covers(opts.within!, p)) : paths;
	const want = words(task);
	const score = new Map<string, number>();
	const add = (p: string, n: number) => n > 0 && score.set(p, (score.get(p) ?? 0) + n);
	for (const p of pool) {
		if (task.includes(p)) add(p, 10);
		const segments = p.split("/");
		const name = new Set(words(segments.pop()!));
		const dirs = new Set(segments.flatMap(words));
		add(p, want.filter((w) => name.has(w)).length * 3 + want.filter((w) => dirs.has(w)).length);
	}
	const inPool = new Set(pool);
	history.slice(0, 200).forEach((land, i) => {
		const shared = words(land.task).filter((w) => want.includes(w)).length;
		if (!shared) return;
		const recency = 1 - i / 400;
		for (const p of land.paths) if (inPool.has(p)) add(p, shared * recency);
	});
	return [...score]
		.map(([path, s]) => ({ path, score: Math.round(s * 100) / 100 }))
		.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
		.slice(0, opts.limit ?? 10);
}

const STOP = new Set(
	"the and for with that this from into when then than not are was were will can should would add adds fix make use show issue github agent agents run new one per its via all any".split(" "),
);

// Lowercase words of three letters or more, split on punctuation and camelCase, minus filler.
export function words(text: string): string[] {
	const out = text
		.replace(/([a-z])([A-Z])/g, "$1 $2")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w))
		.map((w) => (w.length > 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w));
	return [...new Set(out)];
}
