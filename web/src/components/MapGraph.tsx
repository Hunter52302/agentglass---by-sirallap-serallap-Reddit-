// AgentGlass Argus integration — the node map.
//
// MIT © 2026 Zac Rieger. See NOTICE.md at the repo root.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS ALONGSIDE THE TREE VIEW
//
// The indented tree is a good *list*. It is a bad *place*. Agent trails proved
// it: a path drawn over a list is a set of straight lines between rows that are
// adjacent in the list and unrelated in the filesystem, so the picture came out
// as scribble. Position carried no meaning, so a line between positions carried
// none either.
//
// Here every node has a real (x, y) from a tidy-tree layout: depth runs left to
// right, siblings stack vertically, a parent sits at the mean of its children.
// Distance on screen now means distance in the tree — which is what makes a
// trail readable, and what Argus's map was actually for.
//
// The tree view stays as the secondary mode. It is better for scanning a long
// list of names, and this is better for seeing where things are.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FsMap, MapNode, MapAgent } from "../../../shared/env.ts";
import { displaySourceApp } from "../lib/format.ts";

export interface LaidNode extends MapNode {
  x: number;
  y: number;
  parent: string | null;
}

export type MapOrientation = "left-right" | "top-down";

export const activityLabel = (agent: Pick<MapAgent, "live">): string =>
  agent.live ? "Live activity" : "Last recorded activity";
export interface MapCameraView { x: number; y: number; k: number }

const COL_W = 190; // horizontal distance per depth level
const ROW_H = 26; // vertical distance per leaf
const ACTIVITY_ZOOM = 1.25;

/** Camera target for live follow. Kept pure so its framing stays testable. */
export function activityFocusView(
  node: Pick<LaidNode, "x" | "y">,
  viewport: { width: number; height: number },
  zoom = ACTIVITY_ZOOM,
): MapCameraView {
  const k = Math.max(0.4, Math.min(2, zoom));
  return {
    // Leave a little room on the right for the live activity card.
    x: viewport.width * 0.44 - node.x * k,
    y: viewport.height * 0.5 - node.y * k,
    k,
  };
}

/** Frame a complete node layout inside the current viewport. */
export function fitMapView(
  content: { width: number; height: number },
  viewport: { width: number; height: number },
): MapCameraView | null {
  if (
    content.width <= 0 || content.height <= 0
    || viewport.width <= 0 || viewport.height <= 0
  ) return null;
  const k = Math.max(
    0.08,
    Math.min(1.1, Math.min(viewport.width / content.width, viewport.height / content.height) * 0.95),
  );
  const fits = content.height * k <= viewport.height;
  return {
    x: 24,
    y: fits ? (viewport.height - content.height * k) / 2 : 16,
    k,
  };
}

/**
 * Tidy tree layout.
 *
 * Leaves take consecutive vertical slots in render order; every parent centres
 * on its children. Deterministic, so a node does not jump between refreshes —
 * which matters more here than elegance, because the thing being watched is
 * live and a layout that reshuffles is unreadable.
 */
export function layout(
  nodes: MapNode[],
  orientation: MapOrientation = "left-right",
): { laid: LaidNode[]; width: number; height: number } {
  const byPath = new Map<string, MapNode>(nodes.map((n) => [n.path, n]));
  const children = new Map<string, string[]>();
  const roots: string[] = [];

  for (const n of nodes) {
    const parent = n.path.slice(0, n.path.lastIndexOf("/"));
    if (parent && byPath.has(parent)) {
      const arr = children.get(parent);
      if (arr) arr.push(n.path);
      else children.set(parent, [n.path]);
    } else {
      roots.push(n.path);
    }
  }

  const pos = new Map<string, { x: number; y: number }>();
  let nextLeafY = 0;

  const place = (p: string, depth: number): number => {
    const kids = children.get(p) ?? [];
    let y: number;
    if (kids.length === 0) {
      y = nextLeafY;
      nextLeafY += ROW_H;
    } else {
      const ys = kids.map((c) => place(c, depth + 1));
      y = (ys[0] + ys[ys.length - 1]) / 2;
    }
    pos.set(p, { x: depth * COL_W, y });
    return y;
  };
  for (const r of roots) place(r, 0);

  const laid: LaidNode[] = [];
  for (const n of nodes) {
    const p = pos.get(n.path);
    if (!p) continue;
    const parent = n.path.slice(0, n.path.lastIndexOf("/"));
    laid.push({
      ...n,
      x: orientation === "top-down" ? p.y : p.x,
      y: orientation === "top-down" ? p.x : p.y,
      parent: byPath.has(parent) ? parent : null,
    });
  }
  const maxDepth = Math.max(0, ...laid.map((n) => n.depth));
  const horizontalWidth = (maxDepth + 1) * COL_W + 240;
  const horizontalHeight = Math.max(nextLeafY, ROW_H) + 40;
  return orientation === "top-down"
    ? { laid, width: horizontalHeight, height: horizontalWidth }
    : { laid, width: horizontalWidth, height: horizontalHeight };
}

