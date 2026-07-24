// Glasses for Argus — the environment tier.
//
// MIT © 2026 Zac Rieger. See NOTICE.md for provenance.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS
//
// agentglass observes what an agent REPORTS ABOUT ITSELF: hooks fire, OTLP
// spans arrive, transcripts appear on disk. Everything it shows is labeled and
// semantic, which is exactly what makes its cockpit trustworthy.
//
// The cost of that is a blind spot with a hard edge: software that reports
// nothing is not merely unlabeled, it is absent. An Ollama nobody wired, a
// Copilot process, a browser tab talking to Gemini — none of them produce a
// hook, a span, or a transcript, so none of them exist as far as the dashboard
// is concerned.
//
// This tier watches the layers UNDERNEATH the self-report — the OS process
// table, the socket table, and (opt-in) filesystem writes — so those things
// become visible whether or not they cooperate.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE RULE THIS TIER OBEYS
//
// Environment observations are LOW-FIDELITY and UNLABELED. They never enter
// agentglass's `events` table, never touch its cost/token/latency math, and are
// never dressed up as agent activity. They live in `env_events`, they carry an
// explicit fidelity marker, and the UI presents them as a separate lens.
//
// A weak signal presented as a strong one is worse than no signal at all.

import { ProcessAdapter } from "./processes";
import { NetworkAdapter } from "./network";
import { startWatcher, type WatcherHandle } from "./watcher";
import { insertEnvEvent, pruneEnvEvents } from "./store";
import { db } from "../db.ts";
import type { ArgusEvent, EnvEvent, EnvFidelity, EnvTier } from "./types";

const flag = (name: string, dflt: boolean) => {
  const v = process.env[name];
  if (v == null || v === "") return dflt;
  return v !== "0" && v.toLowerCase() !== "false";
};
const num = (name: string, dflt: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : dflt;
};

export const ENV_TIER_ENABLED = flag("GLASSES_ENV_TIER", true);
export const PROCESS_SCAN = flag("GLASSES_PROCESS_SCAN", true);
export const NETWORK_SCAN = flag("GLASSES_NETWORK_SCAN", true);
// OFF by default on purpose — agentglass's author deliberately never taps the
// filesystem, and this port respects that line until someone opts in.
export const FS_WATCH = flag("GLASSES_FS_WATCH", false);

const PROCESS_POLL_MS = num("GLASSES_PROCESS_POLL_MS", 5000);
const NETWORK_POLL_MS = num("GLASSES_NETWORK_POLL_MS", 10000);
const INCLUDE_CMDLINE = flag("GLASSES_PROCESS_CMDLINE", false);
const NETWORK_ALL = flag("GLASSES_NETWORK_ALL", false);
const OLLAMA_URL = process.env.GLASSES_OLLAMA_URL || "http://127.0.0.1:11434";

const TIER_OF: Record<string, EnvTier> = {
  process: "process",
  network: "network",
  file: "file",
  pty: "pty",
};

