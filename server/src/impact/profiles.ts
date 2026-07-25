import type { ImpactProfile, RegionalWaterFactor, WaterScope } from "../../../shared/impact.ts";

const GOOGLE_SOURCE = "https://cloud.google.com/blog/products/infrastructure/measuring-the-environmental-impact-of-ai-inference/";
const LBNL_SOURCE = "https://doi.org/10.71468/P1WC7Q";
const OPENAI_SOURCE = "https://blog.samaltman.com/the-gentle-singularity";
const MISTRAL_SOURCE = "https://mistral.ai/news/our-contribution-to-a-global-environmental-standard-for-ai/";
const ML_ENERGY_SOURCE = "https://ml.energy/blog/measurement/energy/diagnosing-inference-energy-consumption-with-the-mlenergy-leaderboard-v30/";
const MICROSOFT_SOURCE = "https://datacenters.microsoft.com/sustainability/efficiency/";

export const IMPACT_PROFILES: readonly ImpactProfile[] = [
  {
    profile_id: "google-gemini-apps-2025-direct", profile_version: "1.0.0",
    provider: "Google", model_match: ["gemini"], workload_class: "short_text",
    statistic: "median", water_type: "consumption", scopes_included: [1],
    scope_unknown: false, energy_boundary: "facility",
    water_s1_ml: 0.26, water_s2_ml: null, water_s3_ml: null,
    low_ml: null, central_ml: 0.26, high_ml: null,
    energy_wh_low: null, energy_wh_central: 0.24, energy_wh_high: null,
    region: "Google-global-fleet", source_title: "Measuring the environmental impact of AI inference",
    source_url: GOOGLE_SOURCE, source_date: "2025-08-21", source_tier: 1,
    measured: true, basis: "per_request", default_enabled: true,
    notes: "Median Gemini Apps text prompt using May 2025 data. Direct data-center water only. Excludes electricity-generation water and lifecycle impacts. Provider data was not independently verified.",
  },
  {
    profile_id: "google-gemini-apps-2025-us-operational-scenario", profile_version: "1.0.0",
    provider: "Google", model_match: ["gemini"], workload_class: "short_text",
    statistic: "scenario", water_type: "consumption", scopes_included: [1, 2],
    scope_unknown: false, energy_boundary: "facility",
    water_s1_ml: 0.26, water_s2_ml: 1.0848, water_s3_ml: null,
    low_ml: null, central_ml: 1.3448, high_ml: null,
    energy_wh_low: null, energy_wh_central: 0.24, energy_wh_high: null,
    region: "US-average-data-center-grid", source_title: "Google Gemini disclosure + 2024 United States Data Center Energy Usage Report",
    source_url: LBNL_SOURCE, source_date: "2025-08-21", source_tier: 2,
    measured: false, basis: "per_request", default_enabled: true,
    notes: "Scenario. Scope 1 uses Google's fleet disclosure. Scope 2 multiplies disclosed facility energy by 4.52 L/kWh. PUE is not applied because Google's energy already includes facility overhead.",
  },
  {
    profile_id: "openai-average-query-2025-undisclosed-boundary", profile_version: "1.0.0",
    provider: "OpenAI", model_match: ["gpt", "chatgpt", "o1", "o3", "o4"], workload_class: "short_text",
    statistic: "provider_reported", water_type: "consumption", scopes_included: [],
    scope_unknown: true, energy_boundary: "unknown",
    water_s1_ml: null, water_s2_ml: null, water_s3_ml: null,
    low_ml: null, central_ml: 0.32176, high_ml: null,
    energy_wh_low: null, energy_wh_central: 0.34, energy_wh_high: null,
    region: "undisclosed", source_title: "The Gentle Singularity",
    source_url: OPENAI_SOURCE, source_date: "2025-06-10", source_tier: 2,
    measured: false, basis: "per_request", default_enabled: true,
    notes: "Provider-associated average-query statement. Water boundary, model mix, response length, region, PUE, and methodology are undisclosed. Do not classify into a scope or add electricity water.",
  },
  {
    profile_id: "ren-reported-gpt4-revision", profile_version: "1.0.0",
    provider: "OpenAI", model_match: ["gpt-4"], workload_class: "short_text",
    statistic: "modeled", water_type: "consumption", scopes_included: [1, 2],
    scope_unknown: false, energy_boundary: "unknown",
    water_s1_ml: 5, water_s2_ml: 10, water_s3_ml: null,
    low_ml: null, central_ml: 15, high_ml: null,
    energy_wh_low: null, energy_wh_central: null, energy_wh_high: null,
    region: "undisclosed", source_title: "Third-party report of private clarification",
    source_url: "https://aiweekly.co/alerts/uc-riverside-walks-back-ais-viral-water-per-prompt-figure",
    source_date: "2026-07-17", source_tier: 3,
    measured: false, basis: "per_request", default_enabled: false,
    notes: "Reported private clarification described by a third party. Not a formal peer-reviewed revision or published erratum. Disabled by default.",
  },
  {
    profile_id: "mistral-large-2-400-token-lifecycle", profile_version: "1.0.0",
    provider: "Mistral", model_match: ["mistral-large-2", "mistral-large-2407"], workload_class: "short_text",
    statistic: "modeled", water_type: "consumption", scopes_included: [1, 2, 3],
    scope_unknown: false, energy_boundary: "unknown",
    water_s1_ml: null, water_s2_ml: null, water_s3_ml: null,
    low_ml: null, central_ml: 45, high_ml: null,
    energy_wh_low: null, energy_wh_central: null, energy_wh_high: null,
    region: "undisclosed", source_title: "Our contribution to a global environmental standard for AI",
    source_url: MISTRAL_SOURCE, source_date: "2025-07-22", source_tier: 1,
    measured: false, basis: "per_400_output_tokens", default_enabled: true,
    notes: "Lifecycle-assessment marginal inference result for a 400-token Le Chat response. Includes upstream effects and excludes user terminals. Component split is undisclosed; never treat as operational-only.",
  },
  {
    profile_id: "mlenergy-average-text-conversation", profile_version: "3.0.0",
    provider: "Local", model_match: ["local"], workload_class: "short_text",
    statistic: "mean", water_type: "consumption", scopes_included: [],
    scope_unknown: true, energy_boundary: "gpu",
    water_s1_ml: null, water_s2_ml: null, water_s3_ml: null,
    low_ml: null, central_ml: null, high_ml: null,
    energy_wh_low: null, energy_wh_central: 184 / 3600, energy_wh_high: null,
    region: "benchmark-hardware", source_title: "Diagnosing Inference Energy Consumption with the ML.ENERGY Leaderboard v3.0",
    source_url: ML_ENERGY_SOURCE, source_date: "2026-01-29", source_tier: 1,
    measured: true, basis: "energy_per_request", default_enabled: false,
    notes: "Mean GPU-only benchmark energy. Not facility or wall energy. Water remains unavailable without an explicit host/facility model.",
  },
  {
    profile_id: "mlenergy-average-problem-solving", profile_version: "3.0.0",
    provider: "Local", model_match: ["local"], workload_class: "reasoning",
    statistic: "mean", water_type: "consumption", scopes_included: [],
    scope_unknown: true, energy_boundary: "gpu",
    water_s1_ml: null, water_s2_ml: null, water_s3_ml: null,
    low_ml: null, central_ml: null, high_ml: null,
    energy_wh_low: null, energy_wh_central: 4625 / 3600, energy_wh_high: null,
    region: "benchmark-hardware", source_title: "Diagnosing Inference Energy Consumption with the ML.ENERGY Leaderboard v3.0",
    source_url: ML_ENERGY_SOURCE, source_date: "2026-01-29", source_tier: 1,
    measured: true, basis: "energy_per_request", default_enabled: false,
    notes: "Mean problem-solving GPU energy. GPU-only lower bound; not a complete water estimate.",
  },
  {
    profile_id: "mlenergy-qwen3-32b-text", profile_version: "3.0.0",
    provider: "Local", model_match: ["qwen3-32b", "qwen-3-32b"], workload_class: "short_text",
    statistic: "mean", water_type: "consumption", scopes_included: [],
    scope_unknown: true, energy_boundary: "gpu",
    water_s1_ml: null, water_s2_ml: null, water_s3_ml: null,
    low_ml: null, central_ml: null, high_ml: null,
    energy_wh_low: null, energy_wh_central: 95 / 3600, energy_wh_high: null,
    region: "1x-B200-benchmark", source_title: "Diagnosing Inference Energy Consumption with the ML.ENERGY Leaderboard v3.0",
    source_url: ML_ENERGY_SOURCE, source_date: "2026-01-29", source_tier: 1,
    measured: true, basis: "energy_per_request", default_enabled: true,
    notes: "Qwen 3 32B text-conversation GPU energy on one B200. GPU-only lower bound.",
  },
  {
    profile_id: "mlenergy-qwen3-32b-reasoning", profile_version: "3.0.0",
    provider: "Local", model_match: ["qwen3-32b", "qwen-3-32b"], workload_class: "reasoning",
    statistic: "mean", water_type: "consumption", scopes_included: [],
    scope_unknown: true, energy_boundary: "gpu",
    water_s1_ml: null, water_s2_ml: null, water_s3_ml: null,
    low_ml: null, central_ml: null, high_ml: null,
    energy_wh_low: null, energy_wh_central: 2192 / 3600, energy_wh_high: null,
    region: "1x-B200-benchmark", source_title: "Diagnosing Inference Energy Consumption with the ML.ENERGY Leaderboard v3.0",
    source_url: ML_ENERGY_SOURCE, source_date: "2026-01-29", source_tier: 1,
    measured: true, basis: "energy_per_request", default_enabled: true,
    notes: "Qwen 3 32B problem-solving GPU energy on one B200. GPU-only lower bound.",
  },
];

