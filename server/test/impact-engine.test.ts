import { describe, expect, test } from "bun:test";
import type { ImpactProfile, ImpactSettings } from "../../shared/impact.ts";
import {
  bottleEquivalent, budgetRemaining, DEFAULT_IMPACT_SETTINGS, estimateImpact,
  resolveImpactProfile, usGallons,
} from "../src/impact/engine.ts";
import { IMPACT_PROFILES, validateImpactProfile } from "../src/impact/profiles.ts";

const settings = (over: Partial<ImpactSettings> = {}): ImpactSettings => ({ ...DEFAULT_IMPACT_SETTINGS, ...over });

describe("impact profile contract", () => {
  test("built-in profiles carry required scientific metadata", () => {
    for (const profile of IMPACT_PROFILES) expect(validateImpactProfile(profile)).toEqual([]);
  });

  test("unknown scope must be explicit and cannot coexist with assigned scopes", () => {
    const base = IMPACT_PROFILES[0];
    expect(validateImpactProfile({ ...base, scopes_included: [], scope_unknown: false }))
      .toContain("profile must declare known scopes or explicitly unknown scope");
    expect(validateImpactProfile({ ...base, scopes_included: [1], scope_unknown: true }))
      .toContain("profile must declare known scopes or explicitly unknown scope");
  });

  test("strict matching never uses another provider", () => {
    expect(resolveImpactProfile("claude-sonnet-5", "Anthropic", "short_text", settings())).toBeNull();
  });

  test("source-native OpenAI boundary stays undisclosed", () => {
    const impact = estimateImpact({
      usage: { input_tokens: 100, output_tokens: 20 },
      model: "gpt-4o", provider: "OpenAI", settings: settings(),
    });
    expect(impact.water_consumption_ml.central).toBeCloseTo(0.32176);
    expect(impact.water_s1_ml.central).toBeNull();
    expect(impact.water_s2_ml.central).toBeNull();
    expect(impact.unknown_scopes).toEqual([1, 2, 3]);
  });
});

describe("profile estimates", () => {
  test("Google direct and operational scenario remain separate", () => {
    const direct = estimateImpact({
      usage: { output_tokens: 100 }, model: "gemini-2.5-pro", provider: "Google",
      settings: settings({ boundary: "direct_s1" }),
    });
    const operational = estimateImpact({
      usage: { output_tokens: 100 }, model: "gemini-2.5-pro", provider: "Google",
      settings: settings({ boundary: "operational_s1_s2" }),
    });
    expect(direct.water_s1_ml.central).toBe(0.26);
    expect(direct.water_s2_ml.central).toBeNull();
    expect(operational.water_s1_ml.central).toBe(0.26);
    expect(operational.water_s2_ml.central).toBeCloseTo(1.0848);
    expect(operational.water_consumption_ml.central).toBeCloseTo(1.3448);
  });

  test("Mistral lifecycle scales only by its disclosed 400-output-token basis", () => {
    const impact = estimateImpact({
      usage: { output_tokens: 800 }, model: "mistral-large-2407", provider: "Mistral",
      settings: settings({ boundary: "lifecycle_s1_s2_s3", lifecycle_enabled: true }),
    });
    expect(impact.water_consumption_ml.central).toBe(90);
    expect(impact.water_s1_ml.central).toBeNull();
    expect(impact.unknown_scopes).toEqual([1, 2, 3]);
  });

  test("disabled Ren profile is available only through explicit proxy selection", () => {
    expect(resolveImpactProfile("gpt-4", "OpenAI", "short_text", settings({ boundary: "operational_s1_s2" }))).toBeNull();
    const impact = estimateImpact({
      usage: { output_tokens: 100 }, model: "claude-sonnet-5", provider: "Anthropic",
      settings: settings({ profile_behavior: "selected_proxy", proxy_profile_id: "ren-reported-gpt4-revision" }),
    });
    expect(impact.method).toBe("user_selected_proxy");
    expect(impact.water_consumption_ml.central).toBe(15);
  });
});

describe("energy-derived estimates", () => {
  test("wall energy uses grid water with no PUE or cooling WUE", () => {
    const impact = estimateImpact({
      usage: {}, model: "local", provider: "Local",
      runtimeEnergy: { boundary: "wall", wh_central: 10, grid_factor_l_per_kwh: 4.35 },
    });
    expect(impact.water_s2_ml.central).toBeCloseTo(43.5);
    expect(impact.water_s1_ml.central).toBeNull();
  });

  test("IT energy applies WUE and PUE once", () => {
    const impact = estimateImpact({
      usage: {}, model: "server", provider: "Local",
      runtimeEnergy: {
        boundary: "it", wh_central: 10, onsite_wue_l_per_it_kwh: 0.3,
        pue: 1.2, grid_factor_l_per_kwh: 4,
      },
    });
    expect(impact.water_s1_ml.central).toBeCloseTo(3);
    expect(impact.water_s2_ml.central).toBeCloseTo(48);
  });

  test("facility energy does not apply PUE twice", () => {
    const impact = estimateImpact({
      usage: {}, model: "facility", provider: "Local",
      runtimeEnergy: { boundary: "facility", wh_central: 10, pue: 9, grid_factor_l_per_kwh: 4 },
    });
    expect(impact.water_s2_ml.central).toBeCloseTo(40);
  });

  test("GPU-only energy remains an incomplete lower bound", () => {
    const impact = estimateImpact({
      usage: {}, model: "qwen3-32b", provider: "Local",
      runtimeEnergy: { boundary: "gpu", wh_central: 10 },
    });
    expect(impact.available).toBe(false);
    expect(impact.lower_bound).toBe(true);
    expect(impact.water_consumption_ml.central).toBeNull();
  });
});

describe("units and budgets", () => {
  test("bottle and gallon conversions use exact US units", () => {
    expect(bottleEquivalent(473.176473)).toBeCloseTo(1, 12);
    expect(usGallons(3785.411784)).toBeCloseTo(1, 12);
  });

  test("budget range reverses uncertainty bounds", () => {
    expect(budgetRemaining(100, { low: 20, central: 30, high: 40 }))
      .toEqual({ low: 60, central: 70, high: 80 });
    expect(budgetRemaining(100, { low: null, central: null, high: null }))
      .toEqual({ low: null, central: null, high: null });
  });
});

describe("profile version behavior", () => {
  test("resolution returns exact selected version without mutating prior profile objects", () => {
    const oldProfile = IMPACT_PROFILES[0];
    const next: ImpactProfile = { ...oldProfile, profile_version: "2.0.0", central_ml: 9, water_s1_ml: 9 };
    const registry = [oldProfile, next];
    const resolved = resolveImpactProfile("gemini-pro", "Google", "short_text", settings(), registry);
    expect(resolved?.profile_version).toBe("2.0.0");
    expect(oldProfile.profile_version).toBe("1.0.0");
    expect(oldProfile.central_ml).toBe(0.26);
  });
});
