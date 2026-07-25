import type {
  EnergyBoundary,
  ImpactEstimate,
  ImpactProfile,
  ImpactRange,
  ImpactSettings,
  RegionalWaterFactor,
  WaterBoundarySetting,
  WaterScope,
  WorkloadClass,
} from "../../../shared/impact.ts";
import type { TokenUsage } from "../pricing.ts";
import { ACTIVE_IMPACT_PROFILES, REGIONAL_WATER_FACTORS } from "./profiles.ts";

export const DEFAULT_IMPACT_SETTINGS: ImpactSettings = {
  display_mode: "cost",
  water_unit: "auto",
  boundary: "source_native",
  estimate_display: "central_range",
  profile_behavior: "strict",
  unavailable_behavior: "show",
  proxy_profile_id: null,
  regional_factor_id: "lbnl-us-grid-2023",
  lifecycle_enabled: false,
  daily_budget_ml: null,
  weekly_budget_ml: null,
  monthly_budget_ml: null,
  window_budget_ml: null,
};

export interface RuntimeEnergy {
  boundary: EnergyBoundary;
  wh_low?: number | null;
  wh_central: number;
  wh_high?: number | null;
  region?: string | null;
  grid_factor_l_per_kwh?: number | null;
  onsite_wue_l_per_it_kwh?: number | null;
  pue?: number | null;
  /** Explicit facility/wall energy multiplier for a GPU-only observation. */
  host_overhead_factor?: number | null;
}

export interface EstimateImpactInput {
  usage: TokenUsage;
  model: string | null;
  provider: string | null;
  workloadClass?: WorkloadClass;
  runtimeEnergy?: RuntimeEnergy | null;
  profiles?: readonly ImpactProfile[];
  regionalFactors?: readonly RegionalWaterFactor[];
  settings?: ImpactSettings;
}

const EMPTY_RANGE = (): ImpactRange => ({ low: null, central: null, high: null });
const range = (low: number | null, central: number | null, high: number | null): ImpactRange => ({ low, central, high });
const sane = (n: unknown): number | null => typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
const mul = (n: number | null, by: number): number | null => n === null ? null : n * by;

export function unknownImpact(
  model: string | null,
  provider: string | null,
  workloadClass: WorkloadClass,
  notes = "No compatible source-aware impact profile.",
): ImpactEstimate {
  return {
    available: false, method: "unknown", profile_id: null, profile_version: null,
    provider, model_name: model, workload_class: workloadClass, statistic: null,
    energy_boundary: "unknown", region: null, confidence: "unknown", lower_bound: false,
    energy_wh: EMPTY_RANGE(), water_s1_ml: EMPTY_RANGE(), water_s2_ml: EMPTY_RANGE(),
    water_s3_ml: EMPTY_RANGE(), water_consumption_ml: EMPTY_RANGE(),
    water_withdrawal_ml: EMPTY_RANGE(), unknown_scopes: [], notes,
  };
}

function scopeMatches(profile: ImpactProfile, boundary: WaterBoundarySetting): boolean {
  const scopes = profile.scopes_included;
  if (boundary === "source_native") return true;
  if (profile.scope_unknown) return false;
  if (boundary === "direct_s1") return scopes.length === 1 && scopes[0] === 1;
  if (boundary === "operational_s1_s2") return scopes.includes(1) && scopes.includes(2) && !scopes.includes(3);
  return scopes.includes(1) && scopes.includes(2) && scopes.includes(3);
}

const resolutionCache = new Map<string, ImpactProfile | null>();

