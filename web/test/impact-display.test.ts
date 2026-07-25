import { describe, expect, test } from "bun:test";
import type { ImpactSettings, ImpactTotal } from "../../shared/impact.ts";
import {
  bottleText,
  displayHasWater,
  formatWater,
  formatWaterComponents,
  formatWaterInline,
  formatWaterRange,
} from "../src/lib/impact.ts";

const settings: ImpactSettings = {
  display_mode: "cost",
  water_unit: "auto",
  boundary: "source_native",
  estimate_display: "central_range",
  profile_behavior: "strict",
  unavailable_behavior: "show",
  proxy_profile_id: null,
  regional_factor_id: "factor",
  lifecycle_enabled: false,
  daily_budget_ml: null,
  weekly_budget_ml: null,
  monthly_budget_ml: null,
  window_budget_ml: null,
  custom_budget_ml: null,
  custom_period_ms: null,
};

const total: ImpactTotal = {
  energy_wh: { low: 0.2, central: 0.24, high: 0.3 },
  water_consumption_ml: { low: 900, central: 1344.8, high: 2100 },
  water_withdrawal_ml: { low: null, central: null, high: null },
  water_s1_ml: { low: null, central: 260, high: null },
  water_s2_ml: { low: null, central: 1084.8, high: null },
  water_s3_ml: { low: null, central: null, high: null },
  known_rows: 2,
  unknown_rows: 0,
  incomplete: false,
  boundary_label: "S1+S2",
  source_refs: [],
};

describe("impact display", () => {
  test("cost remains default and water modes are explicit", () => {
    expect(displayHasWater("cost")).toBe(false);
    expect(displayHasWater("tokens")).toBe(false);
    expect(displayHasWater("water")).toBe(true);
    expect(displayHasWater("cost_water")).toBe(true);
    expect(displayHasWater("tokens_water")).toBe(true);
    expect(displayHasWater("all")).toBe(true);
  });

  test("public values use compact en-US units and ranges", () => {
    expect(formatWater(1344.8)).toBe("1.34 L");
    expect(formatWaterRange(total.water_consumption_ml, settings)).toBe("1.34 L (900 mL–2.1 L)");
    expect(formatWater(3785.411784, "us_gallon")).toBe("1 US gal");
    expect(formatWater(473.176473, "bottle_16oz")).toBe("1 bottle");
  });

  test("unknown never becomes zero", () => {
    expect(formatWater(null)).toBe("water unknown");
    expect(formatWaterRange({ low: null, central: null, high: null }, settings)).toBe("water unknown");
    expect(formatWaterInline({ ...total, water_consumption_ml: { low: null, central: null, high: null } }, settings)).toBe("water unknown");
  });

  test("boundary stays inline and components stay separate", () => {
    expect(formatWaterInline(total, settings)).toBe("1.34 L (900 mL–2.1 L) · S1+S2");
    expect(formatWaterComponents(total, settings)).toBe("S1 260 mL · S2 1.08 L");
  });

  test("bottle ticker describes volume only", () => {
    expect(bottleText(2.49 * 473.176473)).toEqual({
      headline: "Equivalent to filling 2.49 16-fl-oz bottles",
      detail: "2 full bottles · Next bottle 49% filled",
    });
    expect(bottleText(0.32176).headline).toBe("0.068% of one 16-fl-oz bottle");
    expect(bottleText(0.32176).detail).toBe("Volume equivalent only");
  });
});
