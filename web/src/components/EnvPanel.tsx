// Glasses for Argus — the Environment view.
//
// MIT © 2026 Zac Rieger. See NOTICE.md at the repo root.
//
// Every other view in this workspace shows what the fleet REPORTED. This one
// shows what the machine reveals: AI runtimes found in the process table, and
// outbound connections to AI endpoints — including the ones that report nothing
// at all and are therefore invisible everywhere else in the app.
//
// The design rule here is honesty about fidelity. These observations are weaker
// than agent telemetry — a process name cannot tell you what a model was asked
// or what it answered — so nothing on this panel is styled to look like the
// cockpit's labeled data, and every section says plainly what it can and cannot
// know.

import { useCallback, useState } from "react";
import { ViewHeader } from "./workspace/ViewHeader.tsx";
import { usePoll } from "../lib/usePoll.ts";
import { api } from "../lib/api.ts";
import type {
  EnvTierStatus, EnvSummary, EnvRuntime, EnvConnection, EnvEvent,
} from "../../../shared/env.ts";

/** An eye — the all-seeing giant the tier is named for. */
export function EnvIcon({ size = 15 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
      strokeLinecap="round" strokeLinejoin="round" width={size} height={size}
    >
      <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z" />
      <circle cx="12" cy="12" r="2.5" />
    </svg>
  );
}

const ago = (ts: number) => {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
};

function Chip({ label, value, tone }: { label: string; value: number | string; tone: string }) {
  return (
    <div
      className="flex flex-col gap-0.5 px-3 py-2 rounded-lg border"
      style={{ borderColor: "color-mix(in srgb, var(--border) 45%, transparent)", background: "var(--bg2)" }}
    >
      <span className="text-[16px] font-semibold tabular-nums" style={{ color: tone }}>{value}</span>
      <span className="text-[10px] uppercase tracking-wide" style={{ color: "var(--text3)" }}>{label}</span>
    </div>
  );
}

function Section({
  title, note, count, children,
}: { title: string; note: string; count?: number; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-baseline gap-2">
        <h3 className="text-[12px] font-semibold uppercase tracking-wide" style={{ color: "var(--text2)" }}>
          {title}
        </h3>
        {count != null && (
          <span className="text-[10px] tabular-nums" style={{ color: "var(--text4)" }}>{count}</span>
        )}
      </div>
      <p className="text-[11px] leading-relaxed" style={{ color: "var(--text4)" }}>{note}</p>
      {children}
    </section>
  );
}

function RuntimeRow({ r }: { r: EnvRuntime }) {
  return (
    <div
      className="flex items-center gap-3 px-3 py-2 rounded-lg border text-[12px]"
      style={{
        borderColor: r.blind
          ? "color-mix(in srgb, var(--warning) 40%, transparent)"
          : "color-mix(in srgb, var(--border) 40%, transparent)",
        background: r.blind ? "color-mix(in srgb, var(--warning) 7%, var(--bg2))" : "var(--bg2)",
        opacity: r.running ? 1 : 0.45,
      }}
    >
      <span
        className="w-1.5 h-1.5 rounded-full shrink-0"
        style={{ background: r.running ? (r.blind ? "var(--warning)" : "var(--success)") : "var(--text4)" }}
      />
      <span className="font-medium shrink-0" style={{ color: "var(--text)" }}>{r.label}</span>
      <span className="text-[10px] shrink-0" style={{ color: "var(--text4)" }}>
        {r.runtime_kind}{r.pid != null ? ` · pid ${r.pid}` : ""}
      </span>
      {r.models.length > 0 && (
        <span className="text-[10px] truncate" style={{ color: "var(--info)" }}>
          {r.models.map((m) => m.name).filter(Boolean).join(", ")}
        </span>
      )}
      <span className="ml-auto flex items-center gap-2 shrink-0">
        {r.blind && r.running && (
          <span
            className="text-[10px] px-1.5 py-0.5 rounded font-medium"
            style={{ background: "color-mix(in srgb, var(--warning) 18%, transparent)", color: "var(--warning)" }}
            title="Running on this machine, but nothing from this provider is reporting telemetry to agentglass. Presence is all we can prove — not what it is doing."
          >
            not reporting
          </span>
        )}
        <span className="text-[10px] tabular-nums" style={{ color: "var(--text4)" }}>{ago(r.last_seen)}</span>
      </span>
    </div>
  );
}

