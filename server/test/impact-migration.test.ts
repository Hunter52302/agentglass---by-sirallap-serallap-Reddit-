import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { NormalizedEvent } from "../src/ingest.ts";
import {
  getImpactSettings, migrateImpact, persistEventImpact,
} from "../src/impact/store.ts";

const open: Database[] = [];
afterEach(() => {
  while (open.length) open.pop()!.close();
});

function database(): Database {
  const db = new Database(":memory:");
  open.push(db);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE events (id INTEGER PRIMARY KEY, payload TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE sessions (session_id TEXT PRIMARY KEY);
  `);
  return db;
}

function normalized(over: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    source_app: "app", session_id: "s", hook_event_type: "Stop",
    tool_name: null, tool_use_id: null, agent_id: null, agent_type: null,
    model_name: "gemini-2.5-pro", is_error: 0, error_text: null,
    usage: { input_tokens: 100, output_tokens: 20 }, usage_is_cumulative: false,
    cost_cumulative: null, summary: null, timestamp: 1_700_000_000_000,
    payload: {}, chat: null, ...over,
  };
}

const provider = (model: string | null | undefined): string | null => {
  const m = (model ?? "").toLowerCase();
  if (m.includes("gemini")) return "Google";
  if (/gpt|\bo[134]\b/.test(m)) return "OpenAI";
  if (m.includes("claude")) return "Anthropic";
  return null;
};

describe("impact migration", () => {
  test("is additive and idempotent on an existing database", () => {
    const db = database();
    db.query("INSERT INTO events (id, payload) VALUES (1, '{}')").run();
    db.query("INSERT INTO sessions (session_id) VALUES ('old')").run();
    migrateImpact(db);
    migrateImpact(db);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events").get()!.n).toBe(1);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM sessions").get()!.n).toBe(1);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM impact_profiles").get()!.n).toBeGreaterThan(5);
    expect(getImpactSettings(db).display_mode).toBe("cost");
  });

  test("event deletion cascades to impact rows without touching profiles", () => {
    const db = database();
    migrateImpact(db);
    db.query("INSERT INTO events (id, payload) VALUES (1, '{}')").run();
    db.query("INSERT INTO sessions (session_id) VALUES ('s')").run();
    persistEventImpact(db, 1, normalized(), normalized().usage, provider);
    db.query("DELETE FROM events WHERE id = 1").run();
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM event_impacts").get()!.n).toBe(0);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM impact_profiles").get()!.n).toBeGreaterThan(5);
  });

  test("historical impact keeps exact profile version when another version appears", () => {
    const db = database();
    migrateImpact(db);
    db.query("INSERT INTO events (id, payload) VALUES (1, '{}')").run();
    db.query("INSERT INTO sessions (session_id) VALUES ('s')").run();
    persistEventImpact(db, 1, normalized(), normalized().usage, provider);
    const before = db.query<any, []>("SELECT profile_id, profile_version FROM event_impacts").get();
    db.query(`
      INSERT INTO impact_profiles
      SELECT profile_id, '2.0.0', provider, model_match, workload_class, statistic,
             water_type, scopes_included, scope_unknown, energy_boundary,
             water_s1_ml, water_s2_ml, water_s3_ml, low_ml, 999, high_ml,
             energy_wh_low, energy_wh_central, energy_wh_high, region,
             source_title, source_url, source_date, source_tier, measured, basis,
             default_enabled, notes, created_at
      FROM impact_profiles WHERE profile_id = ?
    `).run(before.profile_id);
    const after = db.query<any, []>("SELECT profile_id, profile_version FROM event_impacts").get();
    expect(after).toEqual(before);
  });
});

describe("impact persistence", () => {
  test("stores source/profile references separately from event telemetry", () => {
    const db = database();
    migrateImpact(db);
    db.query("INSERT INTO events (id, payload) VALUES (1, '{}')").run();
    db.query("INSERT INTO sessions (session_id) VALUES ('s')").run();
    persistEventImpact(db, 1, normalized({
      payload: { request_group_id: "req-1", turn_id: "turn-1" },
    }), { input_tokens: 100, output_tokens: 20 }, provider);
    const row = db.query<any, []>("SELECT * FROM event_impacts").get();
    expect(row.profile_id).toBe("google-gemini-apps-2025-direct");
    expect(row.profile_version).toBe("1.0.0");
    expect(row.water_consumption_ml_central).toBeCloseTo(0.26);
    expect(row.request_group_id).toBe("req-1");
    expect(row.turn_id).toBe("turn-1");
  });

  test("repeated cumulative snapshots do not duplicate message impact", () => {
    const db = database();
    migrateImpact(db);
    db.query("INSERT INTO sessions (session_id) VALUES ('s')").run();
    db.query("INSERT INTO events (id, payload) VALUES (1, '{}'), (2, '{}')").run();
    const chat = [
      { message: { id: "m1", model: "gemini-2.5-pro", usage: { input_tokens: 100, output_tokens: 20 } } },
      { message: { id: "m2", model: "gpt-4o", usage: { input_tokens: 200, output_tokens: 30 } } },
    ];
    const n = normalized({ usage_is_cumulative: true, chat });
    expect(persistEventImpact(db, 1, n, n.usage, provider)).toBe(2);
    expect(persistEventImpact(db, 2, n, n.usage, provider)).toBe(0);
    const rows = db.query<any, []>("SELECT provider, profile_id FROM event_impacts ORDER BY id").all();
    expect(rows).toEqual([
      { provider: "Google", profile_id: "google-gemini-apps-2025-direct" },
      { provider: "OpenAI", profile_id: "openai-average-query-2025-undisclosed-boundary" },
    ]);
  });

  test("unknown provider stays nullable instead of becoming zero water", () => {
    const db = database();
    migrateImpact(db);
    db.query("INSERT INTO events (id, payload) VALUES (1, '{}')").run();
    db.query("INSERT INTO sessions (session_id) VALUES ('s')").run();
    const n = normalized({ model_name: "unknown-model" });
    persistEventImpact(db, 1, n, n.usage, provider);
    const row = db.query<any, []>("SELECT method, water_consumption_ml_central FROM event_impacts").get();
    expect(row.method).toBe("unknown");
    expect(row.water_consumption_ml_central).toBeNull();
  });

  test("wall-energy metadata wins over provider proxy profiles", () => {
    const db = database();
    migrateImpact(db);
    db.query("INSERT INTO events (id, payload) VALUES (1, '{}')").run();
    db.query("INSERT INTO sessions (session_id) VALUES ('s')").run();
    const n = normalized({
      model_name: "gemini-2.5-pro",
      payload: { runtime_energy: { boundary: "wall", wh_central: 10, grid_factor_l_per_kwh: 4 } },
    });
    persistEventImpact(db, 1, n, n.usage, provider);
    const row = db.query<any, []>("SELECT method, profile_id, water_s2_ml_central FROM event_impacts").get();
    expect(row.method).toBe("measured_local");
    expect(row.profile_id).toBeNull();
    expect(row.water_s2_ml_central).toBeCloseTo(40);
  });
});
