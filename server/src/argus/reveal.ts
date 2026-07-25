// AgentGlass Argus integration — reveal a path in the OS file manager.
//
// MIT © 2026 Zac Rieger. See NOTICE.md.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE SECURITY QUESTION, AND WHY inScope() IS THE WRONG GUARD HERE
//
// Every other write-ish capability upstream honours `inScope()` — an instance
// opened for one project must not reach into another repo. That guard cannot be
// used here: the whole point of the environment tier is that it watches the
// machine, not the project. Most of what it surfaces (a Firefox cache write, an
// unclaimed file in AppData) is by definition out of scope, and inScope() would
// refuse to reveal exactly the rows the tier exists to show.
//
// Blanket-allowing arbitrary paths is also wrong: it would turn a POST into
// "open any location on this machine", driven by whatever a caller invents.
//
// So the guard is an ALLOWLIST OF WHAT WE ALREADY OBSERVED. A path can be
// revealed only if the environment tier has a record of it — an env_events row,
// or a tool call that named it — or it is an ancestor directory of one. You can
// open what Argus saw, and nothing else. Nothing a caller invents passes.

import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";
import { db } from "../db.ts";
import { normalizePath } from "./paths";

export type RevealResult =
  | { ok: true; revealed: string; how: string }
  | { ok: false; error: string };

export const REVEAL_ENABLED = process.env.GLASSES_REVEAL_DISABLED !== "1";

/**
 * Turn a normalized path back into one the OS accepts.
 * `/c:/Users/x` → `C:\Users\x` on Windows; unchanged elsewhere.
 */
export function toNative(p: string): string {
  const drive = /^\/([a-zA-Z]):(\/.*)?$/.exec(p);
  if (drive) return drive[1].toUpperCase() + ":" + (drive[2] ?? "\\").replace(/\//g, "\\");
  return process.platform === "win32" ? p.replace(/\//g, "\\") : p;
}

/** Has the environment tier actually seen this path, or anything under it? */
export function isKnownPath(norm: string): boolean {
  const exact = db
    .query(`SELECT 1 AS ok FROM env_events WHERE path = ? LIMIT 1`)
    .get(norm) as { ok: number } | null;
  if (exact) return true;

  // A directory node in the map is synthesized from its children, so it never
  // appears as a row of its own — accept it when it is an ancestor of one.
  const under = db
    .query(`SELECT 1 AS ok FROM env_events WHERE path LIKE ? LIMIT 1`)
    .get(norm.replace(/([%_\\])/g, "\\$1") + "/%") as { ok: number } | null;
  if (under) return true;

  // The labeled half of the map comes from agentglass's tool calls, which are
  // not in env_events at all. Same question, other table.
  const tool = db.query(
    `SELECT 1 AS ok FROM events
      WHERE hook_event_type = 'PostToolUse'
        AND json_extract(payload, '$.tool_input.file_path') IS NOT NULL
        AND (
          replace(json_extract(payload, '$.tool_input.file_path'), '\\', '/') LIKE ?
          OR replace(json_extract(payload, '$.tool_input.file_path'), '\\', '/') LIKE ?
        )
      LIMIT 1`
  ).get("%" + norm.replace(/^\/[a-z]:/, "") , "%" + norm.replace(/^\/[a-z]:/, "") + "/%") as { ok: number } | null;
  return !!tool;
}

/**
 * Open the OS file manager at `p`, selecting the file where the platform
 * supports it.
 *
 * Windows `explorer` exits non-zero even when it succeeds, so its exit code is
 * deliberately ignored — treating it as failure would report an error for every
 * successful reveal.
 */
export function revealPath(pIn: unknown): RevealResult {
  if (!REVEAL_ENABLED) return { ok: false, error: "reveal is disabled (GLASSES_REVEAL_DISABLED=1)" };
  if (typeof pIn !== "string" || !pIn.trim()) return { ok: false, error: "invalid path" };

  const norm = normalizePath(pIn);
  if (!norm) return { ok: false, error: "invalid path" };
  if (norm.includes("\0")) return { ok: false, error: "invalid path" };
  if (!isKnownPath(norm)) {
    return { ok: false, error: "unknown path — only locations Argus has observed can be revealed" };
  }

  const native = toNative(norm);
  let isDir = false;
  try {
    isDir = statSync(native).isDirectory();
  } catch {
    // Gone since we recorded it. Fall back to its parent so the click still
    // lands somewhere useful rather than erroring on a file that was deleted.
    const parent = path.dirname(native);
    try {
      if (!statSync(parent).isDirectory()) return { ok: false, error: "path no longer exists" };
    } catch {
      return { ok: false, error: "path no longer exists" };
    }
    return spawnReveal(parent, true, norm);
  }
  return spawnReveal(native, isDir, norm);
}

function spawnReveal(native: string, isDir: boolean, norm: string): RevealResult {
  // argv arrays throughout — never a shell string, so a path containing quotes,
  // spaces or `&` cannot become a command.
  let cmd: string;
  let args: string[];
  if (process.platform === "win32") {
    cmd = "explorer.exe";
    args = isDir ? [native] : [`/select,${native}`];
  } else if (process.platform === "darwin") {
    cmd = "open";
    args = isDir ? [native] : ["-R", native];
  } else {
    cmd = "xdg-open";
    args = [isDir ? native : path.dirname(native)];
  }

  try {
    execFile(cmd, args, { windowsVerbatimArguments: process.platform === "win32" }, () => {
      /* explorer exits 1 on success; nothing here can be trusted as a status */
    });
    return { ok: true, revealed: norm, how: `${cmd} ${isDir ? "dir" : "select"}` };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}
