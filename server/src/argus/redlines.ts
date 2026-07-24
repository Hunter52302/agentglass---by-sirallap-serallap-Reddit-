// Glasses for Argus — server-side redline rules on top of agentglass's gate.
//
// Origin: Argus src/redlines.js — MIT © 2026 Zac Rieger.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS ADDS, AND WHY IT SITS *IN FRONT OF* /gate RATHER THAN REPLACING IT
//
// agentglass's gate is the better transport, and it is not close: requests are
// persisted to SQLite on arrival, survive a restart (restoreGates), and a hook
// whose connection dropped can re-attach by id. Argus's gate is in-memory, so a
// restart silently strands every pending decision. None of that is re-litigated
// here — /gate stays exactly as it is.
//
// What agentglass has no notion of is POLICY. Its gate holds whatever the hook
// chooses to send, so "what is dangerous" lives in each project's settings.json
// matcher, scattered and unauditable. Argus evaluates rules server-side: one
// file, action/target regexes, path-prefix exemptions, and rules that carry
// their own escalation. That is the half worth porting.
//
// The two compose cleanly:
//
//   rule matches + kill:true  → deny and kill NOW, no human wait
//   rule matches              → hand to agentglass's gate, tagged with the rule
//   no rule matches           → hand to agentglass's gate unchanged (its call)
//
// So a project already using /gate keeps its exact behaviour, and a redline
// only ever makes the gate stricter — never looser.

import fs from "node:fs";
import path from "node:path";
import { normalizePath, isUnder } from "./paths";
import { killTree, type KillResult } from "./kill";

export interface RedlineRule {
  id: string;
  description: string;
  action: RegExp | null;
  target: RegExp | null;
  not_target_prefix: string | null;
  /** Opt-in auto kill-switch: matching denies AND force-stops the process tree
   *  immediately, without waiting for a human. */
  kill: boolean;
}

export interface RedlineMatch {
  id: string;
  description: string;
  kill: boolean;
}

const RULES_FILE =
  process.env.GLASSES_REDLINES || path.join(process.cwd(), "..", "redlines.json");

let rules: RedlineRule[] = [];
let loadedFrom: string | null = null;
let loadError: string | null = null;

/**
 * (Re)read rules, substituting ${WATCH_DIR}.
 *
 * A missing file is not an error — it means "no redlines", and the gate behaves
 * exactly as upstream. A MALFORMED file is different and is surfaced: silently
 * allowing everything because someone fumbled a regex is the failure mode a
 * security control must not have.
 */
export function reloadRedlines(watchDir: string | null = null): void {
  rules = [];
  loadError = null;
  loadedFrom = null;
  let raw: string;
  try {
    raw = fs.readFileSync(RULES_FILE, "utf8");
  } catch {
    return; // no rules file — not an error
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("expected a JSON array of rules");
    rules = parsed.map((r: any) => ({
      id: String(r.id ?? "unnamed"),
      description: String(r.description || r.id || "unnamed"),
      action: r.action ? new RegExp(r.action, "i") : null,
      target: r.target ? new RegExp(r.target, "i") : null,
      not_target_prefix: r.not_target_prefix
        ? normalizePath(String(r.not_target_prefix).replace("${WATCH_DIR}", watchDir ?? ""))
        : null,
      kill: r.kill === true,
    }));
    loadedFrom = RULES_FILE;
  } catch (e: any) {
    loadError = e?.message ?? String(e);
    console.error(`[argus/redlines] cannot load ${RULES_FILE}: ${loadError} — no redlines active`);
  }
}

reloadRedlines();

export function redlineStatus() {
  return {
    file: RULES_FILE,
    loaded_from: loadedFrom,
    error: loadError,
    rules: rules.map((r) => ({
      id: r.id,
      description: r.description,
      action: r.action?.source ?? null,
      target: r.target?.source ?? null,
      kill: r.kill,
    })),
  };
}

/** First matching rule, or null. An entirely empty rule matches nothing —
 *  otherwise a typo'd rule silently gates the whole fleet. */
export function evaluate(proposed: { action: string; target: string }): RedlineRule | null {
  const action = String(proposed.action || "");
  const target = String(proposed.target || "");
  for (const r of rules) {
    if (!r.action && !r.target && !r.not_target_prefix) continue;
    if (r.action && !r.action.test(action)) continue;
    if (r.target && !r.target.test(target)) continue;
    // Prefix exemptions compare NORMALIZED paths, so a Windows-style target
    // inside the watched tree is exempt on any OS.
    if (r.not_target_prefix && isUnder(target, r.not_target_prefix)) continue;
    return r;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Side table: what agentglass's gate does not carry.
//
// Deliberately kept HERE rather than added to gate.ts, so upstream's control
// plane stays byte-identical. Keyed by the gate id the hook generates, which is
// the same id /gate/decide uses — so the two tables always agree on which
// request is which without either knowing about the other.

export interface GateExtra {
  pid: number | null;
  rule: RedlineMatch | null;
  created: number;
}

const extras = new Map<string, GateExtra>();

/** Bound so a long-running server cannot accumulate entries for gates whose
 *  decision path never came back through us. */
const MAX_EXTRAS = 500;

export function noteGate(id: string, extra: GateExtra): void {
  extras.set(id, extra);
  if (extras.size > MAX_EXTRAS) {
    const oldest = [...extras.entries()].sort((a, b) => a[1].created - b[1].created)[0];
    if (oldest) extras.delete(oldest[0]);
  }
}

export function gateExtra(id: string): GateExtra | null {
  return extras.get(id) ?? null;
}

export function forgetGate(id: string): void {
  extras.delete(id);
}

/** Is this held request killable — i.e. did the hook tell us what to stop? */
export function killableGates(): Array<{ id: string; pid: number; rule: RedlineMatch | null }> {
  return [...extras.entries()]
    .filter(([, e]) => e.pid != null)
    .map(([id, e]) => ({ id, pid: e.pid as number, rule: e.rule }));
}

export function killGate(id: string): KillResult {
  const e = extras.get(id);
  const res = killTree(e?.pid ?? null);
  forgetGate(id);
  return res;
}

export { killTree };
export type { KillResult };
