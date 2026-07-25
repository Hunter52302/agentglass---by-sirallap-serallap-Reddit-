// AgentGlass Argus integration — the filesystem map.
//
// MIT © 2026 Zac Rieger. See NOTICE.md at the repo root.
//
// Argus's original idea: stop reading a log of what happened and start reading
// a PLACE. The filesystem is the substrate; agents are things standing on it.
//
// What Argus could never draw, and this can: its fs watcher proves a write
// happened but cannot name the writer, so its map was mostly anonymous. Here
// the labeled layer comes from agentglass's own tool calls — a real session id
// on an exact file — and Argus's watcher supplies only what those calls do NOT
// account for. Two colours, two meanings, never averaged into one:
//
//   agent colour  — a named session touched this file. Known.
//   red           — something wrote here that no tool call explains. Unknown.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ViewHeader } from "./workspace/ViewHeader.tsx";
import { usePoll } from "../lib/usePoll.ts";
import { api } from "../lib/api.ts";
import type { FsMap, MapNode, MapAgent } from "../../../shared/env.ts";
import { MapGraph, type MapOrientation } from "./MapGraph.tsx";

/** Which renderer. Persisted, because it is a lasting preference about how you
 *  read this — not a per-visit choice. */
type MapMode = "nodes" | "tree";
const MODE_KEY = "glasses.map.mode";
const ORIENTATION_KEY = "glasses.map.orientation";
const FOLLOW_KEY = "glasses.map.follow";

/** A tree — the filesystem as a place. */
export function MapIcon({ size = 15 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
      strokeLinecap="round" strokeLinejoin="round" width={size} height={size}>
      <path d="M4 4v13a2 2 0 0 0 2 2h4" />
      <path d="M4 10h6" />
      <rect x="13" y="3" width="7" height="4" rx="1" />
      <rect x="13" y="10" width="7" height="4" rx="1" />
      <rect x="13" y="17" width="7" height="4" rx="1" />
    </svg>
  );
}

/** Stable per-session colours. Index into the palette by first-seen order so a
 *  session keeps its colour across refreshes rather than shuffling. */
const PALETTE = [
  "var(--primary)", "var(--success)", "var(--info)",
  "var(--warning)", "#f472b6", "#22d3ee", "#a3e635", "#fb923c",
];

function shortPath(p: string, root: string | null): string {
  if (root && p.startsWith(root + "/")) return p.slice(root.length + 1);
  return p;
}

function Row({
  node, colorOf, root, onPick, picked, onReveal,
}: {
  node: MapNode;
  colorOf: (id: string) => string;
  root: string | null;
  onPick: (n: MapNode) => void;
  picked: boolean;
  onReveal: (path: string) => void;
}) {
  const isDir = node.kind === "dir";
  const hot = node.unclaimed > 0;
  return (
    <button
      data-map-path={node.path}
      onClick={() => onPick(node)}
      onContextMenu={(e) => { e.preventDefault(); onReveal(node.path); }}
      title="Right-click to reveal in your file manager"
      className="flex items-center gap-2 w-full text-left px-2 py-[3px] rounded text-[12px] transition-colors"
      style={{
        paddingLeft: 8 + node.depth * 14,
        background: picked
          ? "color-mix(in srgb, var(--primary) 14%, transparent)"
          : hot
            ? "color-mix(in srgb, var(--error) 8%, transparent)"
            : "transparent",
        fontFamily: isDir ? undefined : "var(--font-mono, ui-monospace)",
      }}
    >
      <span className="shrink-0 tabular-nums" style={{ color: "var(--text4)", width: 10 }}>
        {isDir ? "▾" : ""}
      </span>
      <span
        className="truncate"
        style={{
          color: isDir ? "var(--text2)" : hot ? "var(--error)" : "var(--text)",
          fontWeight: isDir ? 600 : 400,
        }}
        title={shortPath(node.path, root)}
      >
        {node.name}
      </span>

      <span className="ml-auto flex items-center gap-1.5 shrink-0">
        {/* Who was here. One dot per session, in that session's colour. */}
        {node.agents.slice(0, 5).map((a) => (
          <span key={a} className="w-1.5 h-1.5 rounded-full" style={{ background: colorOf(a) }} title={a} />
        ))}
        {node.unclaimed > 0 && (
          <span
            className="text-[10px] px-1 rounded font-semibold tabular-nums"
            style={{ background: "color-mix(in srgb, var(--error) 18%, transparent)", color: "var(--error)" }}
            title={`${node.unclaimed} write(s) here that no tool call accounts for — the writer is unknown`}
          >
            {node.unclaimed} unclaimed
          </span>
        )}
        {node.touches > 0 && (
          <span className="text-[10px] tabular-nums" style={{ color: "var(--text4)" }}>{node.touches}</span>
        )}
      </span>
    </button>
  );
}

