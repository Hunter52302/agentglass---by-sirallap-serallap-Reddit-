// Glasses for Argus — scoped containment.
//
// Origin: Argus src/kill.js — MIT © 2026 Zac Rieger. Ported to TypeScript.
//
// Argus may stop an agent, an agent descendant, or a process explicitly attached
// to a recorded shell/gate. This is containment of agent-associated activity,
// not a general-purpose host process manager.

import { execFileSync } from "node:child_process";

export interface KillResult {
  requested: number | null;
  killed: number[];
  failed: number[];
  skipped?: string;
}

/** Direct children of a pid. POSIX via pgrep; Windows taskkill /T walks the tree. */
function childrenOf(pid: number): number[] {
  try {
    const out = execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" });
    return out.split("\n").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    return [];
  }
}

/** Depth-first pids, deepest first, root last. */
export function processTree(pid: number, seen = new Set<number>()): number[] {
  const root = Number(pid);
  if (!Number.isInteger(root) || root <= 1 || seen.has(root)) return [];
  seen.add(root);
  const out: number[] = [];
  for (const child of childrenOf(root)) out.push(...processTree(child, seen));
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
    return false;
  }
}

/**
 * Stop the process tree rooted at pid.
 *
 * Callers must establish that the pid belongs to an agent, its descendants, an
 * explicitly attached shell, or a gated action. This low-level function also
 * refuses pid 0/1, the Argus process, and Argus's parent.
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
  const targets = process.platform === "win32" ? [root] : pids;
  for (const target of targets) (killOne(target) ? killed : failed).push(target);
  return { requested: root, killed, failed };
}
