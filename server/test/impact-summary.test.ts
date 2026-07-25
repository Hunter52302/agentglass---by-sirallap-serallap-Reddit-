import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { NormalizedEvent } from "../src/ingest.ts";
import {
  getImpactSummary, migrateImpact, persistEventImpact, updateImpactSettings,
} from "../src/impact/store.ts";

const open: Database[] = [];
afterEach(() => { while (open.length) open.pop()!.close(); });

function database(): Database {
  const db = new Database(":memory:");
  open.push(db);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE events (
      id INTEGER PRIMARY KEY,
      project_path TEXT,
      cwd_path TEXT,
      payload TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE sessions (session_id TEXT PRIMARY KEY);
  `);
  migrateImpact(db);
  return db;
}

function event(id: number, model: string, payload: Record<string, unknown> = {}): NormalizedEvent {
  return {
    source_app: "app", session_id: `s${id}`, hook_event_type: "Stop",
    tool_name: null, tool_use_id: null, agent_id: null, agent_type: null,
    model_name: model, is_error: 0, error_text: null,
    usage: { input_tokens: 100, output_tokens: 20 }, usage_is_cumulative: false,
    cost_cumulative: null, summary: null, timestamp: Date.now() - 100,
    payload, chat: null,
  };
}

const provider = (model: string | null | undefined): string | null => {
  const m = (model ?? "").toLowerCase();
  if (m.includes("gemini")) return "Google";
  if (m.includes("gpt")) return "OpenAI";
  return null;
};

function insert(db: Database, id: number, model: string, payload: Record<string, unknown> = {}): void {
  db.query("INSERT INTO events (id, payload) VALUES (?, '{}')").run(id);
  db.query("INSERT INTO sessions (session_id) VALUES (?)").run(`s${id}`);
  const n = event(id, model, payload);
  persistEventImpact(db, id, n, n.usage, provider);
}

const noScope = { clause: "", args: [] };

describe("impact aggregation", () => {
  test("protects source-native totals from incompatible boundaries", () => {
    const db = database();
    insert(db, 1, "gemini-2.5-pro");
    insert(db, 2, "gpt-4o");
    const summary = getImpactSummary(db, 3_600_000, {}, noScope);
    expect(summary.totals.water_consumption_ml.central).toBeNull();
    expect(summary.totals.incomplete).toBe(true);
    expect(summary.by_model.find((r) => r.key === "gemini-2.5-pro")?.water_consumption_ml.central).toBeCloseTo(0.26);
    expect(summary.by_model.find((r) => r.key === "gpt-4o")?.water_consumption_ml.central).toBeCloseTo(0.32176);
  });

  test("direct boundary includes only compatible S1 estimates", () => {
    const db = database();
    insert(db, 1, "gemini-2.5-pro");
    insert(db, 2, "gpt-4o");
    updateImpactSettings(db, { boundary: "direct_s1" });
    const summary = getImpactSummary(db, 3_600_000, {}, noScope);
    expect(summary.totals.water_consumption_ml.central).toBeCloseTo(0.26);
    expect(summary.totals.incomplete).toBe(true);
  });

  test("provider, agent, and request-group views retain attribution", () => {
    const db = database();
    insert(db, 1, "gemini-2.5-pro", {
      agent_id: "sub-1", agent_type: "reviewer",
      request_group_id: "req-1", turn_id: "turn-1",
    });
    insert(db, 2, "gpt-4o");
    const onlyGoogle = getImpactSummary(db, 3_600_000, { provider: "Google" }, noScope);
    expect(onlyGoogle.by_provider.map((r) => r.key)).toEqual(["Google"]);
    expect(onlyGoogle.by_agent.some((r) => r.key === "sub-1")).toBe(true);
    expect(onlyGoogle.by_request_group.some((r) => r.key === "req-1")).toBe(true);
    const main = getImpactSummary(db, 3_600_000, { agent: "main" }, noScope);
    expect(main.by_agent.map((r) => r.key)).toEqual(["main"]);
  });

  test("consumption and withdrawal filters never mix", () => {
    const db = database();
    insert(db, 1, "gemini-2.5-pro");
    expect(getImpactSummary(db, 3_600_000, { waterType: "consumption" }, noScope).totals.known_rows).toBe(1);
    expect(getImpactSummary(db, 3_600_000, { waterType: "withdrawal" }, noScope).totals.known_rows).toBe(0);
  });

  test("optional window budget reports central remaining and incomplete ranges", () => {
    const db = database();
    insert(db, 1, "gemini-2.5-pro");
    updateImpactSettings(db, { window_budget_ml: 100 });
    const budget = getImpactSummary(db, 3_600_000, {}, noScope).budgets[0];
    expect(budget.period).toBe("window");
    expect(budget.used.central).toBeCloseTo(0.26);
    expect(budget.remaining.central).toBeCloseTo(99.74);
    expect(budget.remaining.low).toBeNull();
  });

  test("custom budget uses its user-selected duration", () => {
    const db = database();
    insert(db, 1, "gemini-2.5-pro");
    updateImpactSettings(db, { custom_budget_ml: 50, custom_period_ms: 2 * 86_400_000 });
    const budget = getImpactSummary(db, 3_600_000, {}, noScope).budgets.find((row) => row.period === "custom")!;
    expect(budget.budget_ml).toBe(50);
    expect(budget.used.central).toBeCloseTo(0.26);
  });

  test("settings changes do not rewrite historical impact rows", () => {
    const db = database();
    insert(db, 1, "gemini-2.5-pro");
    const before = db.query<any, []>("SELECT * FROM event_impacts WHERE id = 1").get();
    updateImpactSettings(db, { boundary: "operational_s1_s2" });
    const after = db.query<any, []>("SELECT * FROM event_impacts WHERE id = 1").get();
    expect(after.profile_id).toBe(before.profile_id);
    expect(after.profile_version).toBe(before.profile_version);
    expect(after.water_consumption_ml_central).toBe(before.water_consumption_ml_central);
  });

  test("timestamp index serves broad-window aggregation", () => {
    const db = database();
    const plan = db.query<any, [number]>(`
      EXPLAIN QUERY PLAN
      SELECT SUM(i.water_consumption_ml_central)
      FROM event_impacts i JOIN events e ON e.id = i.event_id
      WHERE i.timestamp >= ?
    `).all(0).map((r) => String(r.detail)).join(" ");
    expect(plan).toContain("idx_event_impacts_ts");
  });
});

describe("impact settings validation", () => {
  test("rejects unknown enum values, profiles, factors, and negative budgets", () => {
    const db = database();
    expect(() => updateImpactSettings(db, { display_mode: "bogus" as any })).toThrow();
    expect(() => updateImpactSettings(db, { proxy_profile_id: "missing" })).toThrow();
    expect(() => updateImpactSettings(db, { regional_factor_id: "missing" })).toThrow();
    expect(() => updateImpactSettings(db, { daily_budget_ml: -1 })).toThrow();
  });
});
