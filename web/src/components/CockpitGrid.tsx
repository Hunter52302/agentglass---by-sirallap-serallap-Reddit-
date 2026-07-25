import { useMemo, useState, type ReactNode } from "react";
import {
  clamp,
  loadCockpitLayout,
  saveCockpitLayout,
  type CockpitItemState,
} from "../lib/cockpitLayout.ts";

export interface CockpitWidget {
  id: string;
  title: string;
  width: number;
  height: number;
  content: ReactNode;
}

export function CockpitGrid({ widgets }: { widgets: CockpitWidget[] }) {
  const defaults = useMemo<CockpitItemState[]>(
    () => widgets.map((widget) => ({
      id: widget.id,
      width: widget.width,
      height: widget.height,
      hidden: false,
      collapsed: false,
    })),
    // Widget ids and shipped sizes are stable for the lifetime of the app.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const [items, setItems] = useState(() => loadCockpitLayout(defaults));
  const [editing, setEditing] = useState(false);
  const [dragging, setDragging] = useState<string | null>(null);

  const commit = (next: CockpitItemState[]) => {
    setItems(next);
    saveCockpitLayout(next);
  };
  const patch = (id: string, update: Partial<CockpitItemState>) =>
    commit(items.map((item) => item.id === id ? { ...item, ...update } : item));
  const move = (from: string, to: string) => {
    if (from === to) return;
    const next = [...items];
    const fromIndex = next.findIndex((item) => item.id === from);
    const toIndex = next.findIndex((item) => item.id === to);
    if (fromIndex < 0 || toIndex < 0) return;
    const [item] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, item!);
    commit(next);
  };

  const registry = new Map(widgets.map((widget) => [widget.id, widget]));
  const hidden = items.filter((item) => item.hidden && registry.has(item.id));

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 min-h-8">
        <button
          onClick={() => setEditing((value) => !value)}
          className="px-3 py-1.5 rounded-lg text-[11px] font-semibold"
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
            <span className="text-[10px]" style={{ color: "var(--text4)" }}>
              Drag widgets to move them. Resize, collapse, or remove from each card.
            </span>
            {hidden.length > 0 && (
              <select
                value=""
                onChange={(e) => {
                  if (e.target.value) patch(e.target.value, { hidden: false });
                  e.currentTarget.value = "";
                }}
                className="ml-auto px-2 py-1 rounded-lg text-[10px] outline-none"
                style={{ background: "var(--bg2)", color: "var(--text2)", border: "1px solid var(--border)" }}
              >
                <option value="">+ Add widget</option>
                {hidden.map((item) => <option key={item.id} value={item.id}>{registry.get(item.id)?.title}</option>)}
              </select>
            )}
            <button onClick={() => commit(defaults.map((item) => ({ ...item })))}
              className={hidden.length ? "px-2 py-1 text-[10px]" : "ml-auto px-2 py-1 text-[10px]"}
              style={{ color: "var(--text4)" }}>
              Reset grid
            </button>
          </>
        )}
      </div>

      <div className={`cockpit-grid ${editing ? "cockpit-grid-editing" : ""}`}>
        {items.map((item) => {
          const widget = registry.get(item.id);
          if (!widget || item.hidden) return null;
          return (
            <div
              key={item.id}
              className="cockpit-widget relative min-w-0 min-h-0"
              style={{
                gridColumn: `span ${item.width}`,
                gridRow: `span ${item.collapsed ? 1 : item.height}`,
                opacity: dragging === item.id ? 0.5 : 1,
              }}
              draggable={editing}
              onDragStart={() => setDragging(item.id)}
              onDragEnd={() => setDragging(null)}
              onDragOver={(e) => { if (editing) e.preventDefault(); }}
              onDrop={() => { if (dragging) move(dragging, item.id); }}
            >
              {editing && (
                <div
                  className="absolute z-20 top-1 right-1 flex items-center gap-1 p-1 rounded-lg shadow-lg"
                  style={{ background: "color-mix(in srgb, var(--bg) 92%, transparent)", border: "1px solid var(--border)" }}
                  onMouseDown={(e) => e.stopPropagation()}
                >
                  <span className="px-1 text-[10px] cursor-grab" title="Drag to move">⠿ {widget.title}</span>
                  <button title="Narrower" onClick={() => patch(item.id, { width: clamp(item.width - 1, 2, 12) })}>↔−</button>
                  <button title="Wider" onClick={() => patch(item.id, { width: clamp(item.width + 1, 2, 12) })}>↔+</button>
                  <button title="Shorter" onClick={() => patch(item.id, { height: clamp(item.height - 1, 1, 10), collapsed: false })}>↕−</button>
                  <button title="Taller" onClick={() => patch(item.id, { height: clamp(item.height + 1, 1, 10), collapsed: false })}>↕+</button>
                  <button title={item.collapsed ? "Expand" : "Collapse"}
                    onClick={() => patch(item.id, { collapsed: !item.collapsed })}>
                    {item.collapsed ? "□" : "—"}
                  </button>
                  <button title="Remove widget" onClick={() => patch(item.id, { hidden: true })}>×</button>
                </div>
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