function AgentLegend({
  agents, colorOf, root, trailFor, onTrail,
}: {
  agents: MapAgent[];
  colorOf: (id: string) => string;
  root: string | null;
  trailFor: string | null;
  onTrail: (id: string | null) => void;
}) {
  if (!agents.length) return null;
  return (
    <div className="flex flex-col gap-1.5">
      {agents.map((a) => {
        const on = trailFor === a.session_id;
        return (
          <button key={a.session_id}
            onClick={() => onTrail(on ? null : a.session_id)}
            title={`${a.trail.length} step(s) in this trail — click to follow only this one`}
            className="flex items-center gap-2 text-[11px] w-full text-left px-1 py-0.5 rounded transition-colors"
            style={{ background: on ? "color-mix(in srgb, var(--primary) 13%, transparent)" : "transparent" }}>
            <span className="w-2 h-2 rounded-full shrink-0" style={{ background: colorOf(a.session_id) }} />
            <span className="font-medium shrink-0" style={{ color: "var(--text2)" }}>{a.source_app}</span>
            <span className="truncate" style={{ color: "var(--text4)" }} title={a.current ?? ""}>
              {a.current ? shortPath(a.current, root) : "—"}
            </span>
            <span className="ml-auto tabular-nums shrink-0" style={{ color: "var(--text4)" }}>{a.touches}</span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * The trail — an agent's recent path across the tree.
 *
 * Argus drew this on a spatial map where every node had an (x, y). Here the
 * tree is an indented LIST, so a node's position is simply its row: index ×
 * row height. That is enough to draw the same thing — a polyline through the
 * files an agent touched in order, oldest faintest, with a marker resting on
 * where it is now.
 *
 * Rendered as one absolutely-positioned SVG over the rows rather than as
 * per-row decoration, because a trail is a relationship BETWEEN rows and
 * jumps backwards up the list as often as forwards.
 *
 * Only trail steps whose node is currently visible can be drawn: a path can
 * leave the tree (a file outside the root, or one clipped by the node cap).
 * Those steps are skipped rather than faked, which is why a trail can appear
 * to jump — it is showing a real gap, not a rendering bug.
 */
function TrailOverlay({
  agent, color, posOf, height,
}: {
  agent: MapAgent;
  color: string;
  /** Where a path sits in the rendered tree, or null if it is not visible. */
  posOf: (path: string) => { x: number; y: number } | null;
  height: number;
}) {
  const pts = agent.trail
    .map((p) => posOf(p))
    .filter((p): p is { x: number; y: number } => p != null);

  if (pts.length < 1) return null;
  const d = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x} ${p.y}`).join(" ");
  const head = pts[pts.length - 1];

  return (
    <svg
      className="absolute inset-0 pointer-events-none"
      width="100%"
      height={height}
      style={{ overflow: "visible" }}
      aria-hidden
    >
      {pts.length > 1 && (
        <path d={d} fill="none" stroke={color} strokeWidth={1.5} strokeOpacity={0.35}
          strokeLinecap="round" strokeLinejoin="round" strokeDasharray="3 3" />
      )}
      {pts.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r={i === pts.length - 1 ? 0 : 2}
          fill={color} fillOpacity={0.15 + (0.5 * i) / Math.max(1, pts.length - 1)} />
      ))}
      {/* Where the agent is now. The pulse is the only motion on the panel, so
          it reads as "here", not as decoration. */}
      <circle cx={head.x} cy={head.y} r={3.5} fill={color}>
        <animate attributeName="r" values="3.5;6;3.5" dur="1.8s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="1;0.35;1" dur="1.8s" repeatCount="indefinite" />
      </circle>
    </svg>
  );
}

/**
 * Fallback row height, used only until the real one is measured.
 *
 * NOT a constant to rely on: rows are 24px at the default zoom but this app has
 * a user-adjustable UI scale (lib/uiScale.ts), so any hardcoded value is wrong
 * for somebody. A trail drawn against the wrong row height drifts a couple of
 * pixels per row, which over a few hundred rows puts the marker on entirely the
 * wrong file — so the live value is measured from the DOM below.
 */
const ROW_H_FALLBACK = 24;

export function MapView({ active }: { active: boolean }) {
  const [map, setMap] = useState<FsMap | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [picked, setPicked] = useState<MapNode | null>(null);
  // Which agent's trail is drawn. null = all of them; picking one is how you
  // follow a single session when several are working at once and the paths
  // cross.
  const [trailFor, setTrailFor] = useState<string | null>(null);
  const [rowH, setRowH] = useState(ROW_H_FALLBACK);
  const [mode, setMode] = useState<MapMode>(() => {
    try { return localStorage.getItem(MODE_KEY) === "tree" ? "tree" : "nodes"; } catch { return "nodes"; }
  });
  const [orientation, setOrientation] = useState<MapOrientation>(() => {
    try { return localStorage.getItem(ORIENTATION_KEY) === "top-down" ? "top-down" : "left-right"; }
    catch { return "left-right"; }
  });
  const [following, setFollowing] = useState(() => {
    try { return localStorage.getItem(FOLLOW_KEY) !== "0"; } catch { return true; }
  });
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => { try { localStorage.setItem(MODE_KEY, mode); } catch { /* private mode */ } }, [mode]);
  useEffect(() => { try { localStorage.setItem(ORIENTATION_KEY, orientation); } catch { /* private mode */ } }, [orientation]);
  useEffect(() => { try { localStorage.setItem(FOLLOW_KEY, following ? "1" : "0"); } catch { /* private mode */ } }, [following]);

  // Reveal is the one action on this panel, so its failures are surfaced
  // inline rather than only in the console — a right-click that silently does
  // nothing reads as a broken feature.
  const reveal = useCallback((p: string) => {
    api.envReveal(p)
      .then((r) => setNote(r.ok ? null : r.error ?? "could not reveal that path"))
      .catch((e) => setNote(String(e?.message ?? e)));
  }, []);
  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), 4000);
    return () => clearTimeout(t);
  }, [note]);
  const rowsRef = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(() => {
    api.envMap(800).then((m) => { setMap(m); setErr(null); }).catch((e) => setErr(String(e?.message ?? e)));
  }, []);
  usePoll(active, refresh, 4000);

  // Measure a real row rather than trusting a constant. Runs after any render
  // that could change it — new nodes, a zoom change, a resize.
  useEffect(() => {
    const measure = () => {
      const first = rowsRef.current?.querySelector("button");
      const h = first?.getBoundingClientRect().height;
      if (h && h > 1 && Math.abs(h - rowH) > 0.5) setRowH(h);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [map?.nodes, rowH, active]);

  // Colour per session, assigned by the order the server returns them (most
  // recently active first) and held in a memo so it survives re-renders.
  const colorOf = useMemo(() => {
    const ids = map?.agents.map((a) => a.session_id) ?? [];
    const m = new Map(ids.map((id, i) => [id, PALETTE[i % PALETTE.length]]));
    return (id: string) => m.get(id) ?? "var(--text4)";
  }, [map?.agents]);

  // Where each visible node sits, so a trail can be drawn through them. x
  // follows the node's own indentation rather than a fixed gutter, so the path
  // visibly moves in and out of directories as the agent does.
  const nodePos = useMemo(() => {
    const m = new Map<string, { x: number; y: number }>();
    map?.nodes.forEach((n, i) => m.set(n.path, { x: 13 + n.depth * 14, y: i * rowH + rowH / 2 }));
    return m;
  }, [map?.nodes, rowH]);
  const posOf = useCallback((p: string) => nodePos.get(p) ?? null, [nodePos]);

  const shownTrails = (map?.agents ?? []).filter((a) => !trailFor || a.session_id === trailFor);
  const followedAgent = useMemo(() => {
    const agents = map?.agents ?? [];
    const selected = trailFor ? agents.find((agent) => agent.session_id === trailFor) : null;
    return selected ?? [...agents].sort((a, b) => b.last_ts - a.last_ts)[0] ?? null;
  }, [map?.agents, trailFor]);

  useEffect(() => {
    if (!following || mode !== "tree" || !followedAgent?.current) return;
    const escaped = CSS.escape(followedAgent.current);
    rowsRef.current?.querySelector<HTMLElement>(`[data-map-path="${escaped}"]`)
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [following, mode, followedAgent?.current, followedAgent?.last_ts]);

  return (
    <div className="flex flex-col h-full min-h-0">
      <ViewHeader
        title="Map"
        count={map?.total_nodes}
        actions={
          <span className="flex items-center gap-2 max-w-[calc(100vw-140px)] overflow-x-auto agw-noscrollbar">
            <span className="flex items-center gap-0.5 p-0.5 rounded-lg"
              style={{ background: "var(--bg2)", border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)" }}>
              {(["nodes", "tree"] as MapMode[]).map((m) => (
                <button key={m} onClick={() => setMode(m)}
                  title={m === "nodes"
                    ? "Node map — the filesystem as a place. Trails are readable here because position means something."
                    : "Tree — an indented list. Better for scanning names."}
                  className="px-2 py-0.5 rounded text-[10px] transition-opacity hover:opacity-80"
                  style={{
                    color: mode === m ? "var(--primary-hover)" : "var(--text4)",
                    background: mode === m ? "color-mix(in srgb, var(--primary) 16%, transparent)" : "transparent",
                  }}>
                  {m}
                </button>
              ))}
            </span>
            <span className="flex items-center gap-0.5 p-0.5 rounded-lg"
              style={{ background: "var(--bg2)", border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)" }}>
              {(["left-right", "top-down"] as MapOrientation[]).map((item) => (
                <button key={item} onClick={() => setOrientation(item)}
                  className="px-2 py-0.5 rounded text-[10px]"
                  style={{
                    color: orientation === item ? "var(--primary-hover)" : "var(--text4)",
                    background: orientation === item ? "color-mix(in srgb, var(--primary) 16%, transparent)" : "transparent",
                  }}
                  title={item === "left-right" ? "Roots on the left" : "Roots at the top"}>
                  {item === "left-right" ? "left → right" : "top ↓ down"}
                </button>
              ))}
            </span>
            <button onClick={() => setFollowing((value) => !value)}
              className="flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-semibold"
              style={{
                color: following ? "var(--success)" : "var(--text4)",
                border: `1px solid color-mix(in srgb, ${following ? "var(--success)" : "var(--border)"} 45%, transparent)`,
                background: `color-mix(in srgb, ${following ? "var(--success)" : "var(--text4)"} 12%, transparent)`,
              }}>
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: following ? "var(--success)" : "var(--text4)" }} />
              {following ? "Following live" : "Live paused"}
            </button>
            <span className="text-[10px] whitespace-nowrap" style={{ color: "var(--text4)" }}>
              {map?.fs_tier_enabled ? "both layers" : "labeled layer only"}
            </span>
          </span>
        }
      />

      <div className="flex-1 min-h-0 flex relative">
        {/* Reveal failures surface here — a right-click that silently does
            nothing is indistinguishable from a broken feature. */}
        {note && (
          <div className="absolute top-2 left-1/2 -translate-x-1/2 z-20 px-3 py-1.5 rounded-lg text-[11px]"
            style={{ background: "color-mix(in srgb, var(--warning) 18%, var(--bg2))", color: "var(--warning)" }}>
            {note}
          </div>
        )}

        <div className={`flex-1 min-w-0 min-h-0 ${mode === "tree" ? "overflow-auto py-2" : "overflow-hidden"}`}>
          {err && (
            <div className="mx-4 px-3 py-2 rounded-lg text-[11px]"
              style={{ background: "color-mix(in srgb, var(--error) 12%, transparent)", color: "var(--error)" }}>
              {err}
            </div>
          )}
          {map && map.nodes.length === 0 && (
            <div className="mx-4 px-3 py-4 text-[11px] rounded-lg border border-dashed"
              style={{ borderColor: "color-mix(in srgb, var(--border) 40%, transparent)", color: "var(--text4)" }}>
              Nothing has been touched yet in this scope. The map fills in as agents read and edit files.
            </div>
          )}

          {mode === "nodes" && map && map.nodes.length > 0 ? (
            <MapGraph
              map={map}
              colorOf={colorOf}
              trailFor={trailFor}
              onPick={setPicked}
              picked={picked?.path ?? null}
              onReveal={reveal}
              orientation={orientation}
              following={following}
              onToggleFollowing={() => setFollowing((value) => !value)}
              focusPath={followedAgent?.current ?? null}
              focusTick={followedAgent?.last_ts ?? 0}
            />
          ) : (
            <>
              <div className="relative" ref={rowsRef}>
                {map?.nodes.map((n) => (
                  <Row key={n.path} node={n} colorOf={colorOf} root={map.root}
                    onPick={setPicked} picked={picked?.path === n.path} onReveal={reveal} />
                ))}
                {shownTrails.map((a) => (
                  <TrailOverlay key={a.session_id} agent={a} color={colorOf(a.session_id)}
                    posOf={posOf} height={(map?.nodes.length ?? 0) * rowH} />
                ))}
              </div>
              {map?.truncated && (
                <div className="mx-4 mt-2 px-3 py-2 text-[10px] rounded"
                  style={{ background: "color-mix(in srgb, var(--warning) 10%, transparent)", color: "var(--warning)" }}>
                  Showing {map.nodes.length} of {map.total_nodes} nodes. The rest are real but not drawn — this is a
                  cap, not an empty tree.
                </div>
              )}
            </>
          )}
        </div>

        {/* side rail: who is where, and what the colours mean */}
        <div className="w-[260px] shrink-0 border-l overflow-y-auto p-4 hidden lg:flex flex-col gap-5"
          style={{ borderColor: "color-mix(in srgb, var(--border) 40%, transparent)" }}>
          <div className="flex flex-col gap-2">
            <h3 className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: "var(--text2)" }}>
              Agents, positioned
            </h3>
            <p className="text-[10px] leading-relaxed" style={{ color: "var(--text4)" }}>
              From agentglass's own tool calls — the session is known, so the file it touched is labeled.
              Click one to follow just its trail; the pulsing dot is where it is now.
            </p>
            <AgentLegend agents={map?.agents ?? []} colorOf={colorOf} root={map?.root ?? null}
              trailFor={trailFor} onTrail={setTrailFor} />
          </div>

          <div className="flex flex-col gap-2">
            <h3 className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: "var(--text2)" }}>
              Unclaimed writes
            </h3>
            {!map?.fs_tier_enabled ? (
              <p className="text-[10px] leading-relaxed" style={{ color: "var(--text4)" }}>
                The filesystem tier is off, so this layer is empty — every node you see was reported by an agent.
                Set <code style={{ color: "var(--text3)" }}>GLASSES_FS_WATCH=1</code> to also catch writes nobody
                reported. That is the half agentglass cannot see on its own.
              </p>
            ) : (
              <p className="text-[10px] leading-relaxed" style={{ color: "var(--text4)" }}>
                <span style={{ color: "var(--error)" }}>{map.unclaimed_total} write(s)</span> on disk that no tool
                call accounts for. The writer is unknown — that is the point, not a gap.
              </p>
            )}
          </div>

          {picked && (
            <div className="flex flex-col gap-2">
              <h3 className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: "var(--text2)" }}>
                Selected
              </h3>
              <div className="text-[11px] break-all" style={{ color: "var(--text2)" }}>
                {shortPath(picked.path, map?.root ?? null)}
              </div>
              <div className="text-[10px] flex flex-col gap-1" style={{ color: "var(--text4)" }}>
                <span>{picked.touches} tool call(s){picked.last_tool ? ` · last ${picked.last_tool}` : ""}</span>
                {picked.unclaimed > 0 && (
                  <span style={{ color: "var(--error)" }}>{picked.unclaimed} unclaimed write(s)</span>
                )}
                <span>{picked.agents.length} session(s)</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
