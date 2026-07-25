// Glasses for Argus — user-defined server-side redline policy.
//
// MIT © 2026 Zac Rieger. See NOTICE.md.
//
// Redlines are intentionally operator-owned. Argus provides the matching and
// containment machinery; the user decides which commands, paths, and file
// operations cross a line. Rules remain additive to AgentGlass's durable gate:
// they may hold, deny, or deny-and-kill, but never grant an action the existing
// gate would otherwise refuse.

import fs from "node:fs";
import path from "node:path";
import { normalizePath, isUnder } from "./paths";
import { killTree, type KillResult } from "./kill";

export type RedlineKind = "command" | "path" | "file" | "any";
export type RedlineDecision = "flag" | "gate" | "kill";

export interface RedlineRuleDocument {
  id: string;
  description?: string;
  enabled?: boolean;
  kind?: RedlineKind;
  /** Regex matched against the tool/action name, such as Bash, Write or Edit. */
  action?: string | null;
  /** Regex matched against command text, path, or the gate summary. */
  target?: string | null;
  /** File operations accepted by a protected-path rule. */
  operations?: Array<"create" | "write" | "delete">;
  /** Exact path or directory prefix. Supports ${WATCH_DIR}. */
  protected_path?: string | null;
  /** Exemption prefix retained for compatibility with the first redline format. */
  not_target_prefix?: string | null;
  /** flag = report only; gate = require/force denial; kill = deny and stop tree. */
  decision?: RedlineDecision;
  /** Compatibility alias for decision=kill. */
  kill?: boolean;
}

export interface RedlineRule {
  id: string;
  description: string;
  enabled: boolean;
  kind: RedlineKind;
  action: RegExp | null;
  target: RegExp | null;
  operations: Set<string>;
  protected_path: string | null;
  not_target_prefix: string | null;
  decision: RedlineDecision;
  kill: boolean;
  document: RedlineRuleDocument;
}

export interface RedlineMatch {
  id: string;
  description: string;
  decision: RedlineDecision;
  kill: boolean;
}

export interface ObservationRedlineResult {
  rule: RedlineMatch;
  /** A plain fs.watch event has no writer PID, so kill may be requested but is
   * not executable until another sensor supplies a verified actor. */
  containment_available: boolean;
}

const RULES_FILE =
  process.env.GLASSES_REDLINES || path.join(process.cwd(), "..", "redlines.json");

let rules: RedlineRule[] = [];
let documents: RedlineRuleDocument[] = [];
let loadedFrom: string | null = null;
let loadError: string | null = null;
let currentWatchDir: string | null = null;

function compile(raw: RedlineRuleDocument, watchDir: string | null): RedlineRule {
  const id = String(raw.id || "").trim();
  if (!id) throw new Error("every redline requires a non-empty id");
  const decision: RedlineDecision = raw.kill === true ? "kill" : raw.decision ?? "gate";
  if (!["flag", "gate", "kill"].includes(decision)) {
    throw new Error(`redline ${id}: decision must be flag, gate, or kill`);
  }
  const subst = (value: string | null | undefined) =>
    value ? String(value).replaceAll("${WATCH_DIR}", watchDir ?? "") : null;
  const protectedPath = subst(raw.protected_path);
  return {
    id,
    description: String(raw.description || id),
    enabled: raw.enabled !== false,
    kind: raw.kind ?? (protectedPath ? "file" : "any"),
    action: raw.action ? new RegExp(raw.action, "i") : null,
    target: raw.target ? new RegExp(raw.target, "i") : null,
    operations: new Set((raw.operations ?? ["create", "write", "delete"]).map(String)),
    protected_path: protectedPath ? normalizePath(protectedPath) : null,
    not_target_prefix: raw.not_target_prefix
      ? normalizePath(subst(raw.not_target_prefix)!)
      : null,
    decision,
    kill: decision === "kill",
    document: { ...raw, id, decision, kill: undefined },
  };
}