/** Node radius by how much happened there — a busy file is a bigger target. */
const radiusOf = (n: MapNode) => {
  const a = n.touches + n.unclaimed;
  return a <= 0 ? 3 : Math.min(11, 3.5 + Math.log2(a + 1) * 1.6);
};

interface Menu {
  x: number;
  y: number;
  node: LaidNode;
}

export function MapGraph({
  map, colorOf, trailFor, onPick, picked, onReveal, orientation,
  following, onToggleFollowing, focusPath, focusTick, focusAgent, root,
}: {
  map: FsMap;
  colorOf: (id: string) => string;
  trailFor: string | null;
  onPick: (n: MapNode) => void;
  picked: string | null;
  onReveal: (path: string) => void;
  orientation: MapOrientation;
  following: boolean;
  onToggleFollowing: () => void;
  focusPath: string | null;
  focusTick: number;
  focusAgent: MapAgent | null;
  root: string | null;
}) {
  const { laid, width, height } = useMemo(() => layout(map.nodes, orientation), [map.nodes, orientation]);
  const posOf = useMemo(() => new Map(laid.map((n) => [n.path, n])), [laid]);

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<SVGGElement | null>(null);
  const [view, setView] = useState<MapCameraView>({ x: 40, y: 20, k: 0.75 });
  const viewRef = useRef(view);
  const cameraFrame = useRef<number | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);

  /**
   * Frame the whole tree.
   *
   * A plain function rather than effect-only logic, because the "fit" button
   * has to be able to call it directly: an earlier version cleared the
   * already-fitted ref and nudged state, which did nothing at all — the effect's
   * dependencies had not changed, so it never re-ran and the button was inert.
   */
  const stopCamera = useCallback(() => {
    if (cameraFrame.current != null) cancelAnimationFrame(cameraFrame.current);
    cameraFrame.current = null;
  }, []);

  const commitView = useCallback((next: MapCameraView) => {
    viewRef.current = next;
    setView(next);
  }, []);

  const paintView = useCallback((next: MapCameraView) => {
    viewRef.current = next;
    sceneRef.current?.setAttribute("transform", `translate(${next.x},${next.y}) scale(${next.k})`);
  }, []);

  const animateView = useCallback((target: MapCameraView) => {
    stopCamera();
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      commitView(target);
      return;
    }
    const start = viewRef.current;
    const started = performance.now();
    const duration = 680;
    const frame = (now: number) => {
      const t = Math.min(1, (now - started) / duration);
      // Smoothstep with a slightly softer landing than CSS ease-in-out.
      const eased = 1 - Math.pow(1 - t, 3);
      const next = {
        x: start.x + (target.x - start.x) * eased,
        y: start.y + (target.y - start.y) * eased,
        k: start.k + (target.k - start.k) * eased,
      };
      // Move the SVG scene directly so a camera animation does not reconcile
      // hundreds of nodes on every frame. React receives the final view only.
      paintView(next);
      if (t < 1) cameraFrame.current = requestAnimationFrame(frame);
      else {
        cameraFrame.current = null;
        commitView(target);
      }
    };
    cameraFrame.current = requestAnimationFrame(frame);
  }, [commitView, paintView, stopCamera]);

  useEffect(() => () => stopCamera(), [stopCamera]);

  const doFit = useCallback((): boolean => {
    const el = wrapRef.current;
    if (!el || !map.nodes.length) return false;
    const r = el.getBoundingClientRect();
    const target = fitMapView(
      { width, height },
      { width: r.width, height: r.height },
    );
    if (!target) return false;
    stopCamera();
    commitView(target);
    return true;
  }, [width, height, map.nodes.length, commitView, stopCamera]);

  // Fit once per map shape, not per poll: refitting every 4s would fight the
  // user's own pan and zoom.
  const shapeKey = `${map.root ?? ""}:${map.total_nodes}:${map.nodes[0]?.path ?? ""}:${map.nodes.at(-1)?.path ?? ""}:${orientation}`;
  const fittedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!map.nodes.length) return;
    const fitWhenReady = () => {
      if (fittedFor.current === shapeKey) return;
      // A map can mount while its parent transition still measures 0×0. Do
      // not mark it fitted until a real viewport exists.
      if (doFit()) fittedFor.current = shapeKey;
    };
    fitWhenReady();
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(fitWhenReady);
    observer.observe(el);
    return () => observer.disconnect();
  }, [shapeKey, doFit]);

  // Live follow is an activity camera: each genuinely newer tool event gets a
  // smooth pan + zoom to its agent's current node. Polls returning the same
  // event do nothing, which avoids a subtle four-second camera twitch.
  const followedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!following || !focusPath) {
      followedFor.current = null;
      stopCamera();
      commitView(viewRef.current);
      return;
    }
    const signature = `${focusAgent?.session_id ?? ""}:${focusPath}:${focusTick}:${shapeKey}`;
    if (followedFor.current === signature) return;
    const node = posOf.get(focusPath);
    const el = wrapRef.current;
    if (!node || !el) return;
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    followedFor.current = signature;
    animateView(activityFocusView(node, rect));
  }, [
    following, focusPath, focusTick, focusAgent?.session_id,
    posOf, shapeKey, animateView, stopCamera, commitView,
  ]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("keydown", close);
    return () => { window.removeEventListener("click", close); window.removeEventListener("keydown", close); };
  }, [menu]);

  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const el = wrapRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const mx = e.clientX - r.left;
    const my = e.clientY - r.top;
    stopCamera();
    const current = viewRef.current;
    const k = Math.max(0.06, Math.min(3, current.k * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
    // Zoom about the pointer: keep whatever is under the cursor under it.
    commitView({
      k,
      x: mx - ((mx - current.x) / current.k) * k,
      y: my - ((my - current.y) / current.k) * k,
    });
  }, [commitView, stopCamera]);

  const trails = (map.agents ?? []).filter((a) => !trailFor || a.session_id === trailFor);

  return (
    <div
      ref={wrapRef}
      className="relative w-full h-full overflow-hidden"
      onWheel={onWheel}
      onMouseDown={(e) => {
        if (e.button !== 0) return;
        stopCamera();
        commitView(viewRef.current);
        drag.current = { x: e.clientX, y: e.clientY, vx: viewRef.current.x, vy: viewRef.current.y };
      }}
      onMouseMove={(e) => {
        const d = drag.current;
        if (!d) return;
        commitView({
          ...viewRef.current,
          x: d.vx + (e.clientX - d.x),
          y: d.vy + (e.clientY - d.y),
        });
      }}
      onMouseUp={() => { drag.current = null; }}
      onMouseLeave={() => { drag.current = null; }}
      style={{ cursor: drag.current ? "grabbing" : "grab" }}
    >
      <svg className="w-full h-full block" onContextMenu={(e) => e.preventDefault()}>
        <g ref={sceneRef} transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
          {/* edges first, so nodes sit on top of them */}
          {laid.map((n) =>
            n.parent && posOf.has(n.parent) ? (
              <path
                key={"e" + n.path}
                d={(() => {
                  const p = posOf.get(n.parent!)!;
                  if (orientation === "top-down") {
                    const my = (p.y + n.y) / 2;
                    return `M${p.x} ${p.y} C${p.x} ${my} ${n.x} ${my} ${n.x} ${n.y}`;
                  }
                  const mx = (p.x + n.x) / 2;
                  return `M${p.x} ${p.y} C${mx} ${p.y} ${mx} ${n.y} ${n.x} ${n.y}`;
                })()}
                fill="none"
                stroke="var(--border)"
                strokeOpacity={0.5}
                strokeWidth={1}
              />
            ) : null
          )}

          {/* agent trails — meaningful here because position means something */}
          {trails.map((a: MapAgent) => {
            const pts = a.trail.map((p) => posOf.get(p)).filter(Boolean) as LaidNode[];
            if (!pts.length) return null;
            const color = colorOf(a.session_id);
            const d = pts
              .map((p, i) => {
                if (i === 0) return `M${p.x} ${p.y}`;
                const q = pts[i - 1];
                if (orientation === "top-down") {
                  const my = (q.y + p.y) / 2;
                  return `C${q.x} ${my} ${p.x} ${my} ${p.x} ${p.y}`;
                }
                const mx = (q.x + p.x) / 2;
                return `C${mx} ${q.y} ${mx} ${p.y} ${p.x} ${p.y}`;
              })
              .join(" ");
            const head = pts[pts.length - 1];
            // Ids must be valid CSS selectors for mpath's href. Session ids are
            // uuids today, but sanitising costs nothing and a stray character
            // would break the animation silently rather than loudly.
            const pathId = `trail-${a.session_id.replace(/[^a-zA-Z0-9_-]/g, "")}`;
            // Pace by hops, not a fixed duration: a two-file trail crawling for
            // six seconds and a twelve-file trail sprinting the same six read as
            // the same thing, which loses the information the motion carries.
            const dur = Math.max(1.6, Math.min(9, pts.length * 0.55));
            return (
              <g key={"t" + a.session_id}>
                <path id={pathId} d={d} fill="none" stroke={color} strokeWidth={2} strokeOpacity={0.5}
                  strokeLinecap="round" strokeDasharray="5 4" />
                {/* Argus animated an agent stepping along its trail rather than
                    just marking where it stopped. The travelling dot restores
                    that: it shows DIRECTION — which way through the tree the
                    session actually moved — that a static marker cannot. */}
                {pts.length > 1 && (
                  <circle r={3} fill={color} fillOpacity={0.85}>
                    <animateMotion dur={`${dur}s`} repeatCount="indefinite" rotate="auto">
                      <mpath href={`#${pathId}`} />
                    </animateMotion>
                    <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.08;0.92;1"
                      dur={`${dur}s`} repeatCount="indefinite" />
                  </circle>
                )}
                {/* Where it is NOW — the destination the trail leads to. */}
                <circle cx={head.x} cy={head.y} r={7} fill="none" stroke={color} strokeWidth={1.5}>
                  <animate attributeName="r" values="7;13;7" dur="1.9s" repeatCount="indefinite" />
                  <animate attributeName="opacity" values="0.9;0;0.9" dur="1.9s" repeatCount="indefinite" />
                </circle>
                <circle cx={head.x} cy={head.y} r={4} fill={color} />
              </g>
            );
          })}

          {/* nodes */}
          {laid.map((n) => {
            const hot = n.unclaimed > 0;
            const isPicked = picked === n.path;
            const r = radiusOf(n);
            const fill = hot
              ? "var(--error)"
              : n.agents.length
                ? colorOf(n.agents[0])
                : n.kind === "dir"
                  ? "var(--text4)"
                  : "var(--text3)";
            return (
              <g
                key={n.path}
                transform={`translate(${n.x},${n.y})`}
                style={{ cursor: "pointer" }}
                onClick={(e) => { e.stopPropagation(); onPick(n); }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  const wrap = wrapRef.current?.getBoundingClientRect();
                  setMenu({ x: e.clientX - (wrap?.left ?? 0), y: e.clientY - (wrap?.top ?? 0), node: n });
                }}
              >
                {isPicked && <circle r={r + 5} fill="none" stroke="var(--primary)" strokeWidth={1.5} />}
                <circle r={r} fill={fill} fillOpacity={n.kind === "dir" ? 0.55 : 0.9} />
                {/* Labels only where they will not turn into a grey smear:
                    directories, anything picked, and files with real activity. */}
                {(n.kind === "dir" || isPicked || n.touches + n.unclaimed > 0) && (
                  <text
                    x={r + 5}
                    y={3.5}
                    fontSize={11}
                    fill={hot ? "var(--error)" : n.kind === "dir" ? "var(--text2)" : "var(--text3)"}
                    style={{ pointerEvents: "none", fontWeight: n.kind === "dir" ? 600 : 400 }}
                  >
                    {n.name}
                    {n.unclaimed > 0 ? `  ⚠${n.unclaimed}` : ""}
                  </text>
                )}
              </g>
            );
          })}
        </g>
      </svg>

      {following && focusAgent && (
        <div
          className="absolute top-3 right-3 w-[min(300px,calc(100%_-_24px))] rounded-xl p-3 pointer-events-none"
          style={{
            background: "color-mix(in srgb, var(--bg2) 92%, transparent)",
            border: `1px solid color-mix(in srgb, ${colorOf(focusAgent.session_id)} 55%, transparent)`,
            boxShadow: "0 14px 34px -22px var(--shadow)",
          }}
        >
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full shrink-0" style={{ background: colorOf(focusAgent.session_id) }} />
            <span className="text-[10px] uppercase tracking-wide font-semibold"
              style={{ color: focusAgent.live ? "var(--success)" : "var(--text3)" }}>
              {activityLabel(focusAgent)}
            </span>
            <span className="ml-auto text-[9px] tabular-nums" style={{ color: "var(--text4)" }}>
              {focusAgent.pid == null ? "PID unavailable" : `PID ${focusAgent.pid}`}
            </span>
          </div>
          <div className="mt-1 text-[12px] font-semibold truncate" style={{ color: "var(--text)" }}
            title={focusAgent.source_app}>
            {displaySourceApp(focusAgent.source_app)}
          </div>
          <div className="mt-0.5 text-[10px] truncate" style={{ color: "var(--text3)" }}
            title={focusAgent.current ?? ""}>
            {focusAgent.current
              ? root && focusAgent.current.startsWith(root + "/")
                ? focusAgent.current.slice(root.length + 1)
                : focusAgent.current
              : "No current file"}
          </div>
          <div className="mt-1 flex items-center gap-2 text-[9px]" style={{ color: "var(--text4)" }}>
            <span>{focusAgent.current_tool ?? "activity"}</span>
            <span>session {focusAgent.session_id.slice(0, 8)}</span>
          </div>
        </div>
      )}

      {/* zoom controls — a trackpad can pinch, a mouse wheel alone cannot
          always, and "I cannot find the tree" is a bad first experience */}
      <div className="absolute bottom-3 right-3 flex items-center gap-1">
        {[["−", 1 / 1.25], ["+", 1.25]].map(([label, f]) => (
          <button key={label as string}
            onClick={() => {
              stopCamera();
              const current = viewRef.current;
              commitView({ ...current, k: Math.max(0.06, Math.min(3, current.k * (f as number))) });
            }}
            className="w-6 h-6 rounded text-[13px] leading-none transition-opacity hover:opacity-80"
            style={{ background: "var(--bg2)", color: "var(--text2)", border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)" }}>
            {label as string}
          </button>
        ))}
        <button
          onClick={doFit}
          className="px-2 h-6 rounded text-[10px] transition-opacity hover:opacity-80"
          style={{ background: "var(--bg2)", color: "var(--text3)", border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)" }}>
          fit
        </button>
        <button
          onClick={onToggleFollowing}
          className="flex items-center gap-1.5 px-2 h-6 rounded text-[10px] font-semibold transition-opacity hover:opacity-80"
          style={{
            background: `color-mix(in srgb, ${following ? "var(--success)" : "var(--bg2)"} 14%, var(--bg2))`,
            color: following ? "var(--success)" : "var(--text4)",
            border: `1px solid color-mix(in srgb, ${following ? "var(--success)" : "var(--border)"} 45%, transparent)`,
          }}
          title={following ? "Stop the activity-follow camera" : "Smoothly follow the newest agent activity"}
        >
          <span className="w-1.5 h-1.5 rounded-full" style={{ background: following ? "var(--success)" : "var(--text4)" }} />
          {following ? "LIVE" : "live"}
        </button>
      </div>

      {menu && (
        <div
          className="absolute z-10 rounded-lg py-1 text-[11px] shadow-lg"
          style={{
            left: Math.min(menu.x, (wrapRef.current?.clientWidth ?? 400) - 210),
            top: menu.y,
            width: 200,
            background: "var(--bg2)",
            border: "1px solid color-mix(in srgb, var(--border) 55%, transparent)",
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-3 py-1.5 truncate" style={{ color: "var(--text4)" }} title={menu.node.path}>
            {menu.node.name}
          </div>
          <button
            onClick={() => { onReveal(menu.node.path); setMenu(null); }}
            className="w-full text-left px-3 py-1.5 transition-colors hover:opacity-80"
            style={{ color: "var(--text2)" }}
          >
            Reveal in {navigator.platform.startsWith("Mac") ? "Finder" : "File Explorer"}
          </button>
          <button
            onClick={() => { void navigator.clipboard?.writeText(menu.node.path); setMenu(null); }}
            className="w-full text-left px-3 py-1.5 transition-colors hover:opacity-80"
            style={{ color: "var(--text2)" }}
          >
            Copy path
          </button>
        </div>
      )}
    </div>
  );
}