/** Map an Argus §5 event onto the flat, queryable environment row. */
export function toEnvEvent(a: ArgusEvent): EnvEvent | null {
  const tier = TIER_OF[a.surface];
  if (!tier) return null;
  const p = a.payload || {};

  // Everything not promoted to a column rides along as JSON so nothing the
  // sensors produce is silently dropped.
  const detail: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) {
    if (
      ![
        "node_id", "node_kind", "pid", "ppid", "runtime", "provider",
        "runtime_kind", "process", "remote_host", "remote_ip", "remote_port",
        "path", "fidelity", "label",
      ].includes(k)
    ) {
      detail[k] = v;
    }
  }
  if (p.label !== undefined) detail.label = p.label;
  if (p.ai_endpoint !== undefined) detail.ai_endpoint = p.ai_endpoint;
  if (p.ai_process !== undefined) detail.ai_process = p.ai_process;

  return {
    ts: a.ts,
    tier,
    action: a.action,
    target: String(a.target ?? ""),
    node_id: (p.node_id as string) ?? (tier === "network" ? a.agent_id : null),
    parent_node_id: a.parent_id,
    pid: p.pid == null ? null : Number(p.pid),
    ppid: p.ppid == null ? null : Number(p.ppid),
    runtime: (p.runtime as string) ?? null,
    provider: (p.provider as string) ?? null,
    runtime_kind: (p.runtime_kind as string) ?? null,
    process_name: (p.process as string) ?? null,
    remote_host: (p.remote_host as string) ?? null,
    remote_ip: (p.remote_ip as string) ?? null,
    remote_port: p.remote_port == null ? null : Number(p.remote_port),
    path: (p.path as string) ?? null,
    fidelity: ((p.fidelity as EnvFidelity) ?? "presence_only") as EnvFidelity,
    // Always 0 at capture time. Whether anything CLAIMED this observation is a
    // question about agentglass's telemetry, answered at query time in
    // store.ts — not guessed here, where we'd have to invent a mapping from a
    // pid to a session id that the OS simply does not provide.
    attributed: 0,
    detail,
  };
}

export interface EnvTierHandle {
  stop: () => Promise<void>;
  status: () => EnvTierStatus;
}

export interface EnvTierStatus {
  enabled: boolean;
  process: { enabled: boolean; poll_ms: number; cmdline: boolean };
  network: { enabled: boolean; poll_ms: number; all: boolean };
  file: { enabled: boolean; available: boolean; dir: string | null };
  platform: string;
}

let status: EnvTierStatus = {
  enabled: false,
  process: { enabled: false, poll_ms: PROCESS_POLL_MS, cmdline: INCLUDE_CMDLINE },
  network: { enabled: false, poll_ms: NETWORK_POLL_MS, all: NETWORK_ALL },
  file: { enabled: false, available: false, dir: null },
  platform: process.platform,
};

export function envTierStatus(): EnvTierStatus {
  return status;
}