function writeDocuments(next: RedlineRuleDocument[]): void {
  const dir = path.dirname(RULES_FILE);
  fs.mkdirSync(dir, { recursive: true });
  const temp = `${RULES_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(temp, RULES_FILE);
}

/** Missing file means no policy. Malformed policy is surfaced and activates no
 * rules rather than silently using a partially parsed security configuration. */
export function reloadRedlines(watchDir: string | null = currentWatchDir): void {
  currentWatchDir = watchDir;
  rules = [];
  documents = [];
  loadError = null;
  loadedFrom = null;
  let raw: string;
  try {
    raw = fs.readFileSync(RULES_FILE, "utf8");
  } catch {
    return;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("expected a JSON array of rules");
    documents = parsed.map((r) => ({ ...r }));
    rules = documents.map((r) => compile(r, watchDir));
    loadedFrom = RULES_FILE;
  } catch (e: any) {
    loadError = e?.message ?? String(e);
    rules = [];
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
      enabled: r.enabled,
      kind: r.kind,
      action: r.action?.source ?? null,
      target: r.target?.source ?? null,
      operations: [...r.operations],
      protected_path: r.protected_path,
      decision: r.decision,
      kill: r.kill,
    })),
  };
}

/** Create or replace one user-owned rule and persist it atomically. */
export function upsertRedline(input: RedlineRuleDocument, watchDir: string | null = currentWatchDir) {
  // Compile first so a bad regex never corrupts the live file.
  compile(input, watchDir);
  const id = String(input.id).trim();
  const next = documents.filter((r) => String(r.id).trim() !== id);
  next.push({ ...input, id });
  writeDocuments(next);
  reloadRedlines(watchDir);
  if (loadError) throw new Error(loadError);
  return redlineStatus();
}

export function deleteRedline(id: string, watchDir: string | null = currentWatchDir) {
  const key = String(id).trim();
  const next = documents.filter((r) => String(r.id).trim() !== key);
  if (next.length === documents.length) return { found: false, ...redlineStatus() };
  writeDocuments(next);
  reloadRedlines(watchDir);
  return { found: true, ...redlineStatus() };
}

function info(r: RedlineRule): RedlineMatch {
  return { id: r.id, description: r.description, decision: r.decision, kill: r.kill };
}

/** Match a proposed agent/tool action. Empty rules match nothing. */
export function evaluate(proposed: { action: string; target: string }): RedlineRule | null {
  const action = String(proposed.action || "");
  const target = String(proposed.target || "");
  for (const r of rules) {
    if (!r.enabled || r.kind === "file") continue;
    if (!r.action && !r.target && !r.not_target_prefix && !r.protected_path) continue;
    if (r.action && !r.action.test(action)) continue;
    if (r.target && !r.target.test(target)) continue;
    if (r.protected_path && !isUnder(target, r.protected_path)) continue;
    if (r.not_target_prefix && isUnder(target, r.not_target_prefix)) continue;
    return r;
  }
  return null;
}

/** Match an observed filesystem effect against operator-protected paths. */
export function evaluateFileObservation(event: {
  action: "fs_create" | "fs_write" | "fs_delete";
  path: string;
  pid?: number | null;
}): ObservationRedlineResult | null {
  const op = event.action.replace(/^fs_/, "");
  const observed = normalizePath(event.path);
  if (!observed) return null;
  for (const r of rules) {
    if (!r.enabled || (r.kind !== "file" && r.kind !== "path" && r.kind !== "any")) continue;
    if (!r.protected_path && !r.target) continue;
    if (!r.operations.has(op)) continue;
    if (r.protected_path && !isUnder(observed, r.protected_path)) continue;
    if (r.target && !r.target.test(observed)) continue;
    if (r.not_target_prefix && isUnder(observed, r.not_target_prefix)) continue;
    return { rule: info(r), containment_available: Number.isInteger(event.pid) && Number(event.pid) > 1 };
  }
  return null;
}

// Side table: PID and policy metadata absent from AgentGlass's durable gate row.
export interface GateExtra {
  pid: number | null;
  rule: RedlineMatch | null;
  created: number;
}

const extras = new Map<string, GateExtra>();
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
