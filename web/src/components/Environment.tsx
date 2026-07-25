// Glasses for Argus — the cockpit's environment panel.
//
// MIT © 2026 Zac Rieger. See NOTICE.md at the repo root.
//
// The environment tier first shipped only inside the workspace overlay, which
// was the wrong home for it: the overlay is where you DO things — stage a
// commit, restart a container, run a shell — and this is something you WATCH.
// Two keystrokes deep in a work surface, it may as well not have existed.
//
// So it sits here instead, under the radar, with the rest of the cockpit. The
// number that earns the space is "not reporting": runtimes that are running on
// this machine while producing no hook, no span and no transcript. Everywhere
// else in this app, those count as zero agents.

import { useCallback, useState } from "react";
import { Panel } from "./Panel.tsx";
import { usePoll } from "../lib/usePoll.ts";
import { api } from "../lib/api.ts";
import type { EnvSummary, EnvRuntime } from "../../../shared/env.ts";

export function Environment({ onOpen }: { onOpen?: () => void }) {
  const [summary, setSummary] = useState<EnvSummary | null>(null);
  const [runtimes, setRuntimes] = useState<EnvRuntime[]>([]);

  const refresh = useCallback(() => {
    api.envSummary().then(setSummary).catch(() => {});
    api.envRuntimes().then(setRuntimes).catch(() => {});
  }, []);
  // Always polling — this panel is on the page whenever the cockpit is, and the
  // whole value is noticing something appear while you were looking elsewhere.
  usePoll(true, refresh, 5000);

  const running = runtimes.filter((r) => r.running);
  const blind = running.filter((r) => r.blind);

  return (
    <Panel
      eyebrow="ENVIRONMENT"
      title="What the machine shows"
      right={
        <button
          onClick={onOpen}
          className="text-[10px] transition-opacity hover:opacity-70"
          style={{ color: blind.length ? "var(--warning)" : "var(--text4)" }}
          title="Open the Env view for connections and detail"
        >
          {blind.length ? `${blind.length} not reporting →` : "all reporting →"}
        </button>
      }
      bodyClass="flex flex-col gap-2 overflow-hidden"
    >
      <div className="flex gap-4 shrink-0">
        <div className="flex flex-col">
          <span className="text-[19px] font-semibold tabular-nums leading-none" style={{ color: "var(--text)" }}>
            {summary?.runtimes_running ?? "—"}
          </span>
          <span className="text-[9px] uppercase tracking-wide mt-1" style={{ color: "var(--text3)" }}>runtimes</span>
        </div>
        <div className="flex flex-col">
          <span
            className="text-[19px] font-semibold tabular-nums leading-none"
            style={{ color: summary?.runtimes_blind ? "var(--warning)" : "var(--text)" }}
          >
            {summary?.runtimes_blind ?? "—"}
          </span>
          <span className="text-[9px] uppercase tracking-wide mt-1" style={{ color: "var(--text3)" }}>silent</span>
        </div>
        <div className="flex flex-col">
          <span className="text-[19px] font-semibold tabular-nums leading-none" style={{ color: "var(--info)" }}>
            {summary?.connections_ai_endpoint ?? "—"}
          </span>
          <span className="text-[9px] uppercase tracking-wide mt-1" style={{ color: "var(--text3)" }}>AI conns</span>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-1 -mx-1 px-1">
        {running.length === 0 ? (
          <span className="text-[10px]" style={{ color: "var(--text4)" }}>
            No recognized AI runtimes found.
          </span>
        ) : (
          running.map((r) => (
            <div key={r.node_id} className="flex items-center gap-2 text-[11px]">
              <span
                className="w-1.5 h-1.5 rounded-full shrink-0"
                style={{ background: r.blind ? "var(--warning)" : "var(--success)" }}
              />
              <span className="truncate" style={{ color: "var(--text2)" }}>{r.label}</span>
              {r.blind && (
                <span
                  className="ml-auto text-[9px] shrink-0"
                  style={{ color: "var(--warning)" }}
                  title="Running, but nothing from this provider is reporting telemetry. Presence is all this proves."
                >
                  silent
                </span>
              )}
            </div>
          ))
        )}
      </div>
    </Panel>
  );
}
