// AgentGlass Argus integration — agent runtime integrity, provenance, and intervention.
//
// MIT © 2026 Zac Rieger. See NOTICE.md for provenance.
//
// AgentGlass describes what agents report. Argus observes the runtime layers
// beneath and around that report: recognized agent processes, relevant network
// metadata, attached shells, and opt-in filesystem effects. Broad observation is
// available only when the operator deliberately points the lens there.

import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { ProcessAdapter } from "./processes";
import { NetworkAdapter } from "./network";
import { startWatcher, type WatcherHandle } from "./watcher";
import { insertEnvEvent, pruneEnvEvents, pruneAgentPids } from "./store";
import { db } from "../db.ts";
import { workspaceRoot } from "../config.ts";
import { readSettings, writeSettings, resolveFlag } from "./settings";
import { evaluateFileObservation, reloadRedlines } from "./redlines";
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

// Recognized agent/runtime discovery is part of Argus's normal integrity view.
// Command lines remain off unless explicitly requested.
export const PROCESS_SCAN = flag("GLASSES_PROCESS_SCAN", true);
export const NETWORK_SCAN = flag("GLASSES_NETWORK_SCAN", true);

const stored = readSettings();
export const FS_WATCH = resolveFlag("GLASSES_FS_WATCH", stored.fs_enabled, false);

const PROCESS_POLL_MS = num("GLASSES_PROCESS_POLL_MS", 5000);
const NETWORK_POLL_MS = num("GLASSES_NETWORK_POLL_MS", 10000);
const INCLUDE_CMDLINE = flag("GLASSES_PROCESS_CMDLINE", false);

// AI/agent-relevant network metadata is the default. Every-process network
// visibility is an explicit operator choice and may be toggled live.
const NETWORK_ALL = resolveFlag("GLASSES_NETWORK_ALL", stored.network_all, false);
const OLLAMA_URL = process.env.GLASSES_OLLAMA_URL || "http://127.0.0.1:11434";

const TIER_OF: Record<string, EnvTier> = {
  process: "process",
  network: "network",
  file: "file",
  pty: "pty",
};

export function toEnvEvent(a: ArgusEvent): EnvEvent | null {
  const tier = TIER_OF[a.surface];
  if (!tier) return null;
  const p = a.payload || {};
  const detail: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) {
    if (!["node_id", "node_kind", "pid", "ppid", "runtime", "provider", "runtime_kind", "process", "remote_host", "remote_ip", "remote_port", "path", "fidelity", "label"].includes(k)) detail[k] = v;
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
  onEvent?: (e: EnvEvent) => void;
  fsDir?: string | null;
  retentionDays?: number;
}

let sink: ((a: ArgusEvent) => void) | null = null;
let fsHandle: WatcherHandle | null = null;
let netAdapter: NetworkAdapter | null = null;

function selfPaths(): string[] {
  try {
    const f = (db as unknown as { filename?: string }).filename;
    return f ? [f] : [];
  } catch {
    return [];
  }
}

function canonicalExisting(p: string): string | null {
  try {
    return realpathSync.native(resolve(p));
  } catch {
    return null;
  }
}

