// Glasses for Argus — scoped agent-integrity and development provenance.
//
// MIT © 2026 Zac Rieger. See NOTICE.md for provenance.
//
// Argus deliberately stops at the active AgentGlass workspace boundary here.
// It compares what agents report with what the selected project actually does.
// It is not an endpoint-security product: host-wide process, socket, boot,
// driver, registry, persistence, packet-content, and enforcement collection are
// outside this foundation.

import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { ProcessAdapter } from "./processes";
import { NetworkAdapter } from "./network";
import { startWatcher, type WatcherHandle } from "./watcher";
import { insertEnvEvent, pruneEnvEvents, pruneAgentPids } from "./store";
import { db } from "../db.ts";
import { workspaceRoot } from "../config.ts";
import { readSettings, writeSettings, resolveFlag } from "./settings";
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

/**
 * The tier may exist without starting a sensor. This keeps the UI/API stable
 * while making every observation capability an explicit operator decision.
 */
export const ENV_TIER_ENABLED = flag("GLASSES_ENV_TIER", true);

/**
 * Experimental supporting sensors. They are OFF by default because continuous
 * host process/socket observation belongs to the deferred host-security
 * identity, not the current agent-integrity foundation.
 */
export const PROCESS_SCAN = flag("GLASSES_PROCESS_SCAN", false);
export const NETWORK_SCAN = flag("GLASSES_NETWORK_SCAN", false);

const stored = readSettings();

/** Filesystem observation remains opt-in and is always project-scoped. */
export const FS_WATCH = resolveFlag("GLASSES_FS_WATCH", stored.fs_enabled, false);

const PROCESS_POLL_MS = num("GLASSES_PROCESS_POLL_MS", 5000);
const NETWORK_POLL_MS = num("GLASSES_NETWORK_POLL_MS", 10000);
const INCLUDE_CMDLINE = flag("GLASSES_PROCESS_CMDLINE", false);

/** Never widened by the current product identity. */
const NETWORK_ALL = false;
const OLLAMA_URL = process.env.GLASSES_OLLAMA_URL || "http://127.0.0.1:11434";

const TIER_OF: Record<string, EnvTier> = {
  process: "process",
  network: "network",
  file: "file",
  pty: "pty",
};

/** Map an Argus event onto the flat, queryable environment row. */
export function toEnvEvent(a: ArgusEvent): EnvEvent | null {
  const tier = TIER_OF[a.surface];
  if (!tier) return null;
  const p = a.payload || {};

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
  network: { enabled: false, poll_ms: NETWORK_POLL_MS, all: false },
  file: { enabled: false, available: false, dir: null },
  platform: process.platform,
};

export function envTierStatus(): EnvTierStatus {
  return status;
}

export interface StartEnvTierOpts {
  /** Called for every persisted environment event, for live broadcast. */
  onEvent?: (e: EnvEvent) => void;
  /** Initial active AgentGlass workspace. */
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

/** True only when target is the active workspace or a descendant of it. */
export function isArgusWorkspacePath(target: string, root = workspaceRoot()): boolean {
  if (!root) return false;
  const canonicalRoot = canonicalExisting(root);
  const canonicalTarget = canonicalExisting(target);
  if (!canonicalRoot || !canonicalTarget) return false;
  const rel = relative(canonicalRoot, canonicalTarget);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function startFsWatcher(dir: string): void {
  fsHandle = startWatcher(
    dir,
    (change) => {
      sink?.({
        ts: change.ts,
        agent_id: null,
        parent_id: null,
        surface: "file",
        action: change.action,
        target: change.path,
        status: "ok",
        payload: { path: change.path, diff: change.diff, fidelity: "fs_observed" },
      });
    },
    { exclude: selfPaths() },
  );
  status.file = { enabled: true, available: fsHandle.available, dir };
}

/**
 * Enable, disable, or move filesystem observation. The requested path must be
 * the active workspace or one of its descendants. Whole-machine, home-folder,
 * sibling-project, and arbitrary-path watching are refused by construction.
 */
export async function setFsWatch({ enabled, dir }: { enabled: boolean; dir?: string | null }): Promise<EnvTierStatus> {
  await fsHandle?.close();
  fsHandle = null;

  if (!enabled) {
    status.file = { enabled: false, available: false, dir: status.file.dir };
    writeSettings({ fs_enabled: false });
    return status;
  }

  const root = workspaceRoot();
  const requested = dir || root || null;
  if (!requested || !root || !isArgusWorkspacePath(requested, root)) {
    console.error("[argus] filesystem observation refused: choose the active workspace or a descendant");
    status.file = { enabled: false, available: false, dir: root ?? null };
    writeSettings({ fs_enabled: false, fs_dir: root ?? null });
    return status;
  }

  const target = canonicalExisting(requested)!;
  startFsWatcher(target);
  writeSettings({ fs_enabled: true, fs_dir: target });
  return status;
}

/**
 * Identity-3 boundary: the current foundation never widens socket collection to
 * every program. Kept for API compatibility; requests to widen are refused.
 */
export function setNetworkScope(_all: boolean): EnvTierStatus {
  status.network.all = false;
  netAdapter?.setAll(false);
  writeSettings({ network_all: false });
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
    netAdapter = new NetworkAdapter({ pollMs: NETWORK_POLL_MS, all: false });
    void netAdapter.start(ctx);
    adapters.push(netAdapter);
    status.network.enabled = true;
    status.network.all = false;
  }

  const root = workspaceRoot() || fsDir || null;
  status.file.dir = root;
  if (FS_WATCH) {
    if (root && isArgusWorkspacePath(root, root)) startFsWatcher(canonicalExisting(root)!);
    else {
      console.error("[argus] filesystem observation requested without an active workspace; tier remains off");
      status.file = { enabled: false, available: false, dir: root };
      writeSettings({ fs_enabled: false, fs_dir: root });
    }
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
    status.process.enabled ? `experimental process ${PROCESS_POLL_MS}ms` : null,
    status.network.enabled ? `experimental AI-only network ${NETWORK_POLL_MS}ms` : null,
    status.file.enabled ? `project files ${status.file.available ? status.file.dir : "unavailable"}` : null,
  ].filter(Boolean);
  console.log(`   Argus → ${bits.length ? bits.join(", ") : "ready; no observation enabled"}`);

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
