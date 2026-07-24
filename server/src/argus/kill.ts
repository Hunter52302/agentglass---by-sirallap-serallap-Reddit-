// Glasses for Argus — the kill switch.
//
// Origin: Argus src/kill.js — MIT © 2026 Zac Rieger. Ported to TypeScript.
//
// agentglass's gate can DENY a tool call. That refuses one action; the agent is
// free to try something else on its next call, and a genuinely hostile or
// runaway process is not stopped by being told no. This is the escalation:
// refuse the action AND force-stop the offending process and every task it
// spawned.
//
// Irreversible by design, and therefore never automatic unless a rule opts in
// explicitly (`"kill": true`) or a human clicks it.

import { execFileSync } from "node:child_process";

export interface KillResult {
  requested: number | null;
  killed: number[];
  failed: number[];
  skipped?: string;
}

/** Direct children of a pid. POSIX via pgrep; empty on Windows, where
 *  `taskkill /T` walks the tree itself. */
function childrenOf(pid: number): number[] {
  try {
    const out = execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" });
    return out.split("\n").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    return [];
  }
}

/** Depth-first pids of the whole subtree, deepest first, root last — so a
 *  parent cannot re-parent survivors before they die. */
export function processTree(pid: number, seen = new Set<number>()): number[] {
  const root = Number(pid);
  if (!Number.isInteger(root) || root <= 1 || seen.has(root)) return [];
  seen.add(root);
  const out: number[] = [];
  for (const c of childrenOf(root)) out.push(...processTree(c, seen));
  out.push(root);
  return out;
}

function killOne(pid: number): boolean {
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }
  try {
    process.kill(pid, "SIGKILL");
    return true;
  } catch {
    return false; // already gone, or not permitted
  }
}

/**
 * Kill the process tree rooted at `pid`.
 *
 * Refuses pid <= 1, itself, and its own parent. An observer that can be talked
 * into killing its own launcher is a denial-of-service primitive, and one that
 * kills itself stops being able to report what it just did.
 */
export function killTree(pid: number | null | undefined): KillResult {
  const root = Number(pid);
  const self = process.pid;
  const parent = typeof process.ppid === "number" ? process.ppid : -1;
  if (!Number.isInteger(root) || root <= 1) {
    return { requested: Number.isFinite(root) ? root : null, killed: [], failed: [], skipped: "invalid-pid" };
  }
  if (root === self || root === parent) {
    return { requested: root, killed: [], failed: [], skipped: "refuses-self-or-parent" };
  }

  const pids = processTree(root).filter((p) => p !== self && p !== parent && p > 1);
  const killed: number[] = [];
  const failed: number[] = [];
  // On Windows `taskkill /T` already handles the tree from the root.
  const targets = process.platform === "win32" ? [root] : pids;
  for (const p of targets) (killOne(p) ? killed : failed).push(p);
  return { requested: root, killed, failed };
}