function ConnRow({ c }: { c: EnvConnection }) {
  return (
    <div
      className="flex items-center gap-3 px-3 py-2 rounded-lg border text-[12px]"
      style={{
        borderColor: "color-mix(in srgb, var(--border) 40%, transparent)",
        background: "var(--bg2)",
        opacity: c.open ? 1 : 0.45,
      }}
    >
      <span
        className="w-1.5 h-1.5 rounded-full shrink-0"
        style={{ background: c.open ? "var(--success)" : "var(--text4)" }}
      />
      <span className="font-medium shrink-0" style={{ color: "var(--text)" }}>{c.process_name || "unknown"}</span>
      <span className="shrink-0" style={{ color: "var(--text4)" }}>→</span>
      <span className="truncate" style={{ color: c.ai_endpoint ? "var(--info)" : "var(--text2)" }}>
        {c.remote_host || c.remote_ip}
        <span style={{ color: "var(--text4)" }}>:{c.remote_port}</span>
      </span>
      <span className="ml-auto flex items-center gap-2 shrink-0">
        {/* Two different claims, and conflating them would be a lie. A chip
            naming a provider means the DESTINATION is a known AI endpoint. A
            connection listed only because the SOURCE is a known AI process
            (Claude Code phoning its telemetry vendor, say) gets the weaker
            label — otherwise the row reads as though Datadog were an AI API. */}
        {c.ai_endpoint && c.label ? (
          <span className="text-[10px] px-1.5 py-0.5 rounded"
            style={{ background: "color-mix(in srgb, var(--info) 15%, transparent)", color: "var(--info)" }}>
            {c.label}
          </span>
        ) : (
          <span className="text-[10px] px-1.5 py-0.5 rounded"
            style={{ background: "color-mix(in srgb, var(--text4) 12%, transparent)", color: "var(--text4)" }}
            title="Listed because the process making this connection is a recognized AI runtime. The destination is not a known AI endpoint.">
            AI process
          </span>
        )}
        <span className="text-[10px] tabular-nums" style={{ color: "var(--text4)" }}>{ago(c.opened)}</span>
      </span>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-3 py-4 text-[11px] rounded-lg border border-dashed"
      style={{ borderColor: "color-mix(in srgb, var(--border) 40%, transparent)", color: "var(--text4)" }}>
      {children}
    </div>
  );
}