export interface StartEnvTierOpts {
  /** Called for every persisted environment event, for live broadcast. */
  onEvent?: (e: EnvEvent) => void;
  /** Root for the opt-in filesystem tier. */
  fsDir?: string | null;
  retentionDays?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Live tier control.
//
// Argus let you move the lens while it ran — click the watched path and point
// it somewhere else, and the change was itself a durable event so a replay
// showed when the view moved. Requiring a server restart to answer "what is
// touching my files?" kills the exploratory loop that makes this worth having,
// so the watcher and the network scope are both swappable at runtime.
//
// Module-level rather than closed over the handle: the HTTP routes need to
// reach them, and there is exactly one tier per process.
let sink: ((a: ArgusEvent) => void) | null = null;
let fsHandle: WatcherHandle | null = null;
let netAdapter: NetworkAdapter | null = null;

/**
 * Paths the watcher must never report, because they are ITS OWN recording.
 *
 * Every fs event is written to SQLite, which writes its WAL, which is a file in
 * the watched tree — so without this the tier feeds itself and the suspect band
 * fills with thousands of writes that are nothing but the act of observing.
 * `db.filename` is read at call time rather than hardcoded so a relocated
 * database (AGENTGLASS_DB) is still excluded.
 */
function selfPaths(): string[] {
  try {
    const f = (db as unknown as { filename?: string }).filename;
    // The bare path also prefix-matches `-wal` and `-shm`.
    return f ? [f] : [];
  } catch {
    return [];
  }
}

function startFsWatcher(dir: string): void {
  fsHandle = startWatcher(dir, (change) => {
    sink?.({
      ts: change.ts,
      agent_id: null, // nothing claimed this write — that is the whole point
      parent_id: null,
      surface: "file",
      action: change.action,
      target: change.path,
      status: "ok",
      payload: { path: change.path, diff: change.diff, fidelity: "fs_observed" },
    });
  }, { exclude: selfPaths() });
  status.file = { enabled: true, available: fsHandle.available, dir };
}

/**
 * Turn the filesystem tier on/off, or move it to a different root.
 *
 * `dir` null with enabled=true keeps the current directory. Stopping always
 * closes the old watcher first — two recursive watchers over overlapping trees
 * would double every event.
 */
export async function setFsWatch({ enabled, dir }: { enabled: boolean; dir?: string | null }): Promise<EnvTierStatus> {
  await fsHandle?.close();
  fsHandle = null;
  if (!enabled) {
    status.file = { enabled: false, available: false, dir: status.file.dir };
    return status;
  }
  const target = dir || status.file.dir || process.env.GLASSES_FS_DIR || null;
  if (!target) {
    status.file = { enabled: true, available: false, dir: null };
    return status;
  }
  startFsWatcher(target);
  return status;
}

/** Switch the network tier between AI-relevant only and every connection. */
export function setNetworkScope(all: boolean): EnvTierStatus {
  status.network.all = all;
  netAdapter?.setAll(all);
  return status;
}

/**
 * Start the environment tier. Safe to call when everything is disabled — it
 * returns a handle whose stop() is a no-op.
 */
export function startEnvTier({ onEvent, fsDir, retentionDays = 0 }: StartEnvTierOpts = {}): EnvTierHandle {
  if (!ENV_TIER_ENABLED) {
    status = { ...status, enabled: false };
    return { stop: async () => {}, status: envTierStatus };
  }

  sink = (a: ArgusEvent) => {
    try {
      const env = toEnvEvent(a);
      if (!env) return;
      const stored = insertEnvEvent(env);
      onEvent?.(stored);
    } catch (e: any) {
      console.error(`[argus] failed to record env event: ${e?.message ?? e}`);
    }
  };

  const ctx = { emit: (a: ArgusEvent) => sink?.(a) };
  const adapters: Array<{ stop: () => void | Promise<void> }> = [];

  if (PROCESS_SCAN) {
    const proc = new ProcessAdapter({
      pollMs: PROCESS_POLL_MS,
      includeCommand: INCLUDE_CMDLINE,
      ollamaUrl: OLLAMA_URL,
    });
    void proc.start(ctx);
    adapters.push(proc);
    status.process.enabled = true;
  }

  if (NETWORK_SCAN) {
    netAdapter = new NetworkAdapter({ pollMs: NETWORK_POLL_MS, all: NETWORK_ALL });
    void netAdapter.start(ctx);
    adapters.push(netAdapter);
    status.network.enabled = true;
  }

  // Remembered so a later enable has somewhere to point even before one is picked.
  status.file.dir = fsDir || process.env.GLASSES_FS_DIR || null;
  if (FS_WATCH) {
    if (status.file.dir) startFsWatcher(status.file.dir);
    else {
      console.error("[argus] GLASSES_FS_WATCH is on but no directory is scoped; fs tier idle");
      status.file = { enabled: true, available: false, dir: null };
    }
  }

  // Retention, matching agentglass's own policy for its rows.
  let pruneTimer: ReturnType<typeof setInterval> | null = null;
  if (retentionDays > 0) {
    pruneTimer = setInterval(() => {
      try { pruneEnvEvents(retentionDays); } catch { /* next sweep */ }
    }, 6 * 3600_000);
  }

  status.enabled = true;

  const bits = [
    status.process.enabled ? `process ${PROCESS_POLL_MS}ms` : null,
    status.network.enabled ? `network ${NETWORK_POLL_MS}ms${NETWORK_ALL ? " (all)" : ""}` : null,
    status.file.enabled ? `file ${status.file.available ? status.file.dir : "unavailable"}` : null,
  ].filter(Boolean);
  console.log(`   Environment → ${bits.length ? bits.join(", ") : "no sensors enabled"}`);

  return {
    status: envTierStatus,
    stop: async () => {
      if (pruneTimer) clearInterval(pruneTimer);
      for (const a of adapters) await a.stop();
      await fsHandle?.close();
      fsHandle = null;
      netAdapter = null;
      sink = null;
      status = { ...status, enabled: false };
    },
  };
}
