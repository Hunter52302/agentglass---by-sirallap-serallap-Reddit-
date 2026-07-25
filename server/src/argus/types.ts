// Glasses for Argus — server-side environment tier types.
//
// MIT © 2026 Zac Rieger. See NOTICE.md.
//
// The wire types the UI also needs live in shared/env.ts and are re-exported
// here. What stays server-only is the Argus §5 event shape and the adapter
// interface — the UI never sees either.

export type {
  EnvTier,
  EnvFidelity,
  EnvEvent,
  EnvRuntime,
  EnvConnection,
  EnvSummary,
  EnvTierStatus,
  PtyShell,
} from "../../../shared/env.ts";

/**
 * The §5 event shape Argus adapters emit.
 *
 * Kept verbatim rather than collapsed into EnvEvent so the vendored sensors in
 * this directory stay diffable against Argus upstream — the mapping to the flat
 * storage row happens in one place (index.ts), which is the only file that has
 * to change if either side's shape moves.
 */
export interface ArgusEvent {
  ts: number;
  agent_id: string | null;
  parent_id: string | null;
  surface: "file" | "token" | "pty" | "gui" | "process" | "network";
  action: string;
  target: string | null;
  /** `redline` means the observation matched operator policy. It does not imply
   * the actor was identified or successfully contained. */
  status: "start" | "ok" | "error" | "awaiting_approval" | "redline";
  payload: Record<string, any>;
}

export interface AdapterCtx {
  emit: (e: ArgusEvent) => void;
}

/**
 * Every capture source implements this and nothing more: start producing
 * events, stop producing them. `ctx.emit` is the adapter's ONLY output, which
 * is what lets a new sensor (an eBPF probe, an Endpoint Security extension, a
 * remote host) be added without the core knowing anything about it.
 */
export interface Adapter {
  name: string;
  start(ctx: AdapterCtx): void | Promise<void>;
  stop(): void | Promise<void>;
}
