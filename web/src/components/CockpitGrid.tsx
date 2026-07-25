import { useMemo, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from "react";
import {
  loadCockpitLayout,
  placeCockpitItem,
  saveCockpitLayout,
  type CockpitItemState,
} from "../lib/cockpitLayout.ts";

export interface CockpitWidget {
  id: string;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  content: ReactNode;
}

type ResizeZone = "move" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";
type Gesture = {
  id: string;
  zone: ResizeZone;
  pointerId: number;
  startX: number;
  startY: number;
  base: CockpitItemState[];
  item: CockpitItemState;
  colStep: number;
  rowStep: number;
};

const HANDLE: Record<Exclude<ResizeZone, "move">, CSSProperties> = {
  nw: { left: -5, top: -5, cursor: "nwse-resize" },
  n: { left: "50%", top: -5, transform: "translateX(-50%)", cursor: "ns-resize" },
  ne: { right: -5, top: -5, cursor: "nesw-resize" },
  e: { right: -5, top: "50%", transform: "translateY(-50%)", cursor: "ew-resize" },
  se: { right: -5, bottom: -5, cursor: "nwse-resize" },
  s: { left: "50%", bottom: -5, transform: "translateX(-50%)", cursor: "ns-resize" },
  sw: { left: -5, bottom: -5, cursor: "nesw-resize" },
  w: { left: -5, top: "50%", transform: "translateY(-50%)", cursor: "ew-resize" },
};

export function CockpitGrid({ widgets }: { widgets: CockpitWidget[] }) {
  const defaults = useMemo<CockpitItemState[]>(
    () => widgets.map((widget) => ({
      id: widget.id,
      x: widget.x,
      y: widget.y,
      width: widget.width,
      height: widget.height,
      hidden: false,
      collapsed: false,
    })),
    // Widget ids and shipped positions are stable for this app session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const [items, setItems] = useState(() => loadCockpitLayout(defaults));
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const [editing, setEditing] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);

  const commit = (next: CockpitItemState[]) => {
    itemsRef.current = next;
    setItems(next);
    saveCockpitLayout(next);
  };
  const patch = (id: string, update: Partial<CockpitItemState>) =>
    commit(placeCockpitItem(itemsRef.current, id, update));

  const begin = (event: PointerEvent<HTMLElement>, id: string, zone: ResizeZone) => {
    if (!editing) return;
    const item = itemsRef.current.find((entry) => entry.id === id);
    const rect = gridRef.current?.getBoundingClientRect();
    if (!item || !rect) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const gap = 12;
    gesture.current = {
      id,
      zone,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      base: itemsRef.current.map((entry) => ({ ...entry })),
      item: { ...item },
      colStep: (rect.width - gap * 11) / 12 + gap,
      rowStep: 84,
    };
    setActive(id);
  };

  const move = (event: PointerEvent<HTMLElement>) => {
    const drag = gesture.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = Math.round((event.clientX - drag.startX) / drag.colStep);
    const dy = Math.round((event.clientY - drag.startY) / drag.rowStep);
    const update: Partial<CockpitItemState> = {};
    if (drag.zone === "move") {
      update.x = drag.item.x + dx;
      update.y = drag.item.y + dy;
    } else {
      if (drag.zone.includes("e")) update.width = drag.item.width + dx;
      if (drag.zone.includes("s")) update.height = drag.item.height + dy;
      if (drag.zone.includes("w")) {
        update.x = drag.item.x + dx;
        update.width = drag.item.width - dx;
      }
      if (drag.zone.includes("n")) {
        update.y = drag.item.y + dy;
        update.height = drag.item.height - dy;
      }
      update.collapsed = false;
    }
    const next = placeCockpitItem(drag.base, drag.id, update);
    itemsRef.current = next;
    setItems(next);
  };

  const end = (event: PointerEvent<HTMLElement>) => {
    if (gesture.current?.pointerId !== event.pointerId) return;
    saveCockpitLayout(itemsRef.current);
    gesture.current = null;
    setActive(null);
  };

  const registry = new Map(widgets.map((widget) => [widget.id, widget]));
  const hidden = items.filter((item) => item.hidden && registry.has(item.id));
  const visible = items
    .filter((item) => !item.hidden && registry.has(item.id))
    .sort((a, b) => a.y - b.y || a.x - b.x);

  const reset = () => commit(defaults.map((item) => ({ ...item })));

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 min-h-8 flex-wrap">
        <button
          onClick={() => setEditing((value) => !value)}
          className="px-3 py-1.5 rounded-lg text-[11px] font-semibold shrink-0"
          style={{
            color: editing ? "var(--success)" : "var(--primary-hover)",
            background: `color-mix(in srgb, ${editing ? "var(--success)" : "var(--primary)"} 14%, transparent)`,
            border: `1px solid color-mix(in srgb, ${editing ? "var(--success)" : "var(--primary)"} 45%, transparent)`,
          }}
        >
          {editing ? "✓ Done editing" : "Edit cockpit"}
        </button>
        {editing && (
          <>
            <span className="text-[10px] grow min-w-[180px]" style={{ color: "var(--text4)" }}>
              Drag the widget label to move. Drag any blue point to resize.
            </span>
            <select
              value=""
              disabled={!hidden.length}
              onChange={(e) => {
                if (e.target.value) patch(e.target.value, { hidden: false, collapsed: false });
                e.currentTarget.value = "";
              }}
              className="px-2 py-1 rounded-lg text-[10px] outline-none"
              style={{ background: "var(--bg2)", color: "var(--text2)", border: "1px solid var(--border)" }}
            >
              <option value="">{hidden.length ? "+ Add widget" : "All widgets added"}</option>
              {hidden.map((item) => <option key={item.id} value={item.id}>{registry.get(item.id)?.title}</option>)}
            </select>
            <button onClick={reset}
              className="px-2.5 py-1 rounded-lg text-[10px] shrink-0"
              style={{ color: "var(--warning)", border: "1px solid color-mix(in srgb, var(--warning) 35%, transparent)" }}>
              Reset to default
            </button>
          </>
        )}
      </div>

      <div ref={gridRef} className={`cockpit-grid ${editing ? "cockpit-grid-editing" : ""}`}>
        {visible.map((item) => {
          const widget = registry.get(item.id)!;
          return (
            <div
              key={item.id}
              className={`cockpit-widget relative min-w-0 min-h-0 ${item.collapsed ? "cockpit-widget-collapsed" : ""}`}
              style={{
                gridColumn: `${item.x + 1} / span ${item.width}`,
                gridRow: `${item.y + 1} / span ${item.collapsed ? 1 : item.height}`,
                "--cockpit-mobile-height": `${Math.max(1, item.collapsed ? 1 : item.height) * 72 + Math.max(0, (item.collapsed ? 1 : item.height) - 1) * 12}px`,
                zIndex: active === item.id ? 30 : undefined,
              } as CSSProperties}
            >
              {editing && (
                <>
                  <div className="cockpit-selection-border pointer-events-none" />
                  <div
                    className="cockpit-drag-label"
                    onPointerDown={(event) => begin(event, item.id, "move")}
                    onPointerMove={move}
                    onPointerUp={end}
                    onPointerCancel={end}
                    title="Drag to move"
                  >
                    ⠿ {widget.title}
                  </div>
                  <div className="cockpit-card-actions">
                    <button title={item.collapsed ? "Expand" : "Collapse"}
                      onClick={() => patch(item.id, { collapsed: !item.collapsed })}>
                      {item.collapsed ? "□" : "—"}
                    </button>
                    <button title="Remove widget" onClick={() => patch(item.id, { hidden: true })}>×</button>
                  </div>
                  {(Object.keys(HANDLE) as Array<keyof typeof HANDLE>).map((zone) => (
                    <span
                      key={zone}
                      className="cockpit-resize-point"
                      style={HANDLE[zone]}
                      onPointerDown={(event) => begin(event, item.id, zone)}
                      onPointerMove={move}
                      onPointerUp={end}
                      onPointerCancel={end}
                      title={`Resize ${zone}`}
                    />
                  ))}
                </>
              )}
              {item.collapsed ? (
                <button onClick={() => patch(item.id, { collapsed: false })}
                  className="panel w-full h-full px-4 text-left text-[12px] font-semibold"
                  style={{ color: "var(--text2)" }}>
                  {widget.title} <span className="float-right" style={{ color: "var(--text4)" }}>expand</span>
                </button>
              ) : widget.content}
            </div>
          );
        })}
      </div>
    </div>
  );
}
