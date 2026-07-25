// AgentGlass Argus integration — environment-tier types shared by server and UI.
//
// MIT © 2026 Zac Rieger. See NOTICE.md.
//
// Kept out of shared/types.ts on purpose: everything in that file describes
// what an agent reported about itself, and these describe the opposite — what
// the machine shows about software that reported nothing. Separate file,
// separate table, separate lens.

export type EnvTier = "process" | "network" | "file" | "pty";

/**
 * How much this observation is allowed to mean.
 *
 * The environment tier's core rule is that a weak signal must never be dressed
 * up as a strong one, so every row carries its own ceiling:
 *
 *  presence_only        — a process exists. Says NOTHING about prompts,
 *                         tool calls, model output, or intent.
 *  runtime_api          — a local runtime API named a model it has loaded.
 *  connection_metadata  — who talked to which endpoint. Never contents.
 *  fs_observed          — a write happened on disk. Author unknown.
 */
export type EnvFidelity =
  | "presence_only"
  | "runtime_api"
  | "connection_metadata"
  | "fs_observed"
  | "pty_recorded";

export interface EnvEvent {
  id?: number;
  ts: number;
  tier: EnvTier;
  /** process_discovered | process_stopped | model_loaded | model_unloaded
   *  | net_connect | net_close | fs_create | fs_write | fs_delete */
  action: string;
  target: string;
  node_id: string | null;
  parent_node_id: string | null;
  pid: number | null;
  ppid: number | null;
  runtime: string | null;
  provider: string | null;
  runtime_kind: string | null;
  process_name: string | null;
  remote_host: string | null;
  remote_ip: string | null;
  remote_port: number | null;
  path: string | null;
  fidelity: EnvFidelity;
  attributed: 0 | 1;
  detail: Record<string, unknown>;
}

export interface EnvRuntime {
  node_id: string;
  label: string;
  runtime: string | null;
  provider: string | null;
  runtime_kind: string | null;
  pid: number | null;
  first_seen: number;
  last_seen: number;
  running: boolean;
  /** Present in the OS, but nothing claims it. The number the tier exists for. */
  blind: boolean;
  /**
   * How strongly "it is reporting" is known.
   *
   *  process  — a hook reported from this exact pid (or its parent). Exact.
   *  provider — only that some session of the same vendor is reporting. A
   *             fallback used when no hook has volunteered a pid at all.
   *  none     — nothing claims it; this is what `blind` means.
   */
  attribution: "process" | "provider" | "none";
  models: Array<{
    name?: string;
    parameter_size?: string | null;
    quantization_level?: string | null;
    size_vram?: number | null;
  }>;
}

