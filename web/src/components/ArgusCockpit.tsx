// AgentGlass Argus integration — Argus's own cockpit.
//
// MIT © 2026 Zac Rieger. See NOTICE.md at the repo root.
//
// ─────────────────────────────────────────────────────────────────────────────
// A SEPARATE SURFACE, ON PURPOSE.
//
// agentglass's cockpit answers "what is my fleet doing and what is it costing
// me". Every widget there assumes a labeled, semantic event with a session
// behind it. Argus asks a different question — "what is running on this machine
// and what is touching my files" — and most of its answers have no session, no
// cost, and frequently no name at all.
//
// Squeezing that into the other cockpit meant either lying about fidelity or
// hiding the interesting parts. So it gets its own room, shaped the way Argus
// was shaped, and the two can be reconciled later once this one has settled.
//
// THE ORGANIZING IDEA: an actor is whoever is doing something, and the three
// tiers name actors with very different confidence:
//
//   runtime       a recognized AI process              — named
//   program       any process holding a socket         — named ("firefox")
//   unattributed  a file write                         — writer CANNOT be named
//
// That last one is not a bug to be fixed later. Neither ReadDirectoryChangesW
// (Windows) nor FSEvents (macOS) reports the writing process, so a file event
// genuinely has no author. Argus's posture is that an unclaimed action must
// STAND OUT rather than be quietly folded into a labeled column — which is why
// the suspect band sits across the top and goes red when it has anything in it.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Portal } from "./Portal.tsx";
import { RedlineEditor } from "./RedlineEditor.tsx";
import { useDialogs } from "./ConfirmDialog.tsx";
import { usePoll } from "../lib/usePoll.ts";
import { api } from "../lib/api.ts";
import { MapView } from "./MapPanel.tsx";
import { PathAutocomplete } from "./PathAutocomplete.tsx";
import { ArgusEyeIcon } from "./ArgusIcon.tsx";
import { IS_MAC_DESKTOP } from "../lib/desktop.ts";
import type {
  EnvEvent, EnvTierStatus, EnvSummary, ActorLane, SuspectRollup,
  RedlineStatus, KillableGate, ReplayBounds, ReplayState, PtyShell,
} from "../../../shared/env.ts";
import type { PendingGate } from "../../../shared/types.ts";

type TierFilter = "all" | "process" | "network" | "file" | "pty";

const KIND_COLOR: Record<ActorLane["kind"], string> = {
  // Unknown does not mean hostile. Amber marks an evidence gap without turning
  // ordinary editor/build writes into a red security finding.
  unattributed: "var(--warning)",
  program: "var(--info)",
  runtime: "var(--success)",
  // A recorded shell is the only actor here whose name a human typed, so it
  // gets the accent rather than one of the inferred-tier colours.
  shell: "var(--primary)",
};

const fmtTime = (ts: number) =>
  new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

const ago = (ts: number) => {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
};

/** Middle-ellipsis: the end of a path carries the filename, which is the part
 *  that identifies it — truncating from the right throws that away. */
function midEllipsis(s: string, max = 64) {
  if (s.length <= max) return s;
  const keep = Math.floor((max - 1) / 2);
  return s.slice(0, keep) + "…" + s.slice(-keep);
}

function Stat({ label, value, tone = "var(--text)" }: { label: string; value: number | string; tone?: string }) {
  return (
    <div className="flex flex-col shrink-0">
      <span className="text-[20px] font-semibold tabular-nums leading-none" style={{ color: tone }}>{value}</span>
      <span className="text-[9px] uppercase tracking-wide mt-1" style={{ color: "var(--text3)" }}>{label}</span>
    </div>
  );
}

/**
 * A lane's own timeline.
 *
 * Filtering the feed by actor answers "what did it do"; this answers "WHEN".
 * Rendered as bars rather than a line because the values are counts in discrete
 * buckets, and a line between them would imply activity in the gaps that did
 * not happen. Normalised per lane so a quiet actor still shows its own shape
 * instead of being flattened by a noisy neighbour.
 */
