// Glasses for Argus — environment-tier persistence.
//
// MIT © 2026 Zac Rieger. See NOTICE.md.
//
// Deliberately a SEPARATE table from `events`. Environment observations have
// no session, no tokens and no cost; writing them into `events` would drag
// them into agentglass's spend, throughput, latency and radar queries and
// silently wreck every number on the cockpit. Same database, same retention,
// different table. The two tiers are joined in the UI, never in the stats.

import { db } from "../db.ts";
import type { EnvEvent, EnvTier, PtyShell } from "./types";

db.exec(`
CREATE TABLE IF NOT EXISTS env_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  tier TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  node_id TEXT,
  parent_node_id TEXT,
  pid INTEGER,
  ppid INTEGER,
  runtime TEXT,
  provider TEXT,
  runtime_kind TEXT,
  process_name TEXT,
  remote_host TEXT,
  remote_ip TEXT,
  remote_port INTEGER,
  path TEXT,
  fidelity TEXT NOT NULL,
  attributed INTEGER NOT NULL DEFAULT 0,
  detail TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_env_ts ON env_events(ts);
CREATE INDEX IF NOT EXISTS idx_env_tier_ts ON env_events(tier, ts);
CREATE INDEX IF NOT EXISTS idx_env_node ON env_events(node_id, ts);
CREATE INDEX IF NOT EXISTS idx_env_provider_ts ON env_events(provider, ts);
`);

