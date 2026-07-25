export type WaterScope = 1 | 2 | 3;
export type WorkloadClass =
  | "short_text"
  | "long_context"
  | "reasoning"
  | "image"
  | "video"
  | "local_inference"
  | "unknown";
export type ImpactStatistic =
  | "measured"
  | "median"
  | "mean"
  | "modeled"
  | "scenario"
  | "provider_reported";
export type EnergyBoundary = "gpu" | "server" | "it" | "facility" | "wall" | "unknown";
export type WaterType = "consumption" | "withdrawal";
export type ImpactMethod =
  | "provider_disclosed"
  | "measured_local"
  | "energy_derived"
  | "benchmark_derived"
  | "user_selected_proxy"
  | "unknown";
export type ImpactBasis = "per_request" | "per_400_output_tokens" | "energy_per_request";
export type ImpactDisplayMode = "cost" | "tokens" | "water" | "cost_water" | "tokens_water" | "all";
export type WaterUnit = "auto" | "ml" | "l" | "us_gallon" | "bottle_16oz";
export type WaterBoundarySetting = "direct_s1" | "operational_s1_s2" | "lifecycle_s1_s2_s3" | "source_native";
export type EstimateDisplay = "central" | "range" | "central_range" | "components";
export type ProfileBehavior = "strict" | "selected_proxy";
export type UnavailableBehavior = "hide" | "show";

export interface ImpactProfile {
  profile_id: string;
  profile_version: string;
  provider: string;
  model_match: string[];
  workload_class: WorkloadClass;
  statistic: ImpactStatistic;
  water_type: WaterType;
  scopes_included: WaterScope[];
  /** True only when source does not disclose a scope boundary. */
  scope_unknown: boolean;
  energy_boundary: EnergyBoundary;
  water_s1_ml: number | null;
  water_s2_ml: number | null;
  water_s3_ml: number | null;
  low_ml: number | null;
  central_ml: number | null;
  high_ml: number | null;
  energy_wh_low: number | null;
  energy_wh_central: number | null;
  energy_wh_high: number | null;
  region: string;
  source_title: string;
  source_url: string;
  source_date: string;
  source_tier: 1 | 2 | 3;
  measured: boolean;
  basis: ImpactBasis;
  default_enabled: boolean;
  notes: string;
}

export interface RegionalWaterFactor {
  factor_id: string;
  version: string;
  label: string;
  region: string;
  water_type: WaterType;
  liters_per_kwh: number;
  source_title: string;
  source_url: string;
  source_date: string;
  notes: string;
}

export interface ImpactRange {
  low: number | null;
  central: number | null;
  high: number | null;
}

export interface ImpactEstimate {
  available: boolean;
  method: ImpactMethod;
  profile_id: string | null;
  profile_version: string | null;
  provider: string | null;
  model_name: string | null;
  workload_class: WorkloadClass;
  statistic: ImpactStatistic | null;
  energy_boundary: EnergyBoundary;
  region: string | null;
  confidence: "high" | "medium" | "low" | "unknown";
  lower_bound: boolean;
  energy_wh: ImpactRange;
  water_s1_ml: ImpactRange;
  water_s2_ml: ImpactRange;
  water_s3_ml: ImpactRange;
  water_consumption_ml: ImpactRange;
  water_withdrawal_ml: ImpactRange;
  unknown_scopes: WaterScope[];
  notes: string;
}

export interface ImpactSettings {
  display_mode: ImpactDisplayMode;
  water_unit: WaterUnit;
  boundary: WaterBoundarySetting;
  estimate_display: EstimateDisplay;
  profile_behavior: ProfileBehavior;
  unavailable_behavior: UnavailableBehavior;
  proxy_profile_id: string | null;
  regional_factor_id: string;
  lifecycle_enabled: boolean;
  daily_budget_ml: number | null;
  weekly_budget_ml: number | null;
  monthly_budget_ml: number | null;
  window_budget_ml: number | null;
  custom_budget_ml: number | null;
  custom_period_ms: number | null;
}

export interface ImpactTotal {
  energy_wh: ImpactRange;
  water_consumption_ml: ImpactRange;
  water_withdrawal_ml: ImpactRange;
  water_s1_ml: ImpactRange;
  water_s2_ml: ImpactRange;
  water_s3_ml: ImpactRange;
  known_rows: number;
  unknown_rows: number;
  incomplete: boolean;
  boundary_label: string;
  source_refs: Array<{
    profile_id: string | null;
    profile_version: string | null;
    regional_factor_id: string | null;
    method: ImpactMethod;
    confidence: ImpactEstimate["confidence"];
    statistic: ImpactStatistic | null;
  }>;
}

export interface ImpactBreakdownRow extends ImpactTotal {
  key: string;
  label: string;
  provider?: string | null;
  model_name?: string | null;
  session_id?: string | null;
  agent_id?: string | null;
  request_group_id?: string | null;
}

export interface WaterBudgetState {
  period: "daily" | "weekly" | "monthly" | "window" | "custom";
  budget_ml: number;
  used: ImpactRange;
  remaining: ImpactRange;
  incomplete: boolean;
}

export interface ImpactSummary {
  totals: ImpactTotal;
  by_model: ImpactBreakdownRow[];
  by_provider: ImpactBreakdownRow[];
  by_session: ImpactBreakdownRow[];
  by_agent: ImpactBreakdownRow[];
  by_request_group: ImpactBreakdownRow[];
  timeline: Array<{ t: number; impact: ImpactTotal }>;
  profiles: ImpactProfile[];
  factors: RegionalWaterFactor[];
  settings: ImpactSettings;
  budgets: WaterBudgetState[];
  window_ms: number;
}