export const REGIONAL_WATER_FACTORS: readonly RegionalWaterFactor[] = [
  {
    factor_id: "lbnl-us-data-center-grid-2023", version: "1.0.0",
    label: "LBNL US data-center electricity mix", region: "US-data-center-average",
    water_type: "consumption", liters_per_kwh: 4.52,
    source_title: "2024 United States Data Center Energy Usage Report",
    source_url: LBNL_SOURCE, source_date: "2024-12-01",
    notes: "National average indirect consumption for the 2023 electricity mix at US data-center locations. Scenario factor, not a local measurement.",
  },
  {
    factor_id: "lbnl-us-grid-2023", version: "1.0.0",
    label: "LBNL overall US electricity", region: "US-average-grid",
    water_type: "consumption", liters_per_kwh: 4.35,
    source_title: "2024 United States Data Center Energy Usage Report",
    source_url: LBNL_SOURCE, source_date: "2024-12-01",
    notes: "National average water-consumption intensity for US electricity in 2023. Not a local measurement.",
  },
];

export const MICROSOFT_REFERENCE = {
  source_title: "Measuring energy and water efficiency for Microsoft datacenters",
  source_url: MICROSOFT_SOURCE,
  source_date: "2026-07-01",
  fy24: { wue_l_per_kwh: 0.30, pue: 1.16 },
  fy25: { wue_l_per_kwh: 0.27, pue: 1.17 },
  notes: "Reference only. Never applied to unrelated providers automatically.",
} as const;

