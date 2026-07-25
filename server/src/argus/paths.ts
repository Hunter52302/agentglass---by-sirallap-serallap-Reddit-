// AgentGlass Argus integration — path normalization.
//
// Origin: Argus src/paths.js (§12.2) — MIT © 2026 Zac Rieger.
// Ported verbatim to TypeScript; logic unchanged.
//
// One canonical id per file across OSes: forward slashes only, drive letters
// lowercased and kept as a root segment (`C:\Users\x` → `/c:/Users/x`), UNC
// hosts kept as `//server/share`. Every path entering the environment tier
// routes through this, so a Windows-style path can never mint a second node
// for the same file.

export function normalizePath(p: string | null | undefined): string | null {
  if (p == null || p === '') return (p as null) ?? null;
  let s = String(p).replace(/\\/g, '/');
  const unc = s.startsWith('//') && s.length > 2 && s[2] !== '/';
  s = s.replace(/\/{2,}/g, '/');
  if (unc) s = '/' + s; // //server/share/...
  const drive = /^([A-Za-z]):($|\/.*)/.exec(s);
  if (drive) s = '/' + drive[1].toLowerCase() + ':' + drive[2];
  if (s.length > 1) s = s.replace(/\/+$/, '') || '/';
  return s;
}

/** Separator-agnostic containment: is `child` the same as or inside `parent`? */
export function isUnder(child: string, parent: string): boolean {
  const c = normalizePath(child);
  const par = normalizePath(parent);
  if (c == null || par == null) return false;
  return c === par || c.startsWith(par.endsWith('/') ? par : par + '/');
}