export function EnvView({ active }: { active: boolean }) {
  const [status, setStatus] = useState<EnvTierStatus | null>(null);
  const [summary, setSummary] = useState<EnvSummary | null>(null);
  const [runtimes, setRuntimes] = useState<EnvRuntime[]>([]);
  const [conns, setConns] = useState<EnvConnection[]>([]);
  const [files, setFiles] = useState<EnvEvent[]>([]);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(() => {
    Promise.all([
      api.envStatus(), api.envSummary(), api.envRuntimes(), api.envConnections(60),
    ])
      .then(([st, sm, rt, cn]) => {
        setStatus(st); setSummary(sm); setRuntimes(rt); setConns(cn); setErr(null);
        // Only asked for when the tier is actually on — otherwise it is a
        // guaranteed-empty round trip on every poll.
        if (st.file.enabled) api.envFiles(60).then(setFiles).catch(() => {});
      })
      .catch((e) => setErr(String(e?.message ?? e)));
  }, []);

  usePoll(active, refresh, 4000);

  const running = runtimes.filter((r) => r.running);
  const blind = running.filter((r) => r.blind);
  const openConns = conns.filter((c) => c.open);

  return (
    <div className="flex flex-col h-full min-h-0">
      <ViewHeader
        title="Environment"
        count={running.length}
        actions={
          <span className="text-[10px]" style={{ color: "var(--text4)" }}>
            {status?.enabled ? `${status.platform} · polling` : "tier off"}
          </span>
        }
      />

      <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 flex flex-col gap-6">
        <p className="text-[11px] leading-relaxed max-w-[70ch]" style={{ color: "var(--text3)" }}>
          Every other view here shows what an agent <em>told</em> agentglass. This one shows
          what the machine itself reveals — AI runtimes in the OS process table and outbound
          connections to AI endpoints — so software that reports nothing still appears.
        </p>

        {err && (
          <div className="px-3 py-2 rounded-lg text-[11px]"
            style={{ background: "color-mix(in srgb, var(--error) 12%, transparent)", color: "var(--error)" }}>
            {err}
          </div>
        )}

        {summary && (
          <div className="flex flex-wrap gap-2">
            <Chip label="runtimes up" value={summary.runtimes_running} tone="var(--text)" />
            <Chip label="not reporting" value={summary.runtimes_blind}
              tone={summary.runtimes_blind > 0 ? "var(--warning)" : "var(--text)"} />
            <Chip label="connections" value={summary.connections_open} tone="var(--text)" />
            <Chip label="to AI endpoints" value={summary.connections_ai_endpoint} tone="var(--info)" />
          </div>
        )}

        <Section
          title="AI runtimes present"
          count={running.length}
          note={
            blind.length > 0
              ? `${blind.length} of these are running with no telemetry reaching agentglass — they exist on this view and nowhere else in the app. Presence is all this proves: an OS process name cannot reveal prompts, tool calls, or output.`
              : "Found in the OS process table. Presence only — an OS process name cannot reveal prompts, tool calls, or model output."
          }
        >
          <div className="flex flex-col gap-1.5">
            {running.length === 0
              ? <Empty>No recognized AI runtimes are running. The registry of known signatures is finite — an unrecognized program will not appear here.</Empty>
              : running.map((r) => <RuntimeRow key={r.node_id} r={r} />)}
          </div>
        </Section>

        <Section
          title="Outbound AI connections"
          count={openConns.length}
          note="Connection metadata only — process, endpoint, port. Never contents: modern traffic is TLS-encrypted and reading it would mean breaking your own encryption. This is what makes a browser tab talking to a cloud model visible, since it leaves no local process or file trace."
        >
          <div className="flex flex-col gap-1.5">
            {openConns.length === 0
              ? <Empty>No AI-relevant connections open right now.</Empty>
              : openConns.map((c) => <ConnRow key={`${c.pid}-${c.remote_host || c.remote_ip}`} c={c} />)}
          </div>
        </Section>

        <Section
          title="Unclaimed file activity"
          count={status?.file.enabled ? files.length : undefined}
          note="Writes on disk that no agent reported. Off by default: agentglass deliberately never taps the filesystem, so this tier stays dark unless you opt in."
        >
          {!status?.file.enabled ? (
            <Empty>
              Filesystem tier is off. Set <code style={{ color: "var(--text2)" }}>GLASSES_FS_WATCH=1</code> and
              restart the server to capture writes in the scoped project. It is off by default on purpose —
              unclaimed writes arrive unlabeled, which is why they are kept out of the cockpit's data.
            </Empty>
          ) : !status.file.available ? (
            <Empty>Recursive filesystem watching is unavailable on this platform, so the tier reported itself off rather than pretending to work.</Empty>
          ) : files.length === 0 ? (
            <Empty>Watching <code style={{ color: "var(--text2)" }}>{status.file.dir}</code> — nothing written yet.</Empty>
          ) : (
            <div className="flex flex-col gap-1.5">
              {files.map((f) => (
                <div key={f.id} className="flex items-center gap-3 px-3 py-2 rounded-lg border text-[12px]"
                  style={{ borderColor: "color-mix(in srgb, var(--border) 40%, transparent)", background: "var(--bg2)" }}>
                  <span className="text-[10px] px-1.5 py-0.5 rounded shrink-0"
                    style={{ background: "color-mix(in srgb, var(--text4) 15%, transparent)", color: "var(--text3)" }}>
                    {f.action.replace("fs_", "")}
                  </span>
                  <span className="truncate" style={{ color: "var(--text2)" }}>{f.path}</span>
                  <span className="ml-auto text-[10px] tabular-nums shrink-0" style={{ color: "var(--text4)" }}>
                    {ago(f.ts)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Section>
      </div>
    </div>
  );
}
