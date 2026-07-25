import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type {
  ImpactBreakdownRow, ImpactEstimate, ImpactProfile, ImpactRange, ImpactSettings,
  ImpactSummary, ImpactTotal, RegionalWaterFactor, WaterBudgetState, WorkloadClass,
} from "../../../shared/impact.ts";
import type { NormalizedEvent } from "../ingest.ts";
import { usageFrom } from "../ingest.ts";
import type { TokenUsage } from "../pricing.ts";
import { budgetRemaining, DEFAULT_IMPACT_SETTINGS, estimateImpact, type RuntimeEnergy } from "./engine.ts";
import { ACTIVE_IMPACT_PROFILES, REGIONAL_WATER_FACTORS } from "./profiles.ts";

export function migrateImpact(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS impact_profiles (
      profile_id TEXT NOT NULL,
      profile_version TEXT NOT NULL,
      provider TEXT NOT NULL,
      model_match TEXT NOT NULL,
      workload_class TEXT NOT NULL,
      statistic TEXT NOT NULL,
      water_type TEXT NOT NULL,
      scopes_included TEXT NOT NULL,
      scope_unknown INTEGER NOT NULL,
      energy_boundary TEXT NOT NULL,
      water_s1_ml REAL,
      water_s2_ml REAL,
      water_s3_ml REAL,
      low_ml REAL,
      central_ml REAL,
      high_ml REAL,
      energy_wh_low REAL,
      energy_wh_central REAL,
      energy_wh_high REAL,
      region TEXT NOT NULL,
      source_title TEXT NOT NULL,
      source_url TEXT NOT NULL,
      source_date TEXT NOT NULL,
      source_tier INTEGER NOT NULL,
      measured INTEGER NOT NULL,
      basis TEXT NOT NULL,
      default_enabled INTEGER NOT NULL,
      notes TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (profile_id, profile_version)
    );

    CREATE TABLE IF NOT EXISTS impact_regional_factors (
      factor_id TEXT NOT NULL,
      version TEXT NOT NULL,
      label TEXT NOT NULL,
      region TEXT NOT NULL,
      water_type TEXT NOT NULL,
      liters_per_kwh REAL NOT NULL,
      source_title TEXT NOT NULL,
      source_url TEXT NOT NULL,
      source_date TEXT NOT NULL,
      notes TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (factor_id, version)
    );

    CREATE TABLE IF NOT EXISTS impact_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      display_mode TEXT NOT NULL,
      water_unit TEXT NOT NULL,
      boundary TEXT NOT NULL,
      estimate_display TEXT NOT NULL,
      profile_behavior TEXT NOT NULL,
      unavailable_behavior TEXT NOT NULL,
      proxy_profile_id TEXT,
      regional_factor_id TEXT NOT NULL,
      lifecycle_enabled INTEGER NOT NULL DEFAULT 0,
      daily_budget_ml REAL,
      weekly_budget_ml REAL,
      monthly_budget_ml REAL,
      window_budget_ml REAL,
      custom_budget_ml REAL,
      custom_period_ms INTEGER,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS event_impacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      timestamp INTEGER NOT NULL,
      source_app TEXT NOT NULL,
      session_id TEXT NOT NULL,
      agent_id TEXT,
      agent_type TEXT,
      parent_agent_id TEXT,
      model_name TEXT,
      provider TEXT,
      request_group_id TEXT,
      turn_id TEXT,
      profile_id TEXT,
      profile_version TEXT,
      regional_factor_id TEXT,
      method TEXT NOT NULL,
      workload_class TEXT NOT NULL,
      statistic TEXT,
      energy_boundary TEXT NOT NULL,
      region TEXT,
      confidence TEXT NOT NULL,
      lower_bound INTEGER NOT NULL DEFAULT 0,
      energy_wh_low REAL,
      energy_wh_central REAL,
      energy_wh_high REAL,
      water_s1_ml_low REAL,
      water_s1_ml_central REAL,
      water_s1_ml_high REAL,
      water_s2_ml_low REAL,
      water_s2_ml_central REAL,
      water_s2_ml_high REAL,
      water_s3_ml_low REAL,
      water_s3_ml_central REAL,
      water_s3_ml_high REAL,
      water_consumption_ml_low REAL,
      water_consumption_ml_central REAL,
      water_consumption_ml_high REAL,
      water_withdrawal_ml_low REAL,
      water_withdrawal_ml_central REAL,
      water_withdrawal_ml_high REAL,
      unknown_scopes TEXT NOT NULL DEFAULT '[]',
      notes TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      FOREIGN KEY (profile_id, profile_version)
        REFERENCES impact_profiles(profile_id, profile_version)
    );

    CREATE TABLE IF NOT EXISTS impact_transcript_messages (
      session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
      message_key TEXT NOT NULL,
      first_event_id INTEGER NOT NULL,
      profile_id TEXT,
      profile_version TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, message_key)
    );

    CREATE INDEX IF NOT EXISTS idx_event_impacts_event ON event_impacts(event_id);
    CREATE INDEX IF NOT EXISTS idx_event_impacts_ts ON event_impacts(timestamp);
    CREATE INDEX IF NOT EXISTS idx_event_impacts_session_ts ON event_impacts(session_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_event_impacts_provider_ts ON event_impacts(provider, timestamp);
    CREATE INDEX IF NOT EXISTS idx_event_impacts_model_ts ON event_impacts(model_name, timestamp);
    CREATE INDEX IF NOT EXISTS idx_event_impacts_agent_ts ON event_impacts(agent_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_event_impacts_request_ts ON event_impacts(request_group_id, timestamp);
  `);
  try { db.exec("ALTER TABLE impact_settings ADD COLUMN custom_budget_ml REAL"); } catch { /* already present */ }
  try { db.exec("ALTER TABLE impact_settings ADD COLUMN custom_period_ms INTEGER"); } catch { /* already present */ }
  seedProfiles(db, ACTIVE_IMPACT_PROFILES);
  seedFactors(db, REGIONAL_WATER_FACTORS);
  const s = DEFAULT_IMPACT_SETTINGS;
  db.query(`
    INSERT OR IGNORE INTO impact_settings (
      id, display_mode, water_unit, boundary, estimate_display, profile_behavior,
      unavailable_behavior, proxy_profile_id, regional_factor_id, lifecycle_enabled,
      daily_budget_ml, weekly_budget_ml, monthly_budget_ml, window_budget_ml,
      custom_budget_ml, custom_period_ms, updated_at
    ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    s.display_mode, s.water_unit, s.boundary, s.estimate_display, s.profile_behavior,
    s.unavailable_behavior, s.proxy_profile_id, s.regional_factor_id,
    Number(s.lifecycle_enabled), s.daily_budget_ml, s.weekly_budget_ml,
    s.monthly_budget_ml, s.window_budget_ml, s.custom_budget_ml,
    s.custom_period_ms, Date.now(),
  );
}

function seedProfiles(db: Database, profiles: readonly ImpactProfile[]): void {
  const stmt = db.query(`
    INSERT OR IGNORE INTO impact_profiles (
      profile_id, profile_version, provider, model_match, workload_class, statistic,
      water_type, scopes_included, scope_unknown, energy_boundary,
      water_s1_ml, water_s2_ml, water_s3_ml, low_ml, central_ml, high_ml,
      energy_wh_low, energy_wh_central, energy_wh_high, region,
      source_title, source_url, source_date, source_tier, measured, basis,
      default_enabled, notes, created_at
    ) VALUES (
      $profile_id, $profile_version, $provider, $model_match, $workload_class, $statistic,
      $water_type, $scopes_included, $scope_unknown, $energy_boundary,
      $water_s1_ml, $water_s2_ml, $water_s3_ml, $low_ml, $central_ml, $high_ml,
      $energy_wh_low, $energy_wh_central, $energy_wh_high, $region,
      $source_title, $source_url, $source_date, $source_tier, $measured, $basis,
      $default_enabled, $notes, $created_at
    )
  `);
  const insert = db.transaction((rows: readonly ImpactProfile[]) => {
    for (const p of rows) stmt.run({
      ...Object.fromEntries(Object.entries(p).map(([k, v]) => [`$${k}`, v])),
      $model_match: JSON.stringify(p.model_match),
      $scopes_included: JSON.stringify(p.scopes_included),
      $scope_unknown: Number(p.scope_unknown),
      $measured: Number(p.measured),
      $default_enabled: Number(p.default_enabled),
      $created_at: Date.now(),
    } as any);
  });
  insert(profiles);
}

function seedFactors(db: Database, factors: readonly RegionalWaterFactor[]): void {
  const stmt = db.query(`
    INSERT OR IGNORE INTO impact_regional_factors (
      factor_id, version, label, region, water_type, liters_per_kwh,
      source_title, source_url, source_date, notes, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insert = db.transaction((rows: readonly RegionalWaterFactor[]) => {
    for (const f of rows) stmt.run(
      f.factor_id, f.version, f.label, f.region, f.water_type, f.liters_per_kwh,
      f.source_title, f.source_url, f.source_date, f.notes, Date.now(),
    );
  });
  insert(factors);
}

function nullableBudget(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

export function getImpactSettings(db: Database): ImpactSettings {
  const row = db.query<any, []>("SELECT * FROM impact_settings WHERE id = 1").get();
  if (!row) return { ...DEFAULT_IMPACT_SETTINGS };
  return {
    display_mode: row.display_mode,
    water_unit: row.water_unit,
    boundary: row.boundary,
    estimate_display: row.estimate_display,
    profile_behavior: row.profile_behavior,
    unavailable_behavior: row.unavailable_behavior,
    proxy_profile_id: row.proxy_profile_id,
    regional_factor_id: row.regional_factor_id,
    lifecycle_enabled: !!row.lifecycle_enabled,
    daily_budget_ml: nullableBudget(row.daily_budget_ml),
    weekly_budget_ml: nullableBudget(row.weekly_budget_ml),
    monthly_budget_ml: nullableBudget(row.monthly_budget_ml),
    window_budget_ml: nullableBudget(row.window_budget_ml),
    custom_budget_ml: nullableBudget(row.custom_budget_ml),
    custom_period_ms: nullableBudget(row.custom_period_ms),
  };
}

const SETTING_VALUES = {
  display_mode: new Set(["cost", "tokens", "water", "cost_water", "tokens_water", "all"]),
  water_unit: new Set(["auto", "ml", "l", "us_gallon", "bottle_16oz"]),
  boundary: new Set(["direct_s1", "operational_s1_s2", "lifecycle_s1_s2_s3", "source_native"]),
  estimate_display: new Set(["central", "range", "central_range", "components"]),
  profile_behavior: new Set(["strict", "selected_proxy"]),
  unavailable_behavior: new Set(["hide", "show"]),
} as const;

export function updateImpactSettings(db: Database, patch: Partial<ImpactSettings>): ImpactSettings {
  const current = getImpactSettings(db);
  const next = { ...current };
  for (const key of Object.keys(SETTING_VALUES) as Array<keyof typeof SETTING_VALUES>) {
    const v = patch[key];
    if (v !== undefined) {
      if (!SETTING_VALUES[key].has(v as never)) throw new Error(`invalid ${key}`);
      (next as any)[key] = v;
    }
  }
  if (patch.proxy_profile_id !== undefined) {
    if (patch.proxy_profile_id !== null) {
      const exists = db.query<{ one: number }, [string]>(
        "SELECT 1 AS one FROM impact_profiles WHERE profile_id = ? LIMIT 1",
      ).get(patch.proxy_profile_id);
      if (!exists) throw new Error("unknown proxy profile");
    }
    next.proxy_profile_id = patch.proxy_profile_id;
  }
  if (patch.regional_factor_id !== undefined) {
    const exists = db.query<{ one: number }, [string]>(
      "SELECT 1 AS one FROM impact_regional_factors WHERE factor_id = ? LIMIT 1",
    ).get(patch.regional_factor_id);
    if (!exists) throw new Error("unknown regional factor");
    next.regional_factor_id = patch.regional_factor_id;
  }
  if (patch.lifecycle_enabled !== undefined) next.lifecycle_enabled = !!patch.lifecycle_enabled;
  for (const key of [
    "daily_budget_ml", "weekly_budget_ml", "monthly_budget_ml", "window_budget_ml",
    "custom_budget_ml", "custom_period_ms",
  ] as const) {
    if (patch[key] !== undefined) {
      const v = patch[key];
      if (v !== null && (typeof v !== "number" || !Number.isFinite(v) || v < 0)) throw new Error(`invalid ${key}`);
      next[key] = v;
    }
  }
  db.query(`
    UPDATE impact_settings SET
      display_mode = ?, water_unit = ?, boundary = ?, estimate_display = ?,
      profile_behavior = ?, unavailable_behavior = ?, proxy_profile_id = ?,
      regional_factor_id = ?, lifecycle_enabled = ?, daily_budget_ml = ?,
      weekly_budget_ml = ?, monthly_budget_ml = ?, window_budget_ml = ?,
      custom_budget_ml = ?, custom_period_ms = ?, updated_at = ?
    WHERE id = 1
  `).run(
    next.display_mode, next.water_unit, next.boundary, next.estimate_display,
    next.profile_behavior, next.unavailable_behavior, next.proxy_profile_id,
    next.regional_factor_id, Number(next.lifecycle_enabled), next.daily_budget_ml,
    next.weekly_budget_ml, next.monthly_budget_ml, next.window_budget_ml,
    next.custom_budget_ml, next.custom_period_ms, Date.now(),
  );
  return next;
}

export function listImpactProfiles(db: Database): ImpactProfile[] {
  return db.query<any, []>("SELECT * FROM impact_profiles ORDER BY profile_id, profile_version").all().map((row) => ({
    profile_id: row.profile_id, profile_version: row.profile_version, provider: row.provider,
    model_match: JSON.parse(row.model_match), workload_class: row.workload_class,
    statistic: row.statistic, water_type: row.water_type,
    scopes_included: JSON.parse(row.scopes_included), scope_unknown: !!row.scope_unknown,
    energy_boundary: row.energy_boundary, water_s1_ml: row.water_s1_ml,
    water_s2_ml: row.water_s2_ml, water_s3_ml: row.water_s3_ml,
    low_ml: row.low_ml, central_ml: row.central_ml, high_ml: row.high_ml,
    energy_wh_low: row.energy_wh_low, energy_wh_central: row.energy_wh_central,
    energy_wh_high: row.energy_wh_high, region: row.region,
    source_title: row.source_title, source_url: row.source_url, source_date: row.source_date,
    source_tier: row.source_tier, measured: !!row.measured, basis: row.basis,
    default_enabled: !!row.default_enabled, notes: row.notes,
  }));
}

export function listRegionalFactors(db: Database): RegionalWaterFactor[] {
  return db.query<any, []>("SELECT * FROM impact_regional_factors ORDER BY factor_id, version").all().map((row) => ({
    factor_id: row.factor_id, version: row.version, label: row.label, region: row.region,
    water_type: row.water_type, liters_per_kwh: row.liters_per_kwh,
    source_title: row.source_title, source_url: row.source_url,
    source_date: row.source_date, notes: row.notes,
  }));
}

export interface ImpactQueryFilters {
  provider?: string | null;
  model?: string | null;
  agent?: string | null;
  waterType?: "consumption" | "withdrawal";
}

interface AggregateRow {
  key: string | null;
  label: string | null;
  provider: string | null;
  model_name: string | null;
  session_id: string | null;
  agent_id: string | null;
  request_group_id: string | null;
  profile_id: string | null;
  profile_version: string | null;
  regional_factor_id: string | null;
  scopes_included: string | null;
  scope_unknown: number | null;
  water_type: string | null;
  statistic: string | null;
  method: ImpactEstimate["method"];
  confidence: ImpactEstimate["confidence"];
  rows: number;
  unknown_rows: number;
  energy_low: number | null;
  energy_central: number | null;
  energy_high: number | null;
  energy_low_n: number;
  energy_central_n: number;
  energy_high_n: number;
  s1_low: number | null; s1_central: number | null; s1_high: number | null;
  s1_low_n: number; s1_central_n: number; s1_high_n: number;
  s2_low: number | null; s2_central: number | null; s2_high: number | null;
  s2_low_n: number; s2_central_n: number; s2_high_n: number;
  s3_low: number | null; s3_central: number | null; s3_high: number | null;
  s3_low_n: number; s3_central_n: number; s3_high_n: number;
  consumption_low: number | null; consumption_central: number | null; consumption_high: number | null;
  consumption_low_n: number; consumption_central_n: number; consumption_high_n: number;
  withdrawal_low: number | null; withdrawal_central: number | null; withdrawal_high: number | null;
  withdrawal_low_n: number; withdrawal_central_n: number; withdrawal_high_n: number;
}

const SUM_COLUMNS = `
  COUNT(*) AS rows,
  SUM(CASE WHEN i.method = 'unknown' THEN 1 ELSE 0 END) AS unknown_rows,
  SUM(i.energy_wh_low) AS energy_low, SUM(i.energy_wh_central) AS energy_central, SUM(i.energy_wh_high) AS energy_high,
  COUNT(i.energy_wh_low) AS energy_low_n, COUNT(i.energy_wh_central) AS energy_central_n, COUNT(i.energy_wh_high) AS energy_high_n,
  SUM(i.water_s1_ml_low) AS s1_low, SUM(i.water_s1_ml_central) AS s1_central, SUM(i.water_s1_ml_high) AS s1_high,
  COUNT(i.water_s1_ml_low) AS s1_low_n, COUNT(i.water_s1_ml_central) AS s1_central_n, COUNT(i.water_s1_ml_high) AS s1_high_n,
  SUM(i.water_s2_ml_low) AS s2_low, SUM(i.water_s2_ml_central) AS s2_central, SUM(i.water_s2_ml_high) AS s2_high,
  COUNT(i.water_s2_ml_low) AS s2_low_n, COUNT(i.water_s2_ml_central) AS s2_central_n, COUNT(i.water_s2_ml_high) AS s2_high_n,
  SUM(i.water_s3_ml_low) AS s3_low, SUM(i.water_s3_ml_central) AS s3_central, SUM(i.water_s3_ml_high) AS s3_high,
  COUNT(i.water_s3_ml_low) AS s3_low_n, COUNT(i.water_s3_ml_central) AS s3_central_n, COUNT(i.water_s3_ml_high) AS s3_high_n,
  SUM(i.water_consumption_ml_low) AS consumption_low,
  SUM(i.water_consumption_ml_central) AS consumption_central,
  SUM(i.water_consumption_ml_high) AS consumption_high,
  COUNT(i.water_consumption_ml_low) AS consumption_low_n,
  COUNT(i.water_consumption_ml_central) AS consumption_central_n,
  COUNT(i.water_consumption_ml_high) AS consumption_high_n,
  SUM(i.water_withdrawal_ml_low) AS withdrawal_low,
  SUM(i.water_withdrawal_ml_central) AS withdrawal_central,
  SUM(i.water_withdrawal_ml_high) AS withdrawal_high,
  COUNT(i.water_withdrawal_ml_low) AS withdrawal_low_n,
  COUNT(i.water_withdrawal_ml_central) AS withdrawal_central_n,
  COUNT(i.water_withdrawal_ml_high) AS withdrawal_high_n
`;

function rangeFrom(row: AggregateRow, prefix: string, denominator: number): ImpactRange {
  const field = (suffix: string) => (row as any)[`${prefix}_${suffix}`] as number | null;
  const count = (suffix: string) => Number((row as any)[`${prefix}_${suffix}_n`] ?? 0);
  return {
    low: denominator > 0 && count("low") === denominator ? field("low") : null,
    central: denominator > 0 && count("central") === denominator ? field("central") : null,
    high: denominator > 0 && count("high") === denominator ? field("high") : null,
  };
}

function addRange(a: ImpactRange, b: ImpactRange): ImpactRange {
  const add = (x: number | null, y: number | null) => x === null || y === null ? null : x + y;
  return { low: add(a.low, b.low), central: add(a.central, b.central), high: add(a.high, b.high) };
}

function emptyTotal(): ImpactTotal {
  const empty = (): ImpactRange => ({ low: null, central: null, high: null });
  return {
    energy_wh: empty(), water_consumption_ml: empty(), water_withdrawal_ml: empty(),
    water_s1_ml: empty(), water_s2_ml: empty(), water_s3_ml: empty(),
    known_rows: 0, unknown_rows: 0, incomplete: false,
    boundary_label: "water unavailable", source_refs: [],
  };
}

function parseScopes(row: AggregateRow): number[] {
  try { return row.scopes_included ? JSON.parse(row.scopes_included) : []; } catch { return []; }
}

function rowTotal(row: AggregateRow, settings: ImpactSettings): ImpactTotal {
  const total = emptyTotal();
  const rows = Number(row.rows ?? 0);
  const scopes = parseScopes(row);
  total.source_refs = [{
    profile_id: row.profile_id,
    profile_version: row.profile_version,
    regional_factor_id: row.regional_factor_id,
    method: row.method,
    confidence: row.confidence,
    statistic: row.statistic as ImpactEstimate["statistic"],
  }];
  total.energy_wh = rangeFrom(row, "energy", Number(row.energy_central_n ?? 0));
  total.water_s1_ml = rangeFrom(row, "s1", Number(row.s1_central_n ?? 0));
  total.water_s2_ml = rangeFrom(row, "s2", Number(row.s2_central_n ?? 0));
  total.water_s3_ml = rangeFrom(row, "s3", Number(row.s3_central_n ?? 0));
  let eligible = false;
  if (settings.boundary === "source_native") eligible = true;
  else if (settings.boundary === "direct_s1") eligible = scopes.length === 1 && scopes[0] === 1;
  else if (settings.boundary === "operational_s1_s2") eligible = scopes.includes(1) && scopes.includes(2) && !scopes.includes(3);
  else eligible = scopes.includes(1) && scopes.includes(2) && scopes.includes(3);

  if (eligible) {
    if (settings.boundary === "direct_s1") {
      total.water_consumption_ml = total.water_s1_ml;
    } else if (settings.boundary === "operational_s1_s2") {
      total.water_consumption_ml = addRange(total.water_s1_ml, total.water_s2_ml);
    } else {
      total.water_consumption_ml = rangeFrom(row, "consumption", Number(row.consumption_central_n ?? 0));
      total.water_withdrawal_ml = rangeFrom(row, "withdrawal", Number(row.withdrawal_central_n ?? 0));
    }
  }
  const selected = row.water_type === "withdrawal" ? total.water_withdrawal_ml : total.water_consumption_ml;
  total.known_rows = selected.central === null ? 0 : Number(
    row.water_type === "withdrawal" ? row.withdrawal_central_n : row.consumption_central_n,
  );
  total.unknown_rows = Math.max(Number(row.unknown_rows ?? 0), rows - total.known_rows);
  total.incomplete = total.unknown_rows > 0;
  total.boundary_label = settings.boundary === "direct_s1"
    ? "S1"
    : settings.boundary === "operational_s1_s2"
      ? "S1+S2"
      : settings.boundary === "lifecycle_s1_s2_s3"
        ? "S1+S2+S3"
        : row.scope_unknown
          ? "scope unknown"
          : scopes.length ? scopes.map((scope) => `S${scope}`).join("+") : "water unavailable";
  return total;
}

function combineTotals(a: ImpactTotal, b: ImpactTotal): ImpactTotal {
  const combine = (x: ImpactRange, y: ImpactRange): ImpactRange => {
    const sum = (p: number | null, q: number | null): number | null => {
      if (p === null) return q;
      if (q === null) return p;
      return p + q;
    };
    return { low: sum(x.low, y.low), central: sum(x.central, y.central), high: sum(x.high, y.high) };
  };
  return {
    energy_wh: combine(a.energy_wh, b.energy_wh),
    water_consumption_ml: combine(a.water_consumption_ml, b.water_consumption_ml),
    water_withdrawal_ml: combine(a.water_withdrawal_ml, b.water_withdrawal_ml),
    water_s1_ml: combine(a.water_s1_ml, b.water_s1_ml),
    water_s2_ml: combine(a.water_s2_ml, b.water_s2_ml),
    water_s3_ml: combine(a.water_s3_ml, b.water_s3_ml),
    known_rows: a.known_rows + b.known_rows,
    unknown_rows: a.unknown_rows + b.unknown_rows,
    incomplete: a.incomplete || b.incomplete,
    boundary_label:
      a.boundary_label === "water unavailable" ? b.boundary_label
      : b.boundary_label === "water unavailable" ? a.boundary_label
      : a.boundary_label === b.boundary_label ? a.boundary_label : "mixed boundaries",
    source_refs: [...new Map(
      [...a.source_refs, ...b.source_refs].map((ref) => [
        `${ref.profile_id}@${ref.profile_version}|${ref.regional_factor_id}|${ref.method}|${ref.confidence}|${ref.statistic}`, ref,
      ]),
    ).values()],
  };
}

function boundarySignature(row: AggregateRow): string {
  const scope = row.scope_unknown ? "unknown" : parseScopes(row).join("+");
  return `${row.water_type}:${scope}:${row.statistic ?? "unknown-statistic"}`;
}

function combineRows(rows: AggregateRow[], settings: ImpactSettings): ImpactTotal {
  let total = emptyTotal();
  const compatible = new Set<string>();
  for (const row of rows) {
    const piece = rowTotal(row, settings);
    if (piece.known_rows > 0) compatible.add(boundarySignature(row));
    total = combineTotals(total, piece);
  }
  if (settings.boundary === "source_native" && compatible.size > 1) {
    total.water_consumption_ml = { low: null, central: null, high: null };
    total.water_withdrawal_ml = { low: null, central: null, high: null };
    total.incomplete = true;
    total.boundary_label = "mixed boundaries";
  }
  return total;
}

function filterSql(
  filters: ImpactQueryFilters,
  scope: { clause: string; args: string[] },
): { where: string; args: unknown[] } {
  let where = scope.clause.replace(/\b(project_path|cwd_path)\b/g, "e.$1");
  const args: unknown[] = [...scope.args];
  if (filters.provider) { where += " AND i.provider = ?"; args.push(filters.provider); }
  if (filters.model) { where += " AND i.model_name = ?"; args.push(filters.model); }
  if (filters.agent === "main") where += " AND i.agent_id IS NULL";
  else if (filters.agent) { where += " AND i.agent_id = ?"; args.push(filters.agent); }
  if (filters.waterType === "withdrawal") where += " AND i.water_withdrawal_ml_central IS NOT NULL";
  else if (filters.waterType === "consumption") where += " AND i.water_consumption_ml_central IS NOT NULL";
  return { where, args };
}

function aggregateQuery(
  db: Database,
  since: number,
  filters: ImpactQueryFilters,
  scope: { clause: string; args: string[] },
  keySql: string,
  labelSql: string,
): AggregateRow[] {
  const f = filterSql(filters, scope);
  return db.query<AggregateRow, any[]>(`
    SELECT ${keySql} AS key, ${labelSql} AS label,
      i.provider, i.model_name, i.session_id, i.agent_id, i.request_group_id, i.statistic,
      i.method, i.confidence,
      i.profile_id, i.profile_version, i.regional_factor_id,
      COALESCE(
        p.scopes_included,
        CASE
          WHEN i.water_s1_ml_central IS NOT NULL AND i.water_s2_ml_central IS NOT NULL THEN '[1,2]'
          WHEN i.water_s1_ml_central IS NOT NULL THEN '[1]'
          WHEN i.water_s2_ml_central IS NOT NULL THEN '[2]'
          WHEN i.water_s3_ml_central IS NOT NULL THEN '[3]'
          ELSE '[]'
        END
      ) AS scopes_included,
      COALESCE(p.scope_unknown, CASE WHEN i.method = 'unknown' THEN 1 ELSE 0 END) AS scope_unknown,
      COALESCE(
        p.water_type,
        CASE
          WHEN i.water_consumption_ml_central IS NOT NULL THEN 'consumption'
          WHEN i.water_withdrawal_ml_central IS NOT NULL THEN 'withdrawal'
          ELSE NULL
        END
      ) AS water_type,
      ${SUM_COLUMNS}
    FROM event_impacts i
    JOIN events e ON e.id = i.event_id
    LEFT JOIN impact_profiles p
      ON p.profile_id = i.profile_id AND p.profile_version = i.profile_version
    WHERE i.timestamp >= ?${f.where}
    GROUP BY key, label, i.provider, i.model_name, i.session_id, i.agent_id,
      i.request_group_id, i.statistic, i.method, i.confidence, i.profile_id, i.profile_version,
      i.regional_factor_id, scopes_included, scope_unknown, water_type
  `).all(since, ...f.args);
}

function breakdown(rows: AggregateRow[], settings: ImpactSettings): ImpactBreakdownRow[] {
  const grouped = new Map<string, AggregateRow[]>();
  for (const row of rows) {
    const key = row.key ?? "unknown";
    const list = grouped.get(key) ?? [];
    list.push(row);
    grouped.set(key, list);
  }
  return [...grouped.entries()].map(([key, list]) => ({
    ...combineRows(list, settings),
    key, label: list[0]?.label ?? key,
    provider: list[0]?.provider, model_name: list[0]?.model_name,
    session_id: list[0]?.session_id, agent_id: list[0]?.agent_id,
    request_group_id: list[0]?.request_group_id,
  })).sort((a, b) =>
    (b.water_consumption_ml.central ?? -1) - (a.water_consumption_ml.central ?? -1)
    || b.known_rows - a.known_rows
  );
}

function budgetState(period: WaterBudgetState["period"], budget: number, used: ImpactRange, incomplete: boolean): WaterBudgetState {
  return { period, budget_ml: budget, used, remaining: budgetRemaining(budget, used), incomplete };
}

export function getImpactSummary(
  db: Database,
  windowMs: number,
  filters: ImpactQueryFilters,
  scope: { clause: string; args: string[] },
): ImpactSummary {
  const settings = getImpactSettings(db);
  const since = Date.now() - windowMs;
  const allRows = aggregateQuery(db, since, filters, scope, "'all'", "'all'");
  const totals = combineRows(allRows, settings);
  const by_model = breakdown(aggregateQuery(db, since, filters, scope, "COALESCE(i.model_name, 'unknown')", "COALESCE(i.model_name, 'unknown')"), settings);
  const by_provider = breakdown(aggregateQuery(db, since, filters, scope, "COALESCE(i.provider, 'unknown')", "COALESCE(i.provider, 'Unknown')"), settings);
  const by_session = breakdown(aggregateQuery(db, since, filters, scope, "i.session_id", "i.session_id"), settings);
  const by_agent = breakdown(aggregateQuery(db, since, filters, scope, "COALESCE(i.agent_id, 'main')", "COALESCE(i.agent_type, 'Main agent')"), settings);
  const by_request_group = breakdown(aggregateQuery(db, since, filters, scope, "COALESCE(i.request_group_id, 'unattributed')", "COALESCE(i.request_group_id, 'Unattributed')"), settings);

  const bucketMs = Math.max(1000, Math.floor(windowMs / 60));
  const timelineRows = aggregateQuery(
    db, since, filters, scope,
    `CAST(i.timestamp / ${bucketMs} AS INTEGER) * ${bucketMs}`,
    `CAST(i.timestamp / ${bucketMs} AS INTEGER) * ${bucketMs}`,
  );
  const timeline = breakdown(timelineRows, settings)
    .map((row) => ({ t: Number(row.key), impact: row }))
    .sort((a, b) => a.t - b.t);

  const budgets: WaterBudgetState[] = [];
  const periods: Array<[WaterBudgetState["period"], number | null, number]> = [
    ["daily", settings.daily_budget_ml, 86_400_000],
    ["weekly", settings.weekly_budget_ml, 7 * 86_400_000],
    ["monthly", settings.monthly_budget_ml, 30 * 86_400_000],
    ["window", settings.window_budget_ml, windowMs],
    ["custom", settings.custom_budget_ml, settings.custom_period_ms ?? 0],
  ];
  for (const [period, budget, duration] of periods) {
    if (budget === null || duration <= 0) continue;
    const used = combineRows(aggregateQuery(db, Date.now() - duration, filters, scope, "'all'", "'all'"), settings);
    budgets.push(budgetState(period, budget, used.water_consumption_ml, used.incomplete));
  }
  return {
    totals, by_model, by_provider, by_session, by_agent, by_request_group,
    timeline, profiles: listImpactProfiles(db), factors: listRegionalFactors(db),
    settings, budgets, window_ms: windowMs,
  };
}

const WORKLOADS = new Set<WorkloadClass>([
  "short_text", "long_context", "reasoning", "image", "video", "local_inference", "unknown",
]);

export function classifyWorkload(
  model: string | null,
  usage: TokenUsage,
  explicit?: unknown,
): WorkloadClass {
  if (typeof explicit === "string" && WORKLOADS.has(explicit as WorkloadClass)) return explicit as WorkloadClass;
  const m = (model ?? "").toLowerCase();
  if (/reason|thinking|\bo[134]\b/.test(m)) return "reasoning";
  const context = (usage.input_tokens ?? 0) + (usage.cache_read_tokens ?? 0) + (usage.cache_creation_tokens ?? 0);
  if (context >= 100_000) return "long_context";
  return "short_text";
}

function runtimeEnergy(payload: Record<string, unknown>): RuntimeEnergy | null {
  const raw = payload.runtime_energy;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const boundaries = new Set(["gpu", "server", "it", "facility", "wall", "unknown"]);
  if (!boundaries.has(String(o.boundary)) || typeof o.wh_central !== "number") return null;
  return {
    boundary: o.boundary as RuntimeEnergy["boundary"],
    wh_low: typeof o.wh_low === "number" ? o.wh_low : null,
    wh_central: o.wh_central,
    wh_high: typeof o.wh_high === "number" ? o.wh_high : null,
    region: typeof o.region === "string" ? o.region : null,
    grid_factor_l_per_kwh: typeof o.grid_factor_l_per_kwh === "number" ? o.grid_factor_l_per_kwh : null,
    onsite_wue_l_per_it_kwh: typeof o.onsite_wue_l_per_it_kwh === "number" ? o.onsite_wue_l_per_it_kwh : null,
    pue: typeof o.pue === "number" ? o.pue : null,
    host_overhead_factor: typeof o.host_overhead_factor === "number" ? o.host_overhead_factor : null,
  };
}

const value = (o: Record<string, unknown>, ...keys: string[]): string | null => {
  for (const key of keys) if (typeof o[key] === "string" && o[key]) return o[key] as string;
  return null;
};

function insertEstimate(
  db: Database,
  eventId: number,
  n: NormalizedEvent,
  provider: string | null,
  estimate: ImpactEstimate,
  attribution: Record<string, unknown>,
  settings: ImpactSettings,
): number {
  const result = db.query(`
    INSERT INTO event_impacts (
      event_id, timestamp, source_app, session_id, agent_id, agent_type, parent_agent_id,
      model_name, provider, request_group_id, turn_id, profile_id, profile_version,
      regional_factor_id, method, workload_class, statistic, energy_boundary, region,
      confidence, lower_bound,
      energy_wh_low, energy_wh_central, energy_wh_high,
      water_s1_ml_low, water_s1_ml_central, water_s1_ml_high,
      water_s2_ml_low, water_s2_ml_central, water_s2_ml_high,
      water_s3_ml_low, water_s3_ml_central, water_s3_ml_high,
      water_consumption_ml_low, water_consumption_ml_central, water_consumption_ml_high,
      water_withdrawal_ml_low, water_withdrawal_ml_central, water_withdrawal_ml_high,
      unknown_scopes, notes, created_at
    ) VALUES (
      $event, $ts, $src, $sid, $agent, $agent_type, $parent,
      $model, $provider, $request, $turn, $profile, $version,
      $factor, $method, $workload, $statistic, $energy_boundary, $region,
      $confidence, $lower_bound,
      $energy_low, $energy_central, $energy_high,
      $s1_low, $s1_central, $s1_high,
      $s2_low, $s2_central, $s2_high,
      $s3_low, $s3_central, $s3_high,
      $consumption_low, $consumption_central, $consumption_high,
      $withdrawal_low, $withdrawal_central, $withdrawal_high,
      $unknown_scopes, $notes, $created
    ) RETURNING id
  `).get({
    $event: eventId, $ts: n.timestamp, $src: n.source_app, $sid: n.session_id,
    $agent: value(attribution, "agent_id", "agentId") ?? n.agent_id,
    $agent_type: value(attribution, "agent_type", "agentType", "subagent_type") ?? n.agent_type,
    $parent: value(attribution, "parent_agent_id", "parentAgentId"),
    $model: estimate.model_name, $provider: provider,
    $request: value(attribution, "request_group_id", "requestGroupId"),
    $turn: value(attribution, "turn_id", "turnId", "message_id", "messageId"),
    $profile: estimate.profile_id, $version: estimate.profile_version,
    $factor: estimate.method === "measured_local" ? settings.regional_factor_id : null,
    $method: estimate.method, $workload: estimate.workload_class, $statistic: estimate.statistic,
    $energy_boundary: estimate.energy_boundary, $region: estimate.region,
    $confidence: estimate.confidence, $lower_bound: Number(estimate.lower_bound),
    $energy_low: estimate.energy_wh.low, $energy_central: estimate.energy_wh.central, $energy_high: estimate.energy_wh.high,
    $s1_low: estimate.water_s1_ml.low, $s1_central: estimate.water_s1_ml.central, $s1_high: estimate.water_s1_ml.high,
    $s2_low: estimate.water_s2_ml.low, $s2_central: estimate.water_s2_ml.central, $s2_high: estimate.water_s2_ml.high,
    $s3_low: estimate.water_s3_ml.low, $s3_central: estimate.water_s3_ml.central, $s3_high: estimate.water_s3_ml.high,
    $consumption_low: estimate.water_consumption_ml.low,
    $consumption_central: estimate.water_consumption_ml.central,
    $consumption_high: estimate.water_consumption_ml.high,
    $withdrawal_low: estimate.water_withdrawal_ml.low,
    $withdrawal_central: estimate.water_withdrawal_ml.central,
    $withdrawal_high: estimate.water_withdrawal_ml.high,
    $unknown_scopes: JSON.stringify(estimate.unknown_scopes),
    $notes: estimate.notes, $created: Date.now(),
  } as any) as { id: number };
  return result.id;
}

function messageParts(line: unknown): { message: Record<string, unknown>; usage: TokenUsage; model: string | null } | null {
  if (!line || typeof line !== "object") return null;
  const o = line as Record<string, unknown>;
  const msg = (o.message ?? o) as Record<string, unknown>;
  const raw = (msg.usage ?? o.usage) as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== "object") return null;
  return {
    message: msg,
    usage: usageFrom(raw),
    model: typeof msg.model === "string" ? msg.model : null,
  };
}

function transcriptKeys(chat: unknown[]): Array<{ key: string; parts: NonNullable<ReturnType<typeof messageParts>> }> {
  const seen = new Map<string, number>();
  const out: Array<{ key: string; parts: NonNullable<ReturnType<typeof messageParts>> }> = [];
  for (const line of chat) {
    const parts = messageParts(line);
    if (!parts) continue;
    const msgId = value(parts.message, "id", "message_id", "messageId");
    const base = msgId ?? createHash("sha256").update(JSON.stringify({
      model: parts.model, usage: parts.usage, content: parts.message.content ?? null,
    })).digest("hex");
    const ordinal = (seen.get(base) ?? 0) + 1;
    seen.set(base, ordinal);
    out.push({ key: `${base}:${ordinal}`, parts });
  }
  return out;
}

export function persistEventImpact(
  db: Database,
  eventId: number,
  n: NormalizedEvent,
  usageDelta: TokenUsage,
  providerFor: (model: string | null | undefined) => string | null,
): number {
  const settings = getImpactSettings(db);
  const payload = n.payload ?? {};
  const insertOne = (
    usage: TokenUsage,
    model: string | null,
    attribution: Record<string, unknown>,
  ): number => {
    const provider = providerFor(model);
    const workload = classifyWorkload(model, usage, attribution.workload_class ?? payload.workload_class);
    const estimate = estimateImpact({
      usage, model, provider, workloadClass: workload,
      runtimeEnergy: runtimeEnergy(payload), settings,
    });
    return insertEstimate(db, eventId, n, provider, estimate, attribution, settings);
  };

  if (!n.usage_is_cumulative || !Array.isArray(n.chat)) {
    const hasUsage = Object.values(usageDelta).some((v) => typeof v === "number" && v > 0);
    if (!hasUsage && !runtimeEnergy(payload)) return 0;
    insertOne(usageDelta, n.model_name, payload);
    return 1;
  }

  const exists = db.query<{ one: number }, [string, string]>(
    "SELECT 1 AS one FROM impact_transcript_messages WHERE session_id = ? AND message_key = ?",
  );
  const remember = db.query(`
    INSERT OR IGNORE INTO impact_transcript_messages
      (session_id, message_key, first_event_id, profile_id, profile_version, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  let count = 0;
  for (const { key, parts } of transcriptKeys(n.chat)) {
    if (exists.get(n.session_id, key)) continue;
    const impactId = insertOne(parts.usage, parts.model ?? n.model_name, parts.message);
    const row = db.query<{ profile_id: string | null; profile_version: string | null }, [number]>(
      "SELECT profile_id, profile_version FROM event_impacts WHERE id = ?",
    ).get(impactId);
    remember.run(n.session_id, key, eventId, row?.profile_id ?? null, row?.profile_version ?? null, Date.now());
    count++;
  }
  return count;
}