function finiteOrNull(n: number | null): boolean {
  return n === null || (Number.isFinite(n) && n >= 0);
}

export function validateImpactProfile(profile: ImpactProfile): string[] {
  const errors: string[] = [];
  if (!profile.profile_id || !profile.profile_version) errors.push("profile id/version required");
  if (!profile.provider || !profile.model_match.length) errors.push("provider/model match required");
  if (!profile.source_title || !profile.source_url || !profile.source_date) errors.push("source metadata required");
  if (!profile.region) errors.push("region required");
  if (profile.scope_unknown === (profile.scopes_included.length > 0)) {
    errors.push("profile must declare known scopes or explicitly unknown scope");
  }
  const scopes = new Set<WaterScope>(profile.scopes_included);
  if (scopes.size !== profile.scopes_included.length) errors.push("duplicate scope");
  for (const value of [
    profile.water_s1_ml, profile.water_s2_ml, profile.water_s3_ml,
    profile.low_ml, profile.central_ml, profile.high_ml,
    profile.energy_wh_low, profile.energy_wh_central, profile.energy_wh_high,
  ]) if (!finiteOrNull(value)) errors.push("impact values must be non-negative finite numbers or null");
  if (profile.measured && !["measured", "median", "mean"].includes(profile.statistic)) {
    errors.push("measured flag conflicts with statistic");
  }
  return errors;
}

for (const profile of IMPACT_PROFILES) {
  const errors = validateImpactProfile(profile);
  if (errors.length) throw new Error(`invalid impact profile ${profile.profile_id}: ${errors.join("; ")}`);
}