function LaneSpark({ buckets, color }: { buckets: number[]; color: string }) {
  if (!buckets?.length) return null;
  const max = Math.max(...buckets);
  if (max <= 0) return null;
  const W = 54, H = 12, n = buckets.length;
  const bw = W / n;
  return (
    <svg width={W} height={H} className="shrink-0" aria-hidden style={{ display: "block" }}>
      {buckets.map((v, i) =>
        v > 0 ? (
          <rect key={i} x={i * bw} y={H - Math.max(1.5, (v / max) * H)}
            width={Math.max(0.7, bw - 0.35)} height={Math.max(1.5, (v / max) * H)}
            fill={color} fillOpacity={0.5 + 0.5 * (v / max)} />
        ) : null
      )}
    </svg>
  );
}

function Toggle({ on, label, title, onClick }: { on: boolean; label: string; title: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="flex items-center gap-1.5 px-2 py-1 rounded-lg text-[11px] font-medium transition-opacity hover:opacity-80"
      style={{
        color: on ? "var(--success)" : "var(--text4)",
        background: `color-mix(in srgb, ${on ? "var(--success)" : "var(--text4)"} 12%, transparent)`,
        border: `1px solid color-mix(in srgb, ${on ? "var(--success)" : "var(--text4)"} 35%, transparent)`,
      }}
    >
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: on ? "var(--success)" : "var(--text4)" }} />
      {label}
    </button>
  );
}

