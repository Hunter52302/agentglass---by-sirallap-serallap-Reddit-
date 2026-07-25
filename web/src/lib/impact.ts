import type { ImpactRange, ImpactSettings, ImpactTotal, WaterUnit } from "../../../shared/impact.ts";

const exact = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 3 });

export function formatWater(ml: number | null, unit: WaterUnit = "auto"): string {
  if (ml === null || !Number.isFinite(ml)) return "water unknown";
  const safe = Math.max(0, ml);
  if (unit === "auto") {
    if (safe >= 1000) return `${exact.format(safe / 1000)} L`;
    return `${exact.format(safe)} mL`;
  }
  if (unit === "ml") return `${exact.format(safe)} mL`;
  if (unit === "l") return `${exact.format(safe / 1000)} L`;
  if (unit === "us_gallon") return `${exact.format(safe / 3785.411784)} US gal`;
  const bottles = safe / 473.176473;
  return `${exact.format(bottles)} bottle${bottles === 1 ? "" : "s"}`;
}

export function formatWaterRange(value: ImpactRange, settings: ImpactSettings): string {
  if (value.central === null) return "water unknown";
  const central = formatWater(value.central, settings.water_unit);
  if (settings.estimate_display === "central" || value.low === null || value.high === null) return central;
  const low = formatWater(value.low, settings.water_unit);
  const high = formatWater(value.high, settings.water_unit);
  if (settings.estimate_display === "range") return `${low}–${high}`;
  return `${central} (${low}–${high})`;
}

export function bottleText(ml: number): { headline: string; detail: string } {
  const bottles = Math.max(0, ml) / 473.176473;
  if (bottles < 0.01) {
    return {
      headline: `${exact.format(bottles * 100)}% of one 16-fl-oz bottle`,
      detail: "Volume equivalent only",
    };
  }
  const full = Math.floor(bottles);
  const fill = bottles - full;
  return {
    headline: `Equivalent to filling ${exact.format(bottles)} 16-fl-oz bottles`,
    detail: `${full} full bottle${full === 1 ? "" : "s"} · Next bottle ${Math.round(fill * 100)}% filled`,
  };
}

export function displayHasWater(mode: ImpactSettings["display_mode"]): boolean {
  return mode === "water" || mode === "cost_water" || mode === "tokens_water" || mode === "all";
}

export function formatWaterComponents(total: ImpactTotal, settings: ImpactSettings): string {
  const parts: string[] = [];
  if (total.water_s1_ml.central !== null) parts.push(`S1 ${formatWater(total.water_s1_ml.central, settings.water_unit)}`);
  if (total.water_s2_ml.central !== null) parts.push(`S2 ${formatWater(total.water_s2_ml.central, settings.water_unit)}`);
  if (total.water_s3_ml.central !== null) parts.push(`S3 ${formatWater(total.water_s3_ml.central, settings.water_unit)}`);
  if (total.boundary_label === "scope unknown") parts.push("unknown scope");
  if (!parts.length) return "water unknown";
  if (total.incomplete) parts.push("incomplete");
  return parts.join(" · ");
}

export function formatWaterInline(total: ImpactTotal, settings: ImpactSettings): string {
  const value = settings.estimate_display === "components"
    ? formatWaterComponents(total, settings)
    : formatWaterRange(total.water_consumption_ml, settings);
  if (value === "water unknown") return value;
  return `${value} · ${total.boundary_label}`;
}