const insertStmt = db.prepare(`
INSERT INTO env_events (
  ts, tier, action, target, node_id, parent_node_id, pid, ppid, runtime,
  provider, runtime_kind, process_name, remote_host, remote_ip, remote_port,
  path, fidelity, attributed, detail
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

export function insertEnvEvent(e: EnvEvent): EnvEvent {
  const res = insertStmt.run(
    e.ts, e.tier, e.action, e.target, e.node_id, e.parent_node_id, e.pid, e.ppid,
    e.runtime, e.provider, e.runtime_kind, e.process_name, e.remote_host,
    e.remote_ip, e.remote_port, e.path, e.fidelity, e.attributed,
    JSON.stringify(e.detail ?? {})
  );
  return { ...e, id: Number(res.lastInsertRowid) };
}

function hydrate(r: any): EnvEvent {
  let detail: Record<string, unknown> = {};
  try { detail = JSON.parse(r.detail || "{}"); } catch { /* corrupt row — show the rest */ }
  return { ...r, detail };
}

export function recentEnvEvents(limit = 200, tier?: EnvTier): EnvEvent[] {
  const rows = tier
    ? db.query(`SELECT * FROM env_events WHERE tier = ? ORDER BY ts DESC, id DESC LIMIT ?`).all(tier, limit)
    : db.query(`SELECT * FROM env_events ORDER BY ts DESC, id DESC LIMIT ?`).all(limit);
  return (rows as any[]).map(hydrate).reverse();
}

/**
 * Argus provider slug → agentglass provider label.
 *
 * The two vocabularies were built independently: Argus names the vendor of a
 * *runtime it found in the process table* ("anthropic", "ollama"), agentglass
 * names the vendor of a *model it saw in telemetry* ("Anthropic", "OpenAI" —
 * see providerOf() in db.ts). Joining them is what lets us ask whether a
 * process we can see is the same thing as a session we can see.
 *
 * A slug missing from this table has no agentglass equivalent, and that is a
 * fact rather than a gap: agentglass learns about a provider by reading a model
 * name out of agent telemetry, and a local Ollama or an LM Studio never
 * produces any. Those runtimes are unobservable to it BY CONSTRUCTION, which is
 * precisely the blind spot this tier exists to make visible.
 */
const PROVIDER_ALIAS: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  mistral: "Mistral",
  cohere: "Cohere",
  "xai-groq": "xAI",
};

/**
 * Which providers has agentglass seen ACTUAL telemetry from recently?
 *
 * Read from `sessions`, not `events`: a session latches its provider once a
 * model name appears, whereas most individual event rows (a PreToolUse hook,
 * for instance) carry no model at all and so have a NULL provider. Querying
 * events made every runtime look blind, including ones that were plainly
 * reporting.
 *
 * HONEST LIMIT: this matches on provider, not on process identity. Nothing in
 * the OS process table carries a session id, so a second UNWIRED Claude Code
 * running beside a wired one will look attributed. It answers "is anything from
 * this vendor reporting", not "is THIS process reporting". Tightening that
 * needs the agent to volunteer its own pid — which the Claude Code hook can do,
 * and which is the obvious next step for this tier.
 */
export function reportingProviders(windowMs = 15 * 60_000): Set<string> {
  const rows = db
    .query(`SELECT DISTINCT provider FROM sessions WHERE last_seen > ? AND provider IS NOT NULL`)
    .all(Date.now() - windowMs) as { provider: string }[];
  return new Set(rows.map((r) => r.provider));
}

/** Is this Argus runtime provider currently reporting telemetry to agentglass? */
export function providerIsReporting(argusProvider: string | null, reporting: Set<string>): boolean {
  if (!argusProvider) return false;
  const mapped = PROVIDER_ALIAS[argusProvider];
  return mapped ? reporting.has(mapped) : false;
}

export interface RuntimeRow {
  node_id: string;
  label: string;
  runtime: string | null;
  provider: string | null;
  runtime_kind: string | null;
  pid: number | null;
  first_seen: number;
  last_seen: number;
  running: boolean;
  /** true = present in the OS but no telemetry from its provider. The point. */
  blind: boolean;
  models: unknown[];
}

/** Latest known state per discovered runtime node. */
export function currentRuntimes(): RuntimeRow[] {
  const rows = db.query(`
    SELECT node_id,
           MAX(ts)  AS last_seen,
           MIN(ts)  AS first_seen,
           MAX(CASE WHEN action = 'process_discovered' THEN ts END) AS started,
           MAX(CASE WHEN action = 'process_stopped'    THEN ts END) AS stopped
      FROM env_events
     WHERE tier = 'process' AND node_id IS NOT NULL
     GROUP BY node_id
     ORDER BY last_seen DESC
  `).all() as any[];

  const reporting = reportingProviders();
  const out: RuntimeRow[] = [];

  for (const r of rows) {
    const latest = db.query(`
      SELECT * FROM env_events
       WHERE node_id = ? AND tier = 'process' AND action IN ('process_discovered','process_stopped')
       ORDER BY ts DESC LIMIT 1
    `).get(r.node_id) as any;
    if (!latest) continue;

    const running = latest.action === "process_discovered";
    // Models currently loaded: every model_loaded not since matched by an unload.
    const modelRows = db.query(`
      SELECT action, detail, ts FROM env_events
       WHERE node_id = ? AND action IN ('model_loaded','model_unloaded')
       ORDER BY ts ASC
    `).all(r.node_id) as any[];
    const loaded = new Map<string, unknown>();
    for (const m of modelRows) {
      let d: any = {};
      try { d = JSON.parse(m.detail || "{}"); } catch { /* skip */ }
      const model = d.model;
      if (!model) continue;
      const key = model.digest || model.name;
      if (m.action === "model_loaded") loaded.set(key, model);
      else loaded.delete(key);
    }

    out.push({
      node_id: r.node_id,
      label: latest.target,
      runtime: latest.runtime,
      provider: latest.provider,
      runtime_kind: latest.runtime_kind,
      pid: latest.pid,
      first_seen: r.first_seen,
      last_seen: r.last_seen,
      running,
      blind: running && !providerIsReporting(latest.provider, reporting),
      models: [...loaded.values()],
    });
  }
  return out;
}

export interface ConnRow {
  process_name: string | null;
  pid: number | null;
  remote_host: string | null;
  remote_ip: string | null;
  remote_port: number | null;
  provider: string | null;
  label: string | null;
  ai_endpoint: boolean;
  opened: number;
  last_seen: number;
  open: boolean;
}

/** Currently-open AI-relevant outbound connections, newest first. */
export function currentConnections(limit = 100): ConnRow[] {
  const rows = db.query(`
    SELECT * FROM env_events
     WHERE tier = 'network'
     ORDER BY ts ASC
  `).all() as any[];

  const live = new Map<string, ConnRow>();
  for (const r of rows) {
    const key = `${r.pid}|${r.remote_host || r.remote_ip}`;
    let detail: any = {};
    try { detail = JSON.parse(r.detail || "{}"); } catch { /* skip */ }
    if (r.action === "net_connect") {
      live.set(key, {
        process_name: r.process_name,
        pid: r.pid,
        remote_host: r.remote_host,
        remote_ip: r.remote_ip,
        remote_port: r.remote_port,
        provider: r.provider,
        label: detail.label ?? null,
        ai_endpoint: !!detail.ai_endpoint,
        opened: r.ts,
        last_seen: r.ts,
        open: true,
      });
    } else {
      const prev = live.get(key);
      if (prev) { prev.open = false; prev.last_seen = r.ts; }
    }
  }
  return [...live.values()].sort((a, b) => b.opened - a.opened).slice(0, limit);
}

/** Unattributed filesystem writes — only populated when the fs tier is on. */
export function recentFileActivity(limit = 100): EnvEvent[] {
  const rows = db.query(`
    SELECT * FROM env_events WHERE tier = 'file' ORDER BY ts DESC LIMIT ?
  `).all(limit) as any[];
  return rows.map(hydrate);
}

export function envSummary() {
  const runtimes = currentRuntimes();
  const running = runtimes.filter((r) => r.running);
  const conns = currentConnections();
  const openConns = conns.filter((c) => c.open);
  const files = db
    .query(`SELECT COUNT(*) AS n FROM env_events WHERE tier = 'file' AND ts > ?`)
    .get(Date.now() - 60 * 60_000) as { n: number };
  return {
    runtimes_running: running.length,
    runtimes_blind: running.filter((r) => r.blind).length,
    connections_open: openConns.length,
    connections_ai_endpoint: openConns.filter((c) => c.ai_endpoint).length,
    file_events_last_hour: files?.n ?? 0,
  };
}

/**
 * Lanes — one column per ACTOR, which is Argus's organizing idea.
 *
 * An actor is whoever or whatever is doing something, and the three tiers name
 * them with very different confidence:
 *
 *   runtime      — a recognized AI process. Named, from the process table.
 *   program      — any process holding a socket. Named ("firefox"), and this is
 *                  the only tier that can name a non-AI program at all.
 *   unattributed — a file write. NOT named, and cannot be: neither
 *                  ReadDirectoryChangesW nor FSEvents reports a writing pid,
 *                  so every filesystem event on every platform lands here.
 *
 * That last lane is the honest one. Argus's whole posture is that an unclaimed
 * action must stand out rather than be quietly folded into a labeled column.
 */
export interface ActorLane {
  actor: string;
  kind: "runtime" | "program" | "unattributed";
  tier: EnvTier;
  count: number;
  last_ts: number;
  provider: string | null;
  /** Most recent events for this actor, newest first. */
  events: EnvEvent[];
}

export function actorLanes(windowMs = 60 * 60_000, perLane = 8): ActorLane[] {
  const since = Date.now() - windowMs;
  const rows = db
    .query(`SELECT * FROM env_events WHERE ts > ? ORDER BY ts DESC LIMIT 4000`)
    .all(since) as any[];

  const lanes = new Map<string, ActorLane>();
  for (const r of rows) {
    const e = hydrate(r);
    let actor: string;
    let kind: ActorLane["kind"];
    if (e.tier === "file") {
      actor = "unattributed";
      kind = "unattributed";
    } else if (e.tier === "pty") {
      // The operator named this one, so it is used verbatim.
      actor = e.target || "shell";
      kind = "shell";
    } else if (e.tier === "network") {
      actor = e.process_name || "unknown";
      kind = "program";
    } else {
      actor = e.target || e.runtime || "unknown";
      kind = "runtime";
    }
    const key = `${kind}:${actor}`;
    let lane = lanes.get(key);
    if (!lane) {
      lane = { actor, kind, tier: e.tier, count: 0, last_ts: 0, provider: e.provider, events: [] };
      lanes.set(key, lane);
    }
    lane.count++;
    if (e.ts > lane.last_ts) lane.last_ts = e.ts;
    if (!lane.provider && e.provider) lane.provider = e.provider;
    if (lane.events.length < perLane) lane.events.push(e);
  }

  // Unattributed first — it is the one that should catch your eye, so it does
  // not get sorted below whichever runtime happened to be chatty.
  return [...lanes.values()].sort((a, b) => {
    if (a.kind !== b.kind) {
      if (a.kind === "unattributed") return -1;
      if (b.kind === "unattributed") return 1;
    }
    return b.last_ts - a.last_ts;
  });
}

/**
 * The suspect band's numbers: activity nobody has claimed.
 *
 * Kept as its own query rather than folded into envSummary() because this is
 * the band that is supposed to be visible at all times, and it must stay cheap
 * enough to poll continuously.
 */
export interface SuspectRollup {
  unattributed_writes: number;
  unattributed_paths: number;
  silent_runtimes: number;
  window_ms: number;
  recent: EnvEvent[];
}

export function suspectRollup(windowMs = 60 * 60_000, limit = 40): SuspectRollup {
  const since = Date.now() - windowMs;
  const agg = db
    .query(`SELECT COUNT(*) AS n, COUNT(DISTINCT path) AS paths
              FROM env_events WHERE tier = 'file' AND ts > ?`)
    .get(since) as { n: number; paths: number };
  const recent = (db
    .query(`SELECT * FROM env_events WHERE tier = 'file' AND ts > ? ORDER BY ts DESC LIMIT ?`)
    .all(since, limit) as any[]).map(hydrate);
  const silent = currentRuntimes().filter((r) => r.running && r.blind).length;
  return {
    unattributed_writes: agg?.n ?? 0,
    unattributed_paths: agg?.paths ?? 0,
    silent_runtimes: silent,
    window_ms: windowMs,
    recent,
  };
}

/**
 * Recorded shells, reassembled from their chunks.
 *
 * Every other tier here is INFERRED from the OS — a process name, a socket, a
 * write with no author. This one is the literal bytes of a terminal, shipped by
 * a recorder the operator attached themselves. It is the highest-fidelity thing
 * in the environment tier and the only one whose actor name is authoritative
 * rather than guessed, because a human typed it.
 *
 * Chunks are ordered by `seq` and not by `ts`: several can share a millisecond
 * under a fast flush, and terminal output reassembled out of order is garbage.
 */
export function ptyShells(limit = 12, maxBytes = 200_000): PtyShell[] {
  const rows = db.query(`
    SELECT * FROM env_events WHERE tier = 'pty' ORDER BY ts ASC, id ASC
  `).all() as any[];

  const byAgent = new Map<string, PtyShell & { _parts: Array<{ seq: number; b64: string }> }>();
  for (const r of rows) {
    let detail: any = {};
    try { detail = JSON.parse(r.detail || "{}"); } catch { continue; }
    const agent = r.target || "shell";
    let sh = byAgent.get(agent);
    if (!sh) {
      sh = {
        agent,
        command: String(detail.command ?? ""),
        host: detail.host ?? null,
        started: r.ts,
        last_ts: r.ts,
        chunks: 0,
        ended: false,
        output: "",
        _parts: [],
      };
      byAgent.set(agent, sh);
    }
    sh.last_ts = r.ts;
    if (detail.command && !sh.command) sh.command = String(detail.command);
    if (r.action === "pty_end") sh.ended = true;
    if (typeof detail.chunk_b64 === "string" && detail.chunk_b64) {
      sh.chunks++;
      sh._parts.push({ seq: Number(detail.seq) || sh.chunks, b64: detail.chunk_b64 });
    }
  }

  const out: PtyShell[] = [];
  for (const sh of byAgent.values()) {
    sh._parts.sort((a, b) => a.seq - b.seq);
    let text = "";
    for (const p of sh._parts) {
      try { text += Buffer.from(p.b64, "base64").toString("utf8"); } catch { /* skip bad chunk */ }
    }
    // Keep the TAIL, not the head: a long-running shell's interesting part is
    // what just happened, and the head is the login banner.
    if (text.length > maxBytes) text = text.slice(-maxBytes);
    const { _parts, ...rest } = sh;
    out.push({ ...rest, output: text });
  }
  return out.sort((a, b) => b.last_ts - a.last_ts).slice(0, limit);
}

/**
 * Replay — reconstruct the environment at a past instant.
 *
 * Argus's invariant: state at time T rebuilt from the log is identical to what
 * was live at T. That holds here for the same reason it held there — env_events
 * is append-only and nothing is ever rewritten, so "what was true at T" is just
 * the fold of every row with ts <= T. No snapshots, no separate history table.
 *
 * The scrubber is what turns this tier from a live feed into an investigation
 * tool: "that Ollama appeared at some point this afternoon — when, and what
 * else happened in that minute?" is unanswerable from a live view alone.
 */
export interface ReplayBounds {
  first: number | null;
  last: number | null;
  count: number;
}

export function replayBounds(): ReplayBounds {
  const r = db
    .query(`SELECT MIN(ts) AS first, MAX(ts) AS last, COUNT(*) AS n FROM env_events`)
    .get() as { first: number | null; last: number | null; n: number };
  return { first: r?.first ?? null, last: r?.last ?? null, count: r?.n ?? 0 };
}

export interface ReplayState {
  at: number;
  runtimes: Array<{ node_id: string; label: string; runtime: string | null; provider: string | null; running: boolean }>;
  connections: number;
  file_writes: number;
  /** The events in the window leading up to `at` — what was happening *then*. */
  window: EnvEvent[];
}

export function replayAt(at: number, windowMs = 60_000): ReplayState {
  // Runtimes: the last lifecycle event per node at or before `at` decides
  // whether it was up. Exactly the fold the live view does, bounded by time.
  const runtimeRows = db.query(`
    SELECT e.node_id, e.target, e.runtime, e.provider, e.action
      FROM env_events e
      JOIN (
        SELECT node_id, MAX(ts) AS mts FROM env_events
         WHERE tier = 'process' AND node_id IS NOT NULL AND ts <= ?
           AND action IN ('process_discovered','process_stopped')
         GROUP BY node_id
      ) last ON last.node_id = e.node_id AND last.mts = e.ts
     WHERE e.tier = 'process' AND e.action IN ('process_discovered','process_stopped')
  `).all(at) as any[];

  const conns = db.query(`
    SELECT SUM(CASE WHEN action = 'net_connect' THEN 1 ELSE -1 END) AS open
      FROM env_events WHERE tier = 'network' AND ts <= ?
  `).get(at) as { open: number | null };

  const writes = db.query(`
    SELECT COUNT(*) AS n FROM env_events WHERE tier = 'file' AND ts <= ? AND ts > ?
  `).get(at, at - windowMs) as { n: number };

  const window = (db.query(`
    SELECT * FROM env_events WHERE ts <= ? AND ts > ? ORDER BY ts DESC LIMIT 200
  `).all(at, at - windowMs) as any[]).map(hydrate);

  // De-dupe: one node can appear twice if two rows share the same max ts.
  const seen = new Set<string>();
  const runtimes = [];
  for (const r of runtimeRows) {
    if (seen.has(r.node_id)) continue;
    seen.add(r.node_id);
    runtimes.push({
      node_id: r.node_id,
      label: r.target,
      runtime: r.runtime,
      provider: r.provider,
      running: r.action === "process_discovered",
    });
  }

  return {
    at,
    runtimes,
    connections: Math.max(0, conns?.open ?? 0),
    file_writes: writes?.n ?? 0,
    window,
  };
}

/** Same retention policy as agentglass's own rows, applied to our table. */
export function pruneEnvEvents(retentionDays: number): number {
  if (!retentionDays) return 0;
  const cutoff = Date.now() - retentionDays * 86_400_000;
  const res = db.run(`DELETE FROM env_events WHERE ts < ?`, [cutoff]);
  return Number(res?.changes ?? 0);
}
