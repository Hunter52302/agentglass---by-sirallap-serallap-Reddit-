// Glasses for Argus — the node map.
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

export interface LaidNode extends MapNode {
  x: number;
  y: number;
  parent: string | null;
}

const COL_W = 190; // horizontal distance per depth level
const ROW_H = 26; // vertical distance per leaf

/**
 * Tidy tree layout.
 *
 * Leaves take consecutive vertical slots in render order; every parent centres
 * on its children. Deterministic, so a node does not jump between refreshes —
 * which matters more here than elegance, because the thing being watched is
 * live and a layout that reshuffles is unreadable.
 */
export function layout(nodes: MapNode[]): { laid: LaidNode[]; width: number; height: number } {
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
    laid.push({ ...n, x: p.x, y: p.y, parent: byPath.has(parent) ? parent : null });
  }
  const maxDepth = Math.max(0, ...laid.map((n) => n.depth));
  return { laid, width: (maxDepth + 1) * COL_W + 240, height: Math.max(nextLeafY, ROW_H) + 40 };
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
  map, colorOf, trailFor, onPick, picked, onReveal,
}: {
  map: FsMap;
  colorOf: (id: string) => string;
  trailFor: string | null;
  onPick: (n: MapNode) => void;
  picked: string | null;
  onReveal: (path: string) => void;
}) {
  const { laid, width, height } = useMemo(() => layout(map.nodes), [map.nodes]);
  const posOf = useMemo(() => new Map(laid.map((n) => [n.path, n])), [laid]);

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [view, setView] = useState({ x: 40, y: 20, k: 0.75 });
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
  const doFit = useCallback(() => {
    const el = wrapRef.current;
    if (!el || !map.nodes.length) return;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return;
    // Floor low enough that a few hundred nodes actually fit. A tall tree
    // clamped to a comfortable zoom is worse than a small one: it opens half
    // off-screen and reads as broken.
    const k = Math.max(0.08, Math.min(1.1, Math.min(r.width / width, r.height / height) * 0.95));
    // Centre only when it fits. Otherwise pin to the top — an overflowing tree
    // centred vertically is clipped at BOTH ends, and the user cannot tell
    // which way to scroll to find the root.
    const fits = height * k <= r.height;
    setView({ x: 24, y: fits ? (r.height - height * k) / 2 : 16, k });
  }, [width, height, map.nodes.length]);

  // Fit once per map shape, not per poll: refitting every 4s would fight the
  // user's own pan and zoom.
  const shapeKey = `${map.nodes.length}:${map.root ?? ""}`;
  const fittedFor = useRef<string | null>(null);
  useEffect(() => {
    if (fittedFor.current === shapeKey) return;
    fittedFor.current = shapeKey;
    doFit();
  }, [shapeKey, doFit]);

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
    setView((v) => {
      const k = Math.max(0.06, Math.min(3, v.k * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
      // Zoom about the pointer: keep whatever is under the cursor under it.
      return { k, x: mx - ((mx - v.x) / v.k) * k, y: my - ((my - v.y) / v.k) * k };
    });
  }, []);

  const trails = (map.agents ?? []).filter((a) => !trailFor || a.session_id === trailFor);

  return (
    <div
      ref={wrapRef}
      className="relative w-full h-full overflow-hidden"
      onWheel={onWheel}
      onMouseDown={(e) => {
        if (e.button !== 0) return;
        drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
      }}
      onMouseMove={(e) => {
        const d = drag.current;
        if (!d) return;
        setView((v) => ({ ...v, x: d.vx + (e.clientX - d.x), y: d.vy + (e.clientY - d.y) }));
      }}
      onMouseUp={() => { drag.current = null; }}
      onMouseLeave={() => { drag.current = null; }}
      style={{ cursor: drag.current ? "grabbing" : "grab" }}
    >
      <svg className="w-full h-full block" onContextMenu={(e) => e.preventDefault()}>
        <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
          {/* edges first, so nodes sit on top of them */}
          {laid.map((n) =>
            n.parent && posOf.has(n.parent) ? (
              <path
                key={"e" + n.path}
                d={(() => {
                  const p = posOf.get(n.parent!)!;
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
                const mx = (q.x + p.x) / 2;
                return `C${mx} ${q.y} ${mx} ${p.y} ${p.x} ${p.y}`;
              })
              .join(" ");
            const head = pts[pts.length - 1];
            return (
              <g key={"t" + a.session_id}>
                <path d={d} fill="none" stroke={color} strokeWidth={2} strokeOpacity={0.5}
                  strokeLinecap="round" strokeDasharray="5 4" />
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

      {/* zoom controls — a trackpad can pinch, a mouse wheel alone cannot
          always, and "I cannot find the tree" is a bad first experience */}
      <div className="absolute bottom-3 right-3 flex items-center gap-1">
        {[["−", 1 / 1.25], ["+", 1.25]].map(([label, f]) => (
          <button key={label as string}
            onClick={() => setView((v) => ({ ...v, k: Math.max(0.06, Math.min(3, v.k * (f as number))) }))}
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
