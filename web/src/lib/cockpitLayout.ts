export interface CockpitItemState {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  hidden: boolean;
  collapsed: boolean;
}

export const COCKPIT_LAYOUT_KEY = "agentglass.cockpit.layout.v2";

export function mergeCockpitLayout(
  defaults: CockpitItemState[],
  saved: unknown,
): CockpitItemState[] {
  const byId = new Map(defaults.map((item) => [item.id, item]));
  const result: CockpitItemState[] = [];
  if (Array.isArray(saved)) {
    for (const raw of saved) {
      if (!raw || typeof raw !== "object") continue;
      const item = raw as Partial<CockpitItemState>;
      const base = typeof item.id === "string" ? byId.get(item.id) : undefined;
      if (!base || result.some((entry) => entry.id === base.id)) continue;
      result.push({
        id: base.id,
        x: clamp(Number(item.x) || 0, 0, 11),
        y: Math.max(0, Number(item.y) || 0),
        width: clamp(Number(item.width) || base.width, 2, 12),
        height: clamp(Number(item.height) || base.height, 1, 10),
        hidden: item.hidden === true,
        collapsed: item.collapsed === true,
      });
    }
  }
  for (const item of defaults) {
    if (!result.some((entry) => entry.id === item.id)) result.push({ ...item });
  }
  return result;
}

export function loadCockpitLayout(defaults: CockpitItemState[]): CockpitItemState[] {
  try {
    return mergeCockpitLayout(defaults, JSON.parse(localStorage.getItem(COCKPIT_LAYOUT_KEY) || "null"));
  } catch {
    return defaults.map((item) => ({ ...item }));
  }
}

export function saveCockpitLayout(items: CockpitItemState[]) {
  try { localStorage.setItem(COCKPIT_LAYOUT_KEY, JSON.stringify(items)); } catch { /* private mode */ }
}

export const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

const itemHeight = (item: CockpitItemState) => item.collapsed ? 1 : item.height;

export function overlaps(a: CockpitItemState, b: CockpitItemState): boolean {
  if (a.hidden || b.hidden) return false;
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + itemHeight(b) &&
    a.y + itemHeight(a) > b.y
  );
}

/**
 * Place one widget, then slide anything in its way downward. This mirrors a
 * phone home screen: the dragged item owns its new zone and neighbours make
 * room instead of rendering on top of it.
 */
export function placeCockpitItem(
  items: CockpitItemState[],
  id: string,
  update: Partial<CockpitItemState>,
): CockpitItemState[] {
  const next = items.map((item) => item.id === id ? { ...item, ...update } : { ...item });
  const moved = next.find((item) => item.id === id);
  if (!moved) return next;
  moved.width = clamp(moved.width, 2, 12);
  moved.height = clamp(moved.height, 1, 10);
  moved.x = clamp(moved.x, 0, 12 - moved.width);
  moved.y = Math.max(0, moved.y);

  const queue = [moved];
  const seen = new Set<string>();
  while (queue.length) {
    const anchor = queue.shift()!;
    if (seen.has(anchor.id)) continue;
    seen.add(anchor.id);
    for (const other of next) {
      if (other.id === anchor.id || !overlaps(anchor, other)) continue;
      other.y = anchor.y + itemHeight(anchor);
      queue.push(other);
    }
  }
  return next;
}
