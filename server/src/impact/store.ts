import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type {
  ImpactEstimate, ImpactProfile, ImpactSettings, RegionalWaterFactor, WorkloadClass,
} from "../../../shared/impact.ts";
import type { NormalizedEvent } from "../ingest.ts";
import { usageFrom } from "../ingest.ts";
import type { TokenUsage } from "../pricing.ts";
import { DEFAULT_IMPACT_SETTINGS, estimateImpact, type RuntimeEnergy } from "./engine.ts";
import { IMPACT_PROFILES, REGIONAL_WATER_FACTORS } from "./profiles.ts";

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
  seedProfiles(db, IMPACT_PROFILES);
  seedFactors(db, REGIONAL_WATER_FACTORS);
  const s = DEFAULT_IMPACT_SETTINGS;
  db.query(`
    INSERT OR IGNORE INTO impact_settings (
      id, display_mode, water_unit, boundary, estimate_display, profile_behavior,
      unavailable_behavior, proxy_profile_id, regional_factor_id, lifecycle_enabled,
      daily_budget_ml, weekly_budget_ml, monthly_budget_ml, window_budget_ml, updated_at
    ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    s.display_mode, s.water_unit, s.boundary, s.estimate_display, s.profile_behavior,
    s.unavailable_behavior, s.proxy_profile_id, s.regional_factor_id,
    Number(s.lifecycle_enabled), s.daily_budget_ml, s.weekly_budget_ml,
    s.monthly_budget_ml, s.window_budget_ml, Date.now(),
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
