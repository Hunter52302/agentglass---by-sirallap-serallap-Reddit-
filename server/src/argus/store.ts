// AgentGlass Argus integration — environment-tier persistence.
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

// ─────────────────────────────────────────────────────────────────────────────
// Agent pids — what turns "is this vendor reporting?" into "is THIS process
// reporting?".
//
// Nothing in the OS process table carries a session id, and nothing in a hook
// payload carries a pid, so the two halves could not be joined: a runtime was
// called attributed if ANY session from the same vendor was reporting. A second
// UNWIRED Claude Code sitting beside a wired one therefore looked fine, which is
// precisely the case the tier exists to catch.
//
// The fix is for the hook to volunteer the one fact only it knows: the pid of
// the agent process that spawned it (`os.getppid()`). That is recorded here and
// matched against the process scan.

db.exec(`
CREATE TABLE IF NOT EXISTS env_agent_pids (
  pid        INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  source_app TEXT,
  last_seen  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_env_agent_pids_seen ON env_agent_pids(last_seen);
`);

const upsertPid = db.prepare(`
INSERT INTO env_agent_pids (pid, session_id, source_app, last_seen)
VALUES (?, ?, ?, ?)
ON CONFLICT(pid) DO UPDATE SET
  session_id = excluded.session_id,
  source_app = excluded.source_app,
  last_seen  = excluded.last_seen
`);

/** Record that `pid` is an agent process which is actively reporting. */
export function noteAgentPid(pid: unknown, session_id: string, source_app?: string | null): void {
  const n = Number(pid);
  // pid 0/1 are never an agent, and a non-integer is a caller bug rather than
  // an observation — dropping them keeps the join honest.
  if (!Number.isInteger(n) || n <= 1) return;
  try {
    upsertPid.run(n, String(session_id || "unknown"), source_app ? String(source_app) : null, Date.now());
  } catch { /* a lost pid is not worth failing an ingest over */ }
}

/** Pids of agents that have reported within the window. */
export function reportingPids(windowMs = 15 * 60_000): Set<number> {
  const rows = db
    .query(`SELECT pid FROM env_agent_pids WHERE last_seen > ?`)
    .all(Date.now() - windowMs) as { pid: number }[];
  return new Set(rows.map((r) => r.pid));
}

/** Drop pids we have not heard from in a long time, so a machine that has been
 *  up for weeks does not accumulate dead process ids that could be reused. */
export function pruneAgentPids(maxAgeMs = 24 * 3600_000): number {
  const res = db.run(`DELETE FROM env_agent_pids WHERE last_seen < ?`, [Date.now() - maxAgeMs]);
  return Number(res?.changes ?? 0);
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
  /** true = present in the OS but nothing claims it. The point. */
  blind: boolean;
  /** How the claim was established — see currentRuntimes(). */
  attribution: "process" | "provider" | "none";
  models: unknown[];
}

/**
 * Latest known state per discovered runtime node.
 *
 * Two queries total, regardless of node count. The first version ran a
 * latest-row query AND a models query PER NODE — an N+1 that three separate
 * endpoints called on every poll, so twenty runtimes meant forty-one queries
 * several times a second. Cost scaled with how much the machine was doing,
 * which is exactly backwards for a monitor.
 */
