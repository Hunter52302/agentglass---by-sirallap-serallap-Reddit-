export interface CockpitItemState {
  id: string;
  width: number;
  height: number;
  hidden: boolean;
  collapsed: boolean;
}

export const COCKPIT_LAYOUT_KEY = "serrallapa.cockpit.layout.v1";

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

