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