/** Used for provenance labels and tests; broad mode may deliberately exceed it. */
export function isArgusWorkspacePath(target: string, root = workspaceRoot()): boolean {
  if (!root) return false;
  const canonicalRoot = canonicalExisting(root);
  const canonicalTarget = canonicalExisting(target);
  if (!canonicalRoot || !canonicalTarget) return false;
  const rel = relative(canonicalRoot, canonicalTarget);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function startFsWatcher(dir: string): void {
  // ${WATCH_DIR} rules are rebound whenever the operator moves the lens.
  reloadRedlines(dir);
  fsHandle = startWatcher(dir, (change) => {
    const redline = evaluateFileObservation(change);
    sink?.({
      ts: change.ts,
      agent_id: null,
      parent_id: null,
      surface: "file",
      action: change.action,
      target: change.path,
      status: redline ? "redline" : "ok",
      payload: {
        path: change.path,
        diff: change.diff,
        fidelity: "fs_observed",
        scope: isArgusWorkspacePath(dir) ? "workspace" : "operator_expanded",
        redline: redline?.rule ?? null,
        containment_available: redline?.containment_available ?? false,
        containment_note: redline && !redline.containment_available
          ? "filesystem watcher identified the path but not the writer pid"
          : null,
      },
    });
  }, { exclude: selfPaths() });
  status.file = { enabled: true, available: fsHandle.available, dir };
}

/**
 * Enable, disable, or move filesystem observation.
 *
 * The tier is off by default. Supplying a directory is the operator's explicit
 * scope decision. It may be the workspace, a parent, a drive root, or `/`.
 * Argus labels non-workspace observation as operator-expanded rather than
 * pretending it is agent-attributed.
 */
export async function setFsWatch({ enabled, dir }: { enabled: boolean; dir?: string | null }): Promise<EnvTierStatus> {
  await fsHandle?.close();
  fsHandle = null;

  if (!enabled) {
    status.file = { enabled: false, available: false, dir: status.file.dir };
    writeSettings({ fs_enabled: false });
    return status;
  }

  const requested = dir || status.file.dir || process.env.GLASSES_FS_DIR || workspaceRoot() || null;
  const target = requested ? canonicalExisting(requested) : null;
  if (!target) {
    console.error("[argus] filesystem observation refused: choose an existing directory");
    // A typo must not replace the last working lens. Keep that path available
    // so the user can turn watching back on after correcting the draft.
    status.file = { enabled: false, available: false, dir: status.file.dir };
    writeSettings({ fs_enabled: false });
    return status;
  }

  startFsWatcher(target);
  writeSettings({ fs_enabled: true, fs_dir: target });
  return status;
}

/** AI-relevant by default; true is an explicit whole-network diagnostic lens. */
export function setNetworkScope(all: boolean): EnvTierStatus {
  status.network.all = all;
  netAdapter?.setAll(all);
  writeSettings({ network_all: all });
  return status;
}

export function startEnvTier({ onEvent, fsDir, retentionDays = 0 }: StartEnvTierOpts = {}): EnvTierHandle {
  if (!ENV_TIER_ENABLED) {
    status = { ...status, enabled: false };
    return { stop: async () => {}, status: envTierStatus };
  }

  sink = (a: ArgusEvent) => {
    try {
      const env = toEnvEvent(a);
      if (!env) return;
      const storedEvent = insertEnvEvent(env);
      onEvent?.(storedEvent);
    } catch (e: any) {
      console.error(`[argus] failed to record env event: ${e?.message ?? e}`);
    }
  };

  const ctx = { emit: (a: ArgusEvent) => sink?.(a) };
  const adapters: Array<{ stop: () => void | Promise<void> }> = [];

  if (PROCESS_SCAN) {
    const proc = new ProcessAdapter({ pollMs: PROCESS_POLL_MS, includeCommand: INCLUDE_CMDLINE, ollamaUrl: OLLAMA_URL });
    void proc.start(ctx);
    adapters.push(proc);
    status.process.enabled = true;
  }

  if (NETWORK_SCAN) {
    netAdapter = new NetworkAdapter({ pollMs: NETWORK_POLL_MS, all: NETWORK_ALL });
    void netAdapter.start(ctx);
    adapters.push(netAdapter);
    status.network.enabled = true;
    status.network.all = NETWORK_ALL;
  }

  status.file.dir = process.env.GLASSES_FS_DIR || stored.fs_dir || fsDir || workspaceRoot() || null;
  if (FS_WATCH) {
    const target = status.file.dir ? canonicalExisting(status.file.dir) : null;
    if (target) startFsWatcher(target);
    else {
      console.error("[argus] filesystem observation requested without a valid directory; tier remains off");
      status.file = { enabled: false, available: false, dir: status.file.dir };
      writeSettings({ fs_enabled: false });
    }
  } else {
    reloadRedlines(status.file.dir);
  }

  let pruneTimer: ReturnType<typeof setInterval> | null = null;
  if (retentionDays > 0) {
    pruneTimer = setInterval(() => {
      try { pruneEnvEvents(retentionDays); } catch { /* next sweep */ }
      try { pruneAgentPids(); } catch { /* next sweep */ }
    }, 6 * 3600_000);
    (pruneTimer as any).unref?.();
  }

  status.enabled = true;
  const bits = [
    status.process.enabled ? `agent processes ${PROCESS_POLL_MS}ms` : null,
    status.network.enabled ? `network ${NETWORK_POLL_MS}ms${status.network.all ? " (every process)" : " (AI/agent relevant)"}` : null,
    status.file.enabled ? `files ${status.file.available ? status.file.dir : "unavailable"}` : null,
  ].filter(Boolean);
  console.log(`   Argus → ${bits.length ? bits.join(", ") : "ready; no observation enabled"}`);

  return {
    status: envTierStatus,
    stop: async () => {
      if (pruneTimer) clearInterval(pruneTimer);
      for (const adapter of adapters) await adapter.stop();
      await fsHandle?.close();
      fsHandle = null;
      netAdapter = null;
      sink = null;
      status = { ...status, enabled: false };
    },
  };
}