export function ArgusCockpit({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { ask, dialog } = useDialogs();
  const [status, setStatus] = useState<EnvTierStatus | null>(null);
  const [summary, setSummary] = useState<EnvSummary | null>(null);
  const [lanes, setLanes] = useState<ActorLane[]>([]);
  const [suspect, setSuspect] = useState<SuspectRollup | null>(null);
  const [feed, setFeed] = useState<EnvEvent[]>([]);
  const [tier, setTier] = useState<TierFilter>("all");
  const [focus, setFocus] = useState<string | null>(null);
  const [dirDraft, setDirDraft] = useState("");
  const [watchError, setWatchError] = useState("");
  const [busy, setBusy] = useState(false);
  const [surface, setSurface] = useState<"activity" | "map">("activity");
  const [lanesCollapsed, setLanesCollapsed] = useState(false);
  const dirRef = useRef<HTMLInputElement>(null);
  const dirDirty = useRef(false);
  const [redlines, setRedlines] = useState<RedlineStatus | null>(null);
  const [held, setHeld] = useState<PendingGate[]>([]);
  const [killable, setKillable] = useState<KillableGate[]>([]);
  const [bounds, setBounds] = useState<ReplayBounds | null>(null);
  // null = live. A number is a past instant being replayed, and while it is set
  // the polls below stop overwriting the view — a scrubber that keeps snapping
  // back to now is unusable.
  const [replayAt, setReplayAt] = useState<number | null>(null);
  const [replay, setReplay] = useState<ReplayState | null>(null);
  const [shells, setShells] = useState<PtyShell[]>([]);
  const [openShell, setOpenShell] = useState<string | null>(null);
  const [redlineEditorOpen, setRedlineEditorOpen] = useState(false);

  const refresh = useCallback(() => {
    api.envStatus().then((next) => {
      setStatus(next);
      if (!dirDirty.current) setDirDraft(next.file.dir || "");
    }).catch(() => {});
    api.envSummary().then(setSummary).catch(() => {});
    api.envSuspect().then(setSuspect).catch(() => {});
    api.envRedlines().then(setRedlines).catch(() => {});
    api.envKillable().then(setKillable).catch(() => {});
    api.gatePending().then((r) => setHeld(r.gates)).catch(() => {});
    api.envReplayBounds().then(setBounds).catch(() => {});
    api.envShells().then(setShells).catch(() => {});
    // Live lanes and feed only while live — replaying owns them otherwise.
    if (replayAt == null) {
      api.envLanes().then(setLanes).catch(() => {});
      api.envRecent(tier === "all" ? undefined : tier, 200).then(setFeed).catch(() => {});
    }
  }, [tier, replayAt]);

  // Fold the past instant. Separate from the live poll so scrubbing is
  // responsive and does not wait on the 3s tick.
  useEffect(() => {
    if (replayAt == null) { setReplay(null); return; }
    let alive = true;
    api.envReplayAt(replayAt).then((r) => { if (alive) { setReplay(r); setFeed(r.window); } }).catch(() => {});
    return () => { alive = false; };
  }, [replayAt]);

  usePoll(open, refresh, 3000);
  useEffect(() => { if (open) refresh(); }, [open, refresh]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !redlineEditorOpen) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, redlineEditorOpen]);

  const toggleFs = async () => {
    if (busy) return;
    const enabling = !status?.file.enabled;
    const dir = dirDraft.trim() || status?.file.dir || "";
    if (enabling && !dir) {
      setWatchError("Choose a folder first");
      dirRef.current?.focus();
      return;
    }
    setBusy(true);
    setWatchError("");
    try {
      const result = await api.envSetWatch(enabling ? { enabled: true, dir } : { enabled: false });
      setStatus(result.status);
      if (!result.ok) setWatchError(result.error || "Could not change file watching");
      refresh();
    } finally { setBusy(false); }
  };

  const toggleScope = async () => {
    if (busy) return;
    setBusy(true);
    try { await api.envSetScope(!status?.network.all); refresh(); } finally { setBusy(false); }
  };

  const applyDir = async () => {
    if (busy || !dirDraft.trim()) return;
    setBusy(true);
    setWatchError("");
    try {
      const result = await api.envSetWatch({ enabled: true, dir: dirDraft.trim() });
      setStatus(result.status);
      if (!result.ok) setWatchError(result.error || "That folder cannot be watched");
      else {
        dirDirty.current = false;
        setDirDraft(result.status.file.dir || dirDraft.trim());
      }
      refresh();
    } finally { setBusy(false); }
  };

  const shown = useMemo(() => {
    if (!focus) return feed;
    return feed.filter((e) => {
      if (focus === "writer unknown") return e.tier === "file";
      return e.process_name === focus || e.target === focus || e.runtime === focus;
    });
  }, [feed, focus]);

  const hasUnknownWriters = (suspect?.unattributed_writes ?? 0) > 0;
  const hasSilentRuntimes = (suspect?.silent_runtimes ?? 0) > 0;
  const hasEvidenceGap = hasUnknownWriters || hasSilentRuntimes;
  const killableById = useMemo(() => new Map(killable.map((k) => [k.id, k])), [killable]);

  const denyAndKill = async (id: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await api.envKillGate(id);
      if (!r.ok) console.error("[argus] kill refused:", r.error);
      refresh();
    } finally { setBusy(false); }
  };

  const confirmKill = async (id: string, pid: number) => {
    if (!(await ask({
      title: `Deny and force-stop pid ${pid}?`,
      body: "Argus will stop this verified process and every descendant. This is irreversible.",
      confirmLabel: "Deny and kill",
      danger: true,
    }))) return;
    await denyAndKill(id);
  };

  const decide = async (id: string, d: "allow" | "deny") => {
    if (busy) return;
    setBusy(true);
    try { await api.gateDecide(id, d); refresh(); } finally { setBusy(false); }
  };

  if (!open) return null;

  return (
    <>
    <Portal>
      <div className="fixed inset-0 z-[60] flex flex-col" style={{ background: "var(--bg)" }}>
        {/* ── header: the lens, and the controls that move it ── */}
        <div
          className="flex items-center gap-x-3 gap-y-2 px-3 sm:px-5 py-2 shrink-0 border-b flex-wrap"
          style={{
            minHeight: 52,
            borderColor: "color-mix(in srgb, var(--border) 40%, transparent)",
            paddingLeft: IS_MAC_DESKTOP ? 116 : undefined,
          }}
        >
          <span className="flex shrink-0" style={{ color: "var(--primary)" }}>
            <ArgusEyeIcon size={24} animated />
          </span>
          <div className="leading-tight shrink-0">
            <div className="text-[15px] font-bold tracking-tight" style={{ color: "var(--text)" }}>
              Argus
            </div>
            <div className="text-[8px] tracking-wide" style={{ color: "var(--text4)" }}>
              by{" "}
              <a
                href="https://github.com/git-Clem"
                target="_blank"
                rel="noreferrer"
                className="hover:underline"
                style={{ color: "var(--primary-hover)" }}
              >
                git-Clem
              </a>
            </div>
          </div>

          <div className="flex items-center gap-2 sm:ml-4 flex-wrap">
            <Toggle
              on={!!status?.process.enabled}
              label="processes"
              title="OS process table — recognized AI runtimes. Presence only."
              onClick={() => {}}
            />
            <Toggle
              on={!!status?.network.all}
              label={status?.network.all ? "network: OS-visible" : "network: AI only"}
              title={status?.network.note ?? "Socket visibility is still being measured."}
              onClick={toggleScope}
            />
            <Toggle
              on={!!status?.file.enabled}
              label={status?.file.enabled ? "files: on" : "files: off"}
              title="Watch every write in the scoped tree, attributed or not. This is the tier agentglass deliberately never had."
              onClick={toggleFs}
            />
          </div>

          <div className="flex items-center gap-1.5 w-full xl:w-auto xl:ml-auto min-w-0 overflow-x-auto pb-0.5 xl:pb-0">
            <span className="flex items-center gap-0.5 p-0.5 rounded-lg"
              style={{ background: "var(--bg2)", border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)" }}>
              {(["activity", "map"] as const).map((item) => (
                <button key={item} onClick={() => setSurface(item)}
                  className="px-2 py-0.5 rounded text-[10px]"
                  style={{
                    color: surface === item ? "var(--primary-hover)" : "var(--text4)",
                    background: surface === item ? "color-mix(in srgb, var(--primary) 16%, transparent)" : "transparent",
                  }}>
                  {item}
                </button>
              ))}
            </span>
            <span
              className="text-[10px] shrink-0"
              style={{ color: dirDirty.current ? "var(--warning)" : "var(--text4)" }}
              title={dirDirty.current ? `Currently watching ${status?.file.dir || "nothing"}` : undefined}
            >
              {dirDirty.current ? "new lens" : "watching"}
            </span>
            <div className="relative flex-1 min-w-[180px] xl:w-[300px] xl:flex-none">
              <PathAutocomplete
                inputRef={dirRef}
                value={dirDraft}
                onChange={(value) => {
                  dirDirty.current = true;
                  setDirDraft(value);
                }}
                onSubmit={() => void applyDir()}
                placeholder={status?.file.dir || "/Users/you/project"}
              />
              {watchError && <div className="absolute mt-1 text-[9px]" style={{ color: "var(--error)" }}>{watchError}</div>}
            </div>
            <button
              onClick={applyDir}
              className="px-2 py-1 rounded-lg text-[11px] transition-opacity hover:opacity-80 shrink-0"
              style={{ color: "var(--primary-hover)", background: "color-mix(in srgb, var(--primary) 14%, transparent)" }}
            >
              move lens
            </button>
            <button
              onClick={onClose}
              className="px-2 py-1 rounded-lg text-[11px] ml-1 transition-opacity hover:opacity-80 shrink-0"
              style={{ color: "var(--text3)" }}
              title="Close (Esc)"
            >
              ✕
            </button>
          </div>
        </div>

        {surface === "map" ? (
          <div className="flex-1 min-h-0">
            <MapView active={open && surface === "map"} />
          </div>
        ) : (
        <>
        {/* ── stat strip ── */}
        <div className="flex items-center gap-7 px-5 py-3 shrink-0 border-b flex-wrap"
          style={{ borderColor: "color-mix(in srgb, var(--border) 40%, transparent)" }}>
          <Stat label="runtimes" value={summary?.runtimes_running ?? "—"} />
          <Stat label="silent" value={summary?.runtimes_blind ?? "—"}
            tone={summary?.runtimes_blind ? "var(--warning)" : "var(--text)"} />
          <Stat label="actors" value={lanes.length} />
          <Stat label="connections" value={summary?.connections_open ?? "—"} tone="var(--info)" />
          <span
            className="text-[10px] px-2 py-1 rounded"
            style={{
              color: status?.network.visibility === "unavailable" || status?.network.visibility === "limited"
                ? "var(--warning)"
                : "var(--text4)",
              background: "color-mix(in srgb, var(--warning) 8%, transparent)",
            }}
            title={status?.network.note ?? "Socket visibility is still being measured."}
          >
            network: {status?.network.visibility === "os_visible"
              ? "OS-visible"
              : status?.network.visibility ?? "probing"}
          </span>
          <Stat label="writer unknown" value={suspect?.unattributed_writes ?? 0}
            tone={suspect?.unattributed_writes ? "var(--warning)" : "var(--text)"} />
          <Stat label="distinct paths" value={suspect?.unattributed_paths ?? 0} />
          <span className="text-[10px] ml-auto" style={{ color: "var(--text4)" }}>last hour · {status?.platform}</span>
        </div>

        {/* ── suspect band: always visible, red when it has anything ── */}
        <div
          className="px-5 py-2.5 shrink-0 border-b"
          style={{
            borderColor: "color-mix(in srgb, var(--border) 40%, transparent)",
            background: hasEvidenceGap
              ? "color-mix(in srgb, var(--warning) 9%, transparent)"
              : "color-mix(in srgb, var(--success) 7%, transparent)",
          }}
        >
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-[11px] font-semibold uppercase tracking-wide shrink-0"
              style={{ color: hasEvidenceGap ? "var(--warning)" : "var(--success)" }}>
              {hasUnknownWriters
                ? "writer identity unavailable"
                : hasSilentRuntimes
                  ? "runtime not reporting"
                  : "no evidence gaps observed"}
            </span>
            <span className="text-[11px]" style={{ color: "var(--text3)" }}>
              {!status?.file.enabled ? (
                <>File watching is off — turn it on to see writes nobody reported. Until then this band can only
                  report silent runtimes.</>
              ) : suspect?.unattributed_writes ? (
                <>{suspect.unattributed_writes} observed writes across {suspect.unattributed_paths} paths.
                  This watcher does not receive a writer PID. These events are unknown, not untrusted.</>
              ) : (
                <>No filesystem writes with unavailable writer identity were observed in this window.</>
              )}
            </span>
          </div>
          {!!suspect?.recent.length && (
            <div className="flex gap-2 mt-2 overflow-x-auto pb-1">
              {suspect.recent.slice(0, 12).map((e, i) => (
                <span key={`${e.id}-${i}`}
                  className="text-[10px] px-2 py-1 rounded shrink-0 whitespace-nowrap"
                  style={{
                    background: "color-mix(in srgb, var(--error) 12%, transparent)",
                    color: "var(--error)",
                    fontFamily: "var(--font-mono, ui-monospace)",
                  }}
                  title={e.path ?? ""}>
                  {e.action.replace("fs_", "")} {midEllipsis(e.path?.split("/").slice(-2).join("/") ?? "", 40)}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Held AgentGlass gates. Argus adds one redline-only kill control. */}
        {held.length > 0 && (
          <div className="px-5 py-2.5 shrink-0 border-b"
            style={{
              borderColor: "color-mix(in srgb, var(--border) 40%, transparent)",
              background: "color-mix(in srgb, var(--warning) 10%, transparent)",
            }}>
            <div className="flex items-center gap-2 mb-2">
              <span className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: "var(--warning)" }}>
                ⏸ held — waiting on you
              </span>
              <span className="text-[10px]" style={{ color: "var(--text4)" }}>
                {killable.length > 0
                  ? `${killable.length} redline-matched request${killable.length === 1 ? "" : "s"} can be stopped`
                  : "no held request matched a killable redline"}
              </span>
            </div>
            <div className="flex flex-col gap-1.5">
              {held.map((g) => {
                const k = killableById.get(g.id);
                return (
                  <div key={g.id} className="flex items-center gap-2 text-[11px]">
                    <span className="font-medium shrink-0" style={{ color: "var(--text2)" }}>{g.tool_name}</span>
                    {k && (
                      <span className="text-[9px] px-1.5 py-0.5 rounded shrink-0"
                        style={{ background: "color-mix(in srgb, var(--error) 16%, transparent)", color: "var(--error)" }}
                        title={k.rule.description}>
                        redline: {k.rule.id}
                      </span>
                    )}
                    <span className="truncate" style={{ color: "var(--text3)", fontFamily: "var(--font-mono, ui-monospace)" }}
                      title={g.summary}>
                      {midEllipsis(g.summary, 70)}
                    </span>
                    <span className="ml-auto flex items-center gap-1.5 shrink-0">
                      <button onClick={() => decide(g.id, "allow")} disabled={busy}
                        className="px-2 py-0.5 rounded text-[10px] transition-opacity hover:opacity-80"
                        style={{ color: "var(--success)", background: "color-mix(in srgb, var(--success) 14%, transparent)" }}>
                        allow
                      </button>
                      <button onClick={() => decide(g.id, "deny")} disabled={busy}
                        className="px-2 py-0.5 rounded text-[10px] transition-opacity hover:opacity-80"
                        style={{ color: "var(--warning)", background: "color-mix(in srgb, var(--warning) 14%, transparent)" }}>
                        deny
                      </button>
                      {/* Argus's sole intervention appears only when a user-owned
                          redline matched and the held request supplied a PID. */}
                      {k && (
                        <button
                          onClick={() => void confirmKill(g.id, k.pid)}
                          disabled={busy}
                          title={`Stops redline-matched pid ${k.pid} and its children`}
                          className="px-2 py-0.5 rounded text-[10px] transition-opacity hover:opacity-80 disabled:opacity-30"
                          style={{ color: "var(--error)", background: "color-mix(in srgb, var(--error) 16%, transparent)" }}>
                          deny &amp; kill
                        </button>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── recorded shells ──
            The only tier here that is not inferred from the OS. agentglass's
            terminal panel can only show a shell it launched; these are shells
            that already existed — including ones on other machines — attached
            with tools/argus-record.mjs. */}
        {shells.length > 0 && (
          <div className="shrink-0 border-b" style={{ borderColor: "color-mix(in srgb, var(--border) 40%, transparent)" }}>
            <div className="flex items-center gap-2 px-5 py-2 flex-wrap">
              <span className="text-[11px] font-semibold uppercase tracking-wide shrink-0" style={{ color: "var(--primary-hover)" }}>
                ⌘ recorded shells
              </span>
              {shells.map((sh) => {
                const on = openShell === sh.agent;
                return (
                  <button key={sh.agent} onClick={() => setOpenShell(on ? null : sh.agent)}
                    className="flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] transition-opacity hover:opacity-80"
                    style={{
                      color: on ? "var(--primary-hover)" : "var(--text3)",
                      background: on
                        ? "color-mix(in srgb, var(--primary) 16%, transparent)"
                        : "color-mix(in srgb, var(--text4) 10%, transparent)",
                    }}
                    title={sh.command}>
                    <span className="w-1.5 h-1.5 rounded-full"
                      style={{ background: sh.ended ? "var(--text4)" : "var(--success)" }} />
                    {sh.agent}
                    <span className="tabular-nums text-[9px]" style={{ color: "var(--text4)" }}>{ago(sh.last_ts)}</span>
                  </button>
                );
              })}
            </div>
            {openShell && (() => {
              const sh = shells.find((x) => x.agent === openShell);
              if (!sh) return null;
              return (
                <div className="px-5 pb-3">
                  <div className="text-[10px] mb-1" style={{ color: "var(--text4)" }}>
                    {sh.command}{sh.host ? ` · ${sh.host}` : ""} · {sh.chunks} chunks · {sh.ended ? "ended" : "live"}
                  </div>
                  {/* Terminal bytes, rendered as-is. Deliberately plain text and
                      not an xterm instance: this is a transcript to read, and a
                      full emulator here would fight the panel that already
                      exists for interactive work. */}
                  <pre
                    className="text-[11px] leading-[1.45] overflow-auto p-3 rounded-lg m-0"
                    style={{
                      maxHeight: 220,
                      background: "var(--bg2)",
                      color: "var(--text2)",
                      border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)",
                      fontFamily: "var(--font-mono, ui-monospace)",
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                    }}
                    ref={(el) => { if (el) el.scrollTop = el.scrollHeight; }}
                  >
                    {sh.output || "(no output yet)"}
                  </pre>
                </div>
              );
            })()}
          </div>
        )}

        {/* ── replay scrubber ── */}
        <div className="flex items-center gap-3 px-5 py-2 shrink-0 border-b"
          style={{
            borderColor: "color-mix(in srgb, var(--border) 40%, transparent)",
            background: replayAt != null ? "color-mix(in srgb, var(--info) 8%, transparent)" : undefined,
          }}>
          <button
            onClick={() => setReplayAt(null)}
            className="flex items-center gap-1.5 px-2 py-1 rounded-full text-[10px] font-semibold uppercase tracking-wide shrink-0"
            style={{
              color: replayAt == null ? "var(--success)" : "var(--text4)",
              background: `color-mix(in srgb, ${replayAt == null ? "var(--success)" : "var(--text4)"} 14%, transparent)`,
              border: `1px solid color-mix(in srgb, ${replayAt == null ? "var(--success)" : "var(--text4)"} 45%, transparent)`,
            }}
            title={replayAt == null ? "Following live activity" : "Click to return to live activity"}
          >
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: replayAt == null ? "var(--success)" : "var(--text4)" }} />
            {replayAt == null ? "LIVE" : "Return live"}
          </button>
          {!!bounds?.first && !!bounds.last && bounds.last > bounds.first ? (
            <>
              <input
                type="range"
                min={bounds.first}
                max={bounds.last}
                step={1000}
                value={replayAt ?? bounds.last}
                onChange={(e) => setReplayAt(Number(e.target.value))}
                className="flex-1 min-w-0"
                style={{ accentColor: replayAt == null ? "var(--success)" : "var(--info)" }}
                title="Scrub to reconstruct the machine at a past instant"
              />
              <span className="text-[10px] tabular-nums shrink-0" style={{ color: "var(--text3)" }}>
                {new Date(replayAt ?? bounds.last).toLocaleTimeString()}
              </span>
              {replayAt != null && (
                <span className="text-[10px] tabular-nums shrink-0" style={{ color: "var(--text4)" }}>
                  {replay?.runtimes.filter((r) => r.running).length ?? 0} up ·{" "}
                  {replay?.connections ?? 0} conns · {replay?.file_writes ?? 0} writes
                </span>
              )}
            </>
          ) : (
            <span className="text-[10px]" style={{ color: "var(--text4)" }}>Following current machine activity</span>
          )}
        </div>
        {/* ── lanes | feed ── */}
        <div className="flex-1 min-h-0 flex">
          {!lanesCollapsed && <div className="w-[290px] min-w-[220px] max-w-[55vw] shrink-0 border-r overflow-y-auto resize-x"
            style={{ borderColor: "color-mix(in srgb, var(--border) 40%, transparent)" }}>
            <div className="px-4 pt-3 pb-2">
              <h3 className="text-[11px] font-semibold uppercase tracking-wide flex items-center" style={{ color: "var(--text2)" }}>
                Actors
                <button onClick={() => setLanesCollapsed(true)} className="ml-auto text-[10px]" title="Collapse actor lanes">◀</button>
              </h3>
              <p className="text-[10px] mt-1 leading-relaxed" style={{ color: "var(--text4)" }}>
                One lane per thing that did something, with its activity over the last hour.
                Click to filter the feed.
              </p>
              <button
                onClick={() => setRedlineEditorOpen(true)}
                className="mt-2 px-2 py-1 rounded text-[10px] font-medium transition-opacity hover:opacity-80"
                style={{ color: "var(--primary-hover)", background: "color-mix(in srgb, var(--primary) 14%, transparent)" }}
              >
                manage redlines
              </button>
              {redlines && (
                <p className="text-[10px] mt-2 leading-relaxed"
                  style={{ color: redlines.error ? "var(--error)" : "var(--text4)" }}>
                  {redlines.error
                    ? `redlines.json failed to parse (${redlines.error}) — no rules active`
                    : redlines.rules.length
                      ? `${redlines.rules.length} redline${redlines.rules.length === 1 ? "" : "s"} armed`
                      : "no redlines — the gate holds only what a hook sends"}
                </p>
              )}
            </div>
            {lanes.length === 0 && (
              <div className="px-4 text-[11px]" style={{ color: "var(--text4)" }}>Nothing yet.</div>
            )}
            {lanes.map((l) => {
              const on = focus === l.actor;
              return (
                <button
                  key={`${l.kind}:${l.actor}`}
                  onClick={() => setFocus(on ? null : l.actor)}
                  className="flex items-center gap-2 w-full text-left px-4 py-1.5 text-[12px] transition-colors"
                  style={{ background: on ? "color-mix(in srgb, var(--primary) 13%, transparent)" : "transparent" }}
                >
                  <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: KIND_COLOR[l.kind] }} />
                  <span className="truncate"
                    style={{ color: l.kind === "unattributed" ? "var(--warning)" : "var(--text2)" }}
                    title={`${l.confidence.replaceAll("_", " ")} · ${l.evidence.replaceAll("_", " ")}`}>
                    {l.actor}
                  </span>
                  <span className="text-[8.5px] uppercase tracking-wide shrink-0"
                    style={{ color: "var(--text4)" }}>
                    {l.confidence === "actor_unknown" ? "unknown" : l.evidence.replace("_", " ")}
                  </span>
                  <span className="ml-auto flex items-center gap-2 shrink-0">
                    <LaneSpark buckets={l.buckets} color={KIND_COLOR[l.kind]} />
                    <span className="text-[10px] tabular-nums" style={{ color: "var(--text4)" }}>{l.count}</span>
                    <span className="text-[9px] tabular-nums" style={{ color: "var(--text4)" }}>{ago(l.last_ts)}</span>
                  </span>
                </button>
              );
            })}
          </div>}

          <div className="flex-1 min-w-0 flex flex-col">
            <div className="flex items-center gap-2 px-4 py-2 shrink-0 border-b"
              style={{ borderColor: "color-mix(in srgb, var(--border) 40%, transparent)" }}>
              <h3 className="text-[11px] font-semibold uppercase tracking-wide mr-2" style={{ color: "var(--text2)" }}>
                Feed
              </h3>
              {lanesCollapsed && (
                <button onClick={() => setLanesCollapsed(false)}
                  className="px-2 py-0.5 rounded text-[10px]"
                  style={{ color: "var(--primary-hover)", background: "color-mix(in srgb, var(--primary) 14%, transparent)" }}>
                  show lanes
                </button>
              )}
              {(["all", "process", "network", "file", "pty"] as TierFilter[]).map((t) => (
                <button key={t} onClick={() => setTier(t)}
                  className="px-2 py-0.5 rounded text-[11px] transition-opacity hover:opacity-80"
                  style={{
                    color: tier === t ? "var(--primary-hover)" : "var(--text4)",
                    background: tier === t ? "color-mix(in srgb, var(--primary) 14%, transparent)" : "transparent",
                  }}>
                  {t}
                </button>
              ))}
              {focus && (
                <button onClick={() => setFocus(null)}
                  className="ml-auto text-[10px] px-2 py-0.5 rounded"
                  style={{ color: "var(--warning)", background: "color-mix(in srgb, var(--warning) 12%, transparent)" }}>
                  focus: {focus} ✕
                </button>
              )}
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto">
              <table className="w-full text-[11px]" style={{ borderCollapse: "collapse" }}>
                <thead className="sticky top-0" style={{ background: "var(--bg)" }}>
                  <tr style={{ color: "var(--text4)" }}>
                    <th className="text-left font-medium px-4 py-1.5 w-[80px]">time</th>
                    <th className="text-left font-medium py-1.5 w-[70px]">tier</th>
                    <th className="text-left font-medium py-1.5 w-[120px]">action</th>
                    <th className="text-left font-medium py-1.5">target</th>
                    <th className="text-right font-medium px-4 py-1.5 w-[130px]">fidelity</th>
                  </tr>
                </thead>
                <tbody>
                  {[...shown].reverse().map((e, i) => (
                    <tr key={`${e.id}-${i}`}
                      style={{ borderTop: "1px solid color-mix(in srgb, var(--border) 22%, transparent)" }}>
                      <td className="px-4 py-1 tabular-nums" style={{ color: "var(--text4)" }}>{fmtTime(e.ts)}</td>
                      <td className="py-1" style={{ color: KIND_COLOR[e.tier === "file" ? "unattributed" : e.tier === "network" ? "program" : e.tier === "pty" ? "shell" : "runtime"] }}>
                        {e.tier}
                      </td>
                      <td className="py-1" style={{ color: "var(--text3)" }}>{e.action}</td>
                      <td className="py-1 truncate" style={{ color: "var(--text2)", maxWidth: 0, fontFamily: "var(--font-mono, ui-monospace)" }}
                        title={e.path || e.target}>
                        {e.process_name ? <span style={{ color: "var(--info)" }}>{e.process_name} → </span> : null}
                        {midEllipsis(e.path || e.target, 80)}
                      </td>
                      <td className="px-4 py-1 text-right" style={{ color: "var(--text4)" }}>{e.fidelity}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {shown.length === 0 && (
                <div className="px-4 py-6 text-[11px]" style={{ color: "var(--text4)" }}>
                  Nothing in this tier yet.
                </div>
              )}
            </div>
          </div>
        </div>
        </>
        )}
      </div>
    </Portal>
      <RedlineEditor
        open={redlineEditorOpen}
        onClose={() => setRedlineEditorOpen(false)}
        onSaved={refresh}
      />
      {dialog}
    </>
  );
}
