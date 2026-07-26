// Control plane: a PreToolUse gate. An opt-in hook long-polls POST /gate with a
// pending tool call; agentglass holds it open until a human approves/denies from
// the dashboard (or a timeout auto-allows). This is the remote for the fleet.
//
// Safety: default-allow on timeout, and the hook exits 0 (allow) if agentglass
// is unreachable — the control plane never blocks agents by accident.
//
// Durability: every request is written to SQLite on arrival and updated when it
// resolves. A restart re-hydrates the still-live ones (see restoreGates), so a
// crash no longer turns "waiting for a human" into a silent auto-allow, and the
// held connection is no longer the only place a pending request exists — a hook
// whose connection dropped can re-attach with awaitGate(id).
import type { PendingGate } from "../../shared/types.ts";
import type { ClientIdentity } from "./clientIdentity.ts";
import { pushGate } from "./alerts.ts";
import { recordGate, resolveGateRow, undecidedGates, getGate } from "./db.ts";
export type GateDecision = "allow" | "deny";
export type GateOutcome = { decision: GateDecision; reason: string };

interface Pending extends PendingGate {
  expires: number;
  // The held connection, when there is one. A restored request has none until a
  // hook re-attaches — it is still pending, still decidable, still in the queue.
  resolve?: (d: GateOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
}

// The gate is fail-open by design: a timeout (or an unreachable server) never
// blocks an agent. Set this to invert that — a tool call that no human decides
// within the timeout is DENIED. Opt-in, because it means a slow or absent human
// stops the fleet; that is the point for security-sensitive use.
const FAIL_CLOSED = process.env.AGENTGLASS_GATE_FAILCLOSED === "1";

// The clamp is a DoS guard (each waiter pins a held connection + timer), but a
// hard 120s silently defeated the documented AGENTGLASS_GATE_TIMEOUT knob: an
// operator asking for a 5-minute approval window got auto-resolved at 2. The
// operator's own configured timeout now raises the ceiling.
export const GATE_MAX_MS = Math.max(120_000, (Number(process.env.AGENTGLASS_GATE_TIMEOUT) || 60) * 1000);

const waiters = new Map<string, Pending>();
let onChange: () => void = () => {};
export function onGateChange(fn: () => void) { onChange = fn; }

/** What a timeout resolves to, under the configured policy. */
function timeoutOutcome(): GateOutcome {
  if (FAIL_CLOSED) return { decision: "deny", reason: "gate timeout — no decision (fail-closed)" };
  // Empty reason so the hook falls through to Claude Code's own permission
  // prompt instead of force-allowing — an auto-allow shouldn't silently
  // skip the human it was meant to ask.
  return { decision: "allow", reason: "" };
}

/** Ids come from the hook now (so it can re-attach after a dropped connection),
 *  which makes them attacker-influenceable. Accept only uuid-shaped ones; a
 *  request that brings anything else gets a server-generated id instead. */
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const validGateId = (id: unknown): id is string => typeof id === "string" && ID_RE.test(id);

function finish(
  id: string,
  out: GateOutcome,
  resolution: "human" | "timeout" | "restart",
  client: ClientIdentity | null = null,
): void {
  const w = waiters.get(id);
  if (w) {
    clearTimeout(w.timer);
    waiters.delete(id);
  }
  resolveGateRow(id, out.decision, out.reason, resolution, Date.now(), client);
  w?.resolve?.(out);
  onChange();
}

/** Arm the expiry timer for a pending request. Anchored to the *original*
 *  deadline, so a reconnect (or a restart) never extends the window. */
function arm(id: string, expires: number): ReturnType<typeof setTimeout> {
  // Deliberately NOT unref'd, despite the appeal of "don't let a held gate keep
  // the process alive".
  //
  // This timer is the only thing that can settle the promise submitGate returns.
  // Under `bun test` on Windows (1.3.14) an unref'd timer never fires when it is
  // the sole pending work, so `await submitGate(...)` deadlocked and hung the
  // whole suite — verified: the same await completes with a ref'd timer, and an
  // unref'd one fires fine in a normal process whose loop is kept alive by the
  // listening socket. A timer nothing can await is not a saving.
  //
  // Process exit is handled properly instead: finish() clears the timer on every
  // resolution path, and shutdownGates() clears any still pending.
  return setTimeout(() => finish(id, timeoutOutcome(), "timeout"), Math.max(0, expires - Date.now()));
}

/** Drop every pending timer so a shutting-down process is not held open by a
 *  gate nobody is going to answer. The rows stay in SQLite and restoreGates()
 *  picks them up again on the next boot — that is the durability guarantee. */
export function shutdownGates(): void {
  for (const w of waiters.values()) clearTimeout(w.timer);
  waiters.clear();
}

/** Hold a tool call until decided or the timeout auto-allows. */
export function submitGate(
  req: { source_app: string; session_id: string; tool_name: string; summary: string; id?: string },
  timeoutMs: number
): Promise<GateOutcome> {
  // Floor the timeout: a negative value (a repo-local settings.json can set
  // AGENTGLASS_GATE_TIMEOUT=-1) makes setTimeout fire immediately, turning the
  // gate into an instant auto-allow. Never below 1s, never above 2min.
  const wait = Math.max(1000, Math.min(GATE_MAX_MS, Number.isFinite(timeoutMs) ? timeoutMs : 60_000));
  // A hook that re-POSTs an id it already sent is retrying, not asking twice:
  // re-attach to the live request (or replay the outcome it missed) instead of
  // creating a second one that would strand the first's held connection.
  if (validGateId(req.id)) {
    const again = awaitGate(req.id);
    if (again) return Promise.resolve(again);
  }
  const id = validGateId(req.id) ? req.id : crypto.randomUUID();
  const created = Date.now();
  const expires = created + wait;
  const { source_app, session_id, tool_name, summary } = req;
  // Persist before holding the connection: if the process dies a millisecond
  // later, the request still exists somewhere a restart can find it.
  recordGate({ id, source_app, session_id, tool_name, summary, created, expires });
  return new Promise((resolve) => {
    waiters.set(id, { id, source_app, session_id, tool_name, summary, created, expires, resolve, timer: arm(id, expires) });
    pushGate(`${source_app}:${session_id.slice(0, 8)}`, tool_name, summary);
    onChange();
  });
}

/**
 * Re-attach to a request whose connection dropped (a server restart, a proxy
 * hanging up). Returns the recorded outcome if it has already been decided, a
 * promise that resolves when it is if it's still pending, or null when the id
 * is unknown — which the hook must treat as "no answer" rather than as a
 * decision.
 */
export function awaitGate(id: string): Promise<GateOutcome> | GateOutcome | null {
  if (!validGateId(id)) return null;
  const w = waiters.get(id);
  if (w) {
    return new Promise((resolve) => {
      // Last connection wins. The previous one is already gone — that is why
      // the hook is here — and resolving it would write to a dead socket.
      w.resolve = resolve;
    });
  }
  const row = getGate(id);
  if (!row || !row.decision) return null;
  return { decision: row.decision, reason: row.reason || "" };
}

export function decideGate(id: string, decision: GateDecision, reason: string, client: ClientIdentity | null = null): boolean {
  const row = getGate(id);
  // Decidable while pending, whether or not a connection is currently held: a
  // restored request has no waiter and must still take the operator's answer.
  if (!row || row.decision) return false;
  finish(
    id,
    { decision, reason: reason || (decision === "deny" ? "denied from dashboard" : "approved from dashboard") },
    "human",
    client,
  );
  return true;
}

export function pendingGates(): PendingGate[] {
  return [...waiters.values()]
    .map(({ id, source_app, session_id, tool_name, summary, created }) => ({ id, source_app, session_id, tool_name, summary, created }))
    .sort((a, b) => a.created - b.created);
}

/**
 * Rebuild the queue from SQLite at boot.
 *
 * Requests still inside their window go back into "what needs you" and stay
 * decidable — the agent is still held, and its hook is re-polling for exactly
 * this. Ones whose window elapsed while the server was down are resolved by the
 * configured policy and *recorded* as such, so the outcome shows up in history
 * instead of vanishing.
 */
export function restoreGates(): { restored: number; expired: number } {
  const now = Date.now();
  let restored = 0, expired = 0;
  for (const row of undecidedGates()) {
    if (row.expires <= now) {
      const out = timeoutOutcome();
      // out.reason verbatim — never backfilled. timeoutOutcome() leaves the
      // reason EMPTY on a fail-open allow on purpose, so the re-attaching hook
      // falls through to Claude Code's own permission prompt; a non-empty reason
      // makes the hook force-allow and skip that prompt. The live-timeout path
      // (finish → resolveGateRow) preserves the empty reason too, and a restart
      // must not silently turn a pending gate into a prompt-skipping auto-allow.
      resolveGateRow(row.id, out.decision, out.reason, "restart", now);
      expired++;
      continue;
    }
    waiters.set(row.id, {
      id: row.id,
      source_app: row.source_app,
      session_id: row.session_id,
      tool_name: row.tool_name,
      summary: row.summary,
      created: row.created,
      expires: row.expires,
      timer: arm(row.id, row.expires),
    });
    restored++;
  }
  if (restored || expired) onChange();
  return { restored, expired };
}