export interface EnvConnection {
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

export interface EnvSummary {
  runtimes_running: number;
  runtimes_blind: number;
  connections_open: number;
  connections_ai_endpoint: number;
  file_events_last_hour: number;
}

/**
 * The filesystem map: one tree carrying both halves of the merge.
 *
 * `touches` is agentglass's labeled data — a tool call that named this exact
 * file, so the agent is known. `unclaimed` is Argus's — a write on disk that no
 * tool call accounts for, where the writer is NOT known. They are separate
 * fields rather than one total precisely because they mean different things,
 * and averaging them into "activity" would throw away the distinction the whole
 * project is about.
 */
export interface MapNode {
  path: string;
  name: string;
  depth: number;
  kind: "dir" | "file";
  touches: number;
  unclaimed: number;
  agents: string[];
  last_ts: number;
  last_tool: string | null;
}

export interface MapAgent {
  session_id: string;
  source_app: string;
  current: string | null;
  trail: string[];
  touches: number;
  last_ts: number;
}

export interface FsMap {
  root: string | null;
  nodes: MapNode[];
  truncated: boolean;
  total_nodes: number;
  agents: MapAgent[];
  fs_tier_enabled: boolean;
  unclaimed_total: number;
}

/**
 * One lane per actor. The `kind` is a statement about how well we know who did
 * it, and the UI colours by it rather than by tier for exactly that reason:
 *
 *   runtime       recognized AI process                — named
 *   program       any process holding a socket         — named ("firefox")
 *   unattributed  a file write                         — CANNOT be named
 *   shell         a recorded terminal                  — named by its operator
 *
 * `unattributed` is a platform fact, not a gap to close later: neither
 * ReadDirectoryChangesW nor FSEvents reports the writing process. `shell` sits
 * at the opposite end — a human deliberately attached a recorder to a specific
 * terminal, so it is the only tier whose name is authoritative rather than
 * inferred.
 */
export interface ActorLane {
  actor: string;
  kind: "runtime" | "program" | "unattributed" | "shell";
  tier: EnvTier;
  count: number;
  last_ts: number;
  provider: string | null;
  events: EnvEvent[];
  /** Activity per time bucket across the window, oldest first — the lane's own
   *  timeline. Counts, not flags, so a burst looks different from a trickle. */
  buckets: number[];
}

export interface SuspectRollup {
  unattributed_writes: number;
  unattributed_paths: number;
  silent_runtimes: number;
  window_ms: number;
  recent: EnvEvent[];
}

/**
 * Redlines — the policy layer agentglass's gate has no notion of.
 *
 * Its gate holds whatever a hook chooses to send, so "what is dangerous" lives
 * scattered across each project's settings.json matcher. These rules live in
 * one auditable file and are evaluated server-side, in front of the gate. They
 * can only ever make it stricter.
 */
export interface RedlineRuleInfo {
  id: string;
  description: string;
  enabled: boolean;
  kind: "command" | "path" | "file" | "any";
  action: string | null;
  target: string | null;
  operations: Array<"create" | "write" | "delete">;
  protected_path: string | null;
  decision: "flag" | "gate" | "kill";
  /** Compatibility projection of decision=kill. */
  kill: boolean;
}

export interface RedlineRuleInput {
  id: string;
  description?: string;
  enabled?: boolean;
  kind?: RedlineRuleInfo["kind"];
  action?: string | null;
  target?: string | null;
  operations?: RedlineRuleInfo["operations"];
  protected_path?: string | null;
  decision?: RedlineRuleInfo["decision"];
}

export interface RedlineStatus {
  file: string;
  loaded_from: string | null;
  /** Set when the rules file exists but could not be parsed. A security control
   *  that silently allows everything after a typo is the failure mode to avoid,
   *  so this is surfaced rather than swallowed. */
  error: string | null;
  rules: RedlineRuleInfo[];
}

/** A held gate we know how to stop, because its hook told us its pid. */
export interface KillableGate {
  id: string;
  pid: number;
  rule: { id: string; description: string; kill: boolean } | null;
}

export interface ReplayBounds {
  first: number | null;
  last: number | null;
  count: number;
}

export interface ReplayState {
  at: number;
  runtimes: Array<{
    node_id: string;
    label: string;
    runtime: string | null;
    provider: string | null;
    running: boolean;
  }>;
  connections: number;
  file_writes: number;
  window: EnvEvent[];
}

/** A recorded shell, reassembled from its chunks in sequence order. */
export interface PtyShell {
  agent: string;
  command: string;
  host: string | null;
  started: number;
  last_ts: number;
  chunks: number;
  ended: boolean;
  /** Decoded output, oldest first. */
  output: string;
}

/**
 * A coalesced "the environment moved" signal.
 *
 * Carries counts, never rows. See the WsFrame comment in types.ts for why:
 * per-row broadcast turned a busy filesystem into a fan-out storm on the ingest
 * hot path, for data nothing consumed.
 */
export interface EnvTick {
  /** Observations since the last tick. */
  count: number;
  /** Newest observation's timestamp. */
  last_ts: number;
  /** How many of each tier, so a view can skip a re-read it does not need. */
  tiers: Partial<Record<EnvTier, number>>;
}

export interface EnvTierStatus {
  enabled: boolean;
  process: { enabled: boolean; poll_ms: number; cmdline: boolean };
  network: { enabled: boolean; poll_ms: number; all: boolean };
  file: { enabled: boolean; available: boolean; dir: string | null };
  platform: string;
}