export function resolveImpactProfile(
  model: string | null,
  provider: string | null,
  workloadClass: WorkloadClass,
  settings: ImpactSettings,
  profiles: readonly ImpactProfile[] = ACTIVE_IMPACT_PROFILES,
): ImpactProfile | null {
  if (settings.profile_behavior === "selected_proxy" && settings.proxy_profile_id) {
    return profiles.find((p) => p.profile_id === settings.proxy_profile_id) ?? null;
  }
  if (!provider || !model) return null;
  const key = `${provider}|${model.toLowerCase()}|${workloadClass}|${settings.boundary}|${profiles === ACTIVE_IMPACT_PROFILES ? "active" : "custom"}`;
  if (profiles === ACTIVE_IMPACT_PROFILES && resolutionCache.has(key)) return resolutionCache.get(key) ?? null;
  const m = model.toLowerCase();
  const matching = profiles.filter((p) =>
    p.default_enabled
    && p.provider.toLowerCase() === provider.toLowerCase()
    && p.workload_class === workloadClass
    && p.model_match.some((fragment) => m.includes(fragment.toLowerCase()))
    && scopeMatches(p, settings.boundary)
    && (settings.lifecycle_enabled || !p.scopes_included.includes(3))
  );
  const latest = new Map<string, ImpactProfile>();
  for (const candidate of matching) {
    const prior = latest.get(candidate.profile_id);
    if (!prior || candidate.profile_version.localeCompare(prior.profile_version, undefined, { numeric: true }) > 0) {
      latest.set(candidate.profile_id, candidate);
    }
  }
  const candidates = [...latest.values()];
  candidates.sort((a, b) => {
    // Source-native chooses published/non-scenario data. Explicit operational
    // mode chooses the profile carrying both operational scopes.
    const scenarioDelta = Number(a.statistic === "scenario") - Number(b.statistic === "scenario");
    if (settings.boundary === "source_native" && scenarioDelta) return scenarioDelta;
    return b.source_tier - a.source_tier
      || Math.max(...b.model_match.map((x) => x.length)) - Math.max(...a.model_match.map((x) => x.length))
      || b.profile_version.localeCompare(a.profile_version, undefined, { numeric: true });
  });
  const found = candidates[0] ?? null;
  if (profiles === ACTIVE_IMPACT_PROFILES) resolutionCache.set(key, found);
  return found;
}

function profileScale(profile: ImpactProfile, usage: TokenUsage): number | null {
  if (profile.basis !== "per_400_output_tokens") return 1;
  const output = sane(usage.output_tokens);
  return output && output > 0 ? output / 400 : null;
}

function profileMethod(profile: ImpactProfile, proxy: boolean): ImpactEstimate["method"] {
  if (proxy) return "user_selected_proxy";
  if (profile.basis === "energy_per_request") return "benchmark_derived";
  if (profile.statistic === "scenario") return "energy_derived";
  return "provider_disclosed";
}

function estimateFromProfile(
  profile: ImpactProfile,
  usage: TokenUsage,
  model: string | null,
  provider: string | null,
  workloadClass: WorkloadClass,
  proxy: boolean,
): ImpactEstimate {
  const scale = profileScale(profile, usage);
  if (scale === null) return unknownImpact(model, provider, workloadClass, "Profile requires output-token basis unavailable on this event.");
  const total = range(mul(profile.low_ml, scale), mul(profile.central_ml, scale), mul(profile.high_ml, scale));
  const s1 = range(null, mul(profile.water_s1_ml, scale), null);
  const s2 = range(null, mul(profile.water_s2_ml, scale), null);
  const s3 = range(null, mul(profile.water_s3_ml, scale), null);
  const energy = range(
    mul(profile.energy_wh_low, scale),
    mul(profile.energy_wh_central, scale),
    mul(profile.energy_wh_high, scale),
  );
  const waterAvailable = total.central !== null || s1.central !== null || s2.central !== null || s3.central !== null;
  const consumption = profile.water_type === "consumption" ? total : EMPTY_RANGE();
  const withdrawal = profile.water_type === "withdrawal" ? total : EMPTY_RANGE();
  const componentSplitMissing =
    waterAvailable && s1.central === null && s2.central === null && s3.central === null;
  return {
    available: waterAvailable,
    method: profileMethod(profile, proxy),
    profile_id: profile.profile_id, profile_version: profile.profile_version,
    provider, model_name: model, workload_class: workloadClass, statistic: profile.statistic,
    energy_boundary: profile.energy_boundary, region: profile.region,
    confidence: profile.source_tier === 1 && profile.measured ? "high" : profile.source_tier <= 2 ? "medium" : "low",
    lower_bound: profile.energy_boundary === "gpu",
    energy_wh: energy, water_s1_ml: s1, water_s2_ml: s2, water_s3_ml: s3,
    water_consumption_ml: consumption, water_withdrawal_ml: withdrawal,
    unknown_scopes: profile.scope_unknown || componentSplitMissing ? [1, 2, 3] : [],
    notes: profile.notes,
  };
}

function scaleRange(energy: ImpactRange, factor: number): ImpactRange {
  return range(mul(energy.low, factor), mul(energy.central, factor), mul(energy.high, factor));
}

function addRanges(...values: ImpactRange[]): ImpactRange {
  const add = (field: keyof ImpactRange): number | null => {
    const present = values.map((v) => v[field]).filter((v): v is number => v !== null);
    return present.length ? present.reduce((a, b) => a + b, 0) : null;
  };
  return range(add("low"), add("central"), add("high"));
}