export function currentRuntimes(): RuntimeRow[] {
  // Latest lifecycle row per node, resolved in SQL rather than per-node.
  // Ties on ts are broken by id so the answer is deterministic.
  const rows = db.query(`
    SELECT e.*, agg.first_seen, agg.last_seen
      FROM env_events e
      JOIN (
        SELECT node_id,
               MIN(ts) AS first_seen,
               MAX(ts) AS last_seen,
               MAX(id) AS pick
          FROM env_events
         WHERE tier = 'process' AND node_id IS NOT NULL
           AND action IN ('process_discovered','process_stopped')
         GROUP BY node_id
      ) agg ON agg.pick = e.id
     ORDER BY agg.last_seen DESC
  `).all() as any[];

  // Every model row for every node, once. Ordered so the fold below is a
  // simple last-write-wins per (node, model).
  const modelRows = db.query(`
    SELECT node_id, action, detail FROM env_events
     WHERE action IN ('model_loaded','model_unloaded') AND node_id IS NOT NULL
     ORDER BY ts ASC, id ASC
  `).all() as any[];

  const loadedByNode = new Map<string, Map<string, unknown>>();
  for (const m of modelRows) {
    let d: any = {};
    try { d = JSON.parse(m.detail || "{}"); } catch { continue; }
    const model = d.model;
    if (!model) continue;
    const key = model.digest || model.name;
    let loaded = loadedByNode.get(m.node_id);
    if (!loaded) { loaded = new Map(); loadedByNode.set(m.node_id, loaded); }
    if (m.action === "model_loaded") loaded.set(key, model);
    else loaded.delete(key);
  }

  const reporting = reportingProviders();
  const pids = reportingPids();

  return rows.map((r) => {
    const running = r.action === "process_discovered";

    /**
     * How confidently do we know this process is reporting?
     *
     *  "process"  — its own pid, or its parent's, is one a hook reported from.
     *               Exact: this process, not merely something of its vendor.
     *  "provider" — only that SOME session of the same vendor is reporting.
     *               A fallback for when no hook has volunteered a pid, kept so
     *               an un-hooked setup does not report every runtime as blind.
     *  "none"     — nothing claims it.
     *
     * Process beats provider whenever a pid is available, which is what makes a
     * second unwired Claude Code beside a wired one show up correctly.
     */
    let attribution: "process" | "provider" | "none" = "none";
    if (r.pid != null && (pids.has(r.pid) || (r.ppid != null && pids.has(r.ppid)))) {
      attribution = "process";
    } else if (pids.size === 0 && providerIsReporting(r.provider, reporting)) {
      // Only fall back when NO pid evidence exists at all. Once hooks are
      // reporting pids, a vendor match is no longer good enough — that is the
      // whole point of the upgrade.
      attribution = "provider";
    }

    return {
      node_id: r.node_id,
      label: r.target,
      runtime: r.runtime,
      provider: r.provider,
      runtime_kind: r.runtime_kind,
      pid: r.pid,
      first_seen: r.first_seen,
      last_seen: r.last_seen,
      running,
      blind: running && attribution === "none",
      attribution,
      models: [...(loadedByNode.get(r.node_id) ?? new Map()).values()],
    };
  });
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

/**
 * Currently-open AI-relevant outbound connections, newest first.
 *
 * Bounded by time, and it has to be. Determining "still open" means folding
 * connect/close pairs, and the first version folded EVERY network row ever
 * recorded on each call — a scan that grows all day, run by two pollers several
 * times a second. The window is generous (12h by default, far longer than any
 * real socket) but finite, so cost stops tracking uptime.
 *
 * The tradeoff is honest: a connection opened before the window and never
 * closed is not shown. That is a socket held open for half a day, which the
 * poller would have re-announced long before now anyway — the adapter re-emits
 * connects for anything it has not seen.
 */
export function currentConnections(limit = 100, windowMs = 12 * 3600_000): ConnRow[] {
  const rows = db.query(`
    SELECT * FROM env_events
     WHERE tier = 'network' AND ts > ?
     ORDER BY ts ASC
  `).all(Date.now() - windowMs) as any[];

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
  kind: "runtime" | "program" | "unattributed" | "shell";
  tier: EnvTier;
  count: number;
  last_ts: number;
  provider: string | null;
  /** Most recent events for this actor, newest first. */
  events: EnvEvent[];
  /** Activity per time bucket across the requested window, oldest first. */
  buckets: number[];
}

export function actorLanes(windowMs = 60 * 60_000, perLane = 8, buckets = 60): ActorLane[] {
  const since = Date.now() - windowMs;
  const bucketMs = Math.max(1, Math.floor(windowMs / buckets));
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
      lane = {
        actor, kind, tier: e.tier, count: 0, last_ts: 0, provider: e.provider,
        events: [],
        // One slot per time bucket across the window — the lane's own little
        // timeline. Counts rather than a boolean so a burst reads differently
        // from a trickle, which is the whole reason to draw it.
        buckets: new Array(buckets).fill(0),
      };
      lanes.set(key, lane);
    }
    lane.count++;
    if (e.ts > lane.last_ts) lane.last_ts = e.ts;
    if (!lane.provider && e.provider) lane.provider = e.provider;
    if (lane.events.length < perLane) lane.events.push(e);
    // Clamped: a row can arrive a millisecond after `since` was computed, which
    // would index one past the end.
    const b = Math.min(buckets - 1, Math.max(0, Math.floor((e.ts - since) / bucketMs)));
    lane.buckets[b]++;
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
export function ptyShells(limit = 12, maxBytes = 200_000, maxChunks = 4000): PtyShell[] {
  // Bounded, and this one bites hardest of all the scans: a pty chunk carries
  // up to 400KB of base64, so an hour of a chatty shell is tens of megabytes
  // that the first version re-read and re-decoded on EVERY three-second poll.
  // Newest chunks are the ones worth having (the tail is what you read), so we
  // take the most recent N and re-sort ascending for reassembly.
  const rows = (db.query(`
    SELECT * FROM env_events WHERE tier = 'pty' ORDER BY ts DESC, id DESC LIMIT ?
  `).all(maxChunks) as any[]).reverse();

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