function estimateFromRuntimeEnergy(
  runtime: RuntimeEnergy,
  model: string | null,
  provider: string | null,
  workloadClass: WorkloadClass,
  factor: RegionalWaterFactor | undefined,
): ImpactEstimate {
  const central = sane(runtime.wh_central);
  if (central === null) return unknownImpact(model, provider, workloadClass, "Runtime energy was malformed.");
  const energy = range(sane(runtime.wh_low), central, sane(runtime.wh_high));
  const grid = sane(runtime.grid_factor_l_per_kwh) ?? factor?.liters_per_kwh ?? null;
  const wue = sane(runtime.onsite_wue_l_per_it_kwh);
  const pue = sane(runtime.pue);
  const overhead = sane(runtime.host_overhead_factor);
  let s1 = EMPTY_RANGE();
  let s2 = EMPTY_RANGE();
  let lowerBound = false;
  let notes = "";

  // Wh × L/kWh has the same numeric value in mL.
  if (runtime.boundary === "wall") {
    if (grid !== null) s2 = scaleRange(energy, grid);
    notes = "Measured local wall energy. No PUE or data-center cooling WUE applied.";
  } else if (runtime.boundary === "it") {
    if (wue !== null) s1 = scaleRange(energy, wue);
    if (grid !== null && pue !== null) s2 = scaleRange(energy, grid * pue);
    notes = "IT energy. Scope 1 uses onsite WUE; scope 2 uses PUE once plus the selected grid factor.";
  } else if (runtime.boundary === "facility") {
    if (grid !== null) s2 = scaleRange(energy, grid);
    notes = "Facility energy. Scope 2 uses the selected grid factor; PUE is not applied again.";
  } else if (runtime.boundary === "gpu") {
    lowerBound = true;
    if (grid !== null && overhead !== null) s2 = scaleRange(energy, grid * overhead);
    notes = overhead === null
      ? "GPU-only measured energy is a lower bound. Water remains unavailable without explicit host/facility overhead."
      : "GPU energy with explicit host/facility overhead. Boundary remains GPU and confidence remains low.";
  } else {
    notes = "Energy boundary does not support a water conversion.";
  }
  const water = addRanges(s1, s2);
  return {
    available: water.central !== null, method: "measured_local",
    profile_id: null, profile_version: null, provider, model_name: model,
    workload_class: workloadClass, statistic: "measured", energy_boundary: runtime.boundary,
    region: runtime.region ?? factor?.region ?? null,
    confidence: runtime.boundary === "wall" && grid !== null ? "medium" : runtime.boundary === "gpu" ? "low" : "medium",
    lower_bound: lowerBound, energy_wh: energy, water_s1_ml: s1, water_s2_ml: s2,
    water_s3_ml: EMPTY_RANGE(), water_consumption_ml: water,
    water_withdrawal_ml: EMPTY_RANGE(), unknown_scopes: [],
    notes,
  };
}

export function estimateImpact(input: EstimateImpactInput): ImpactEstimate {
  const settings = input.settings ?? DEFAULT_IMPACT_SETTINGS;
  const workload = input.workloadClass ?? "short_text";
  const factors = input.regionalFactors ?? REGIONAL_WATER_FACTORS;
  if (input.runtimeEnergy) {
    const factor = factors.find((f) => f.factor_id === settings.regional_factor_id);
    return estimateFromRuntimeEnergy(input.runtimeEnergy, input.model, input.provider, workload, factor);
  }
  const profile = resolveImpactProfile(input.model, input.provider, workload, settings, input.profiles);
  if (!profile) return unknownImpact(input.model, input.provider, workload);
  return estimateFromProfile(
    profile, input.usage, input.model, input.provider, workload,
    settings.profile_behavior === "selected_proxy",
  );
}

export function bottleEquivalent(waterMl: number): number {
  return Math.max(0, waterMl) / 473.176473;
}

export function usGallons(waterMl: number): number {
  return Math.max(0, waterMl) / 3785.411784;
}

export function budgetRemaining(budgetMl: number, used: ImpactRange): ImpactRange {
  const budget = Math.max(0, budgetMl);
  return {
    central: used.central === null ? null : Math.max(0, budget - used.central),
    low: used.high === null ? null : Math.max(0, budget - used.high),
    high: used.low === null ? null : Math.max(0, budget - used.low),
  };
}

export function scopesLabel(scopes: WaterScope[], unknown: boolean): string {
  if (unknown) return "scope unknown";
  return scopes.length ? scopes.map((s) => `S${s}`).join("+") : "water unavailable";
}
