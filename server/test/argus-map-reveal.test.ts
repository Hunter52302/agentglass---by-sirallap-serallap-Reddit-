import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = mkdtempSync(join(tmpdir(), "agx-map-reveal-"));
process.env.AGENTGLASS_DB = join(dir, "map.db");
process.env.XDG_CONFIG_HOME = dir;

const { db, insertEvent } = await import("../src/db.ts");
const { insertEnvEvent, noteAgentPid } = await import("../src/argus/store.ts");
const { isKnownPath } = await import("../src/argus/reveal.ts");
const { buildMap, compareMapNodes } = await import("../src/argus/map.ts");
const { setFsWatch } = await import("../src/argus/index.ts");

function observed(path: string) {
  insertEnvEvent({
    ts: Date.now(),
    tier: "file",
    action: "write",
    target: path,
    node_id: null,
    parent_node_id: null,
    pid: null,
    ppid: null,
    runtime: null,
    provider: null,
    runtime_kind: null,
    process_name: null,
    remote_host: null,
    remote_ip: null,
    remote_port: null,
    path,
    fidelity: "fs_observed",
    attributed: 0,
    detail: {},
  });
}

describe("reveal allowlist", () => {
  test("allows an observed path and its ancestor, but refuses an unknown path", () => {
    db.run("DELETE FROM env_events");
    observed("/tmp/argus-map-reveal/project/src/file.ts");

    expect(isKnownPath("/tmp/argus-map-reveal/project/src/file.ts")).toBe(true);
    expect(isKnownPath("/tmp/argus-map-reveal/project")).toBe(true);
    expect(isKnownPath("/tmp/argus-map-reveal/unknown")).toBe(false);
  });
});

describe("map layout", () => {
  test("sort order is stable: directories first, then names", () => {
    const nodes = [
      { name: "z.ts", kind: "file" },
      { name: "beta", kind: "dir" },
      { name: "a.ts", kind: "file" },
      { name: "alpha", kind: "dir" },
    ] as any[];

    const forward = [...nodes].sort(compareMapNodes).map((n) => n.name);
    const reverse = [...nodes].reverse().sort(compareMapNodes).map((n) => n.name);
    expect(forward).toEqual(["alpha", "beta", "a.ts", "z.ts"]);
    expect(reverse).toEqual(forward);
  });

  test("reports the live filesystem-lens state", async () => {
    expect(buildMap().fs_tier_enabled).toBe(false);
    await setFsWatch({ enabled: true, dir });
    expect(buildMap().fs_tier_enabled).toBe(true);
    await setFsWatch({ enabled: false });
    expect(buildMap().fs_tier_enabled).toBe(false);
  });

  test("carries volunteered PID and latest tool into the positioned agent", () => {
    db.run("DELETE FROM events");
    db.run("DELETE FROM env_agent_pids");
    const session = "map-pid-session";
    const now = Date.now();
    db.run(
      `INSERT INTO events (
        source_app, session_id, hook_event_type, tool_name, payload, timestamp
      ) VALUES (?, ?, 'PostToolUse', 'Edit', ?, ?)`,
      ["map-test", session, JSON.stringify({ tool_input: { file_path: "/tmp/map-pid/file.ts" } }), now],
    );
    noteAgentPid(43210, session, "map-test");

    const agent = buildMap({ scope: null }).agents.find((item) => item.session_id === session);
    expect(agent).toMatchObject({
      pid: 43210,
      live: false,
      current_tool: "Edit",
      current: "/tmp/map-pid/file.ts",
    });
  });

  test("only calls a recent, unended session live", () => {
    db.run("DELETE FROM events");
    db.run("DELETE FROM sessions");
    const now = Date.now();
    const add = (session: string, endedAt: number | null, lastSeen: number) => {
      db.run(
        `INSERT INTO sessions (
          session_id, source_app, started_at, ended_at, last_seen
        ) VALUES (?, 'map-test', ?, ?, ?)`,
        [session, lastSeen - 1_000, endedAt, lastSeen],
      );
      db.run(
        `INSERT INTO events (
          source_app, session_id, hook_event_type, tool_name, payload, timestamp
        ) VALUES ('map-test', ?, 'PostToolUse', 'Edit', ?, ?)`,
        [session, JSON.stringify({ tool_input: { file_path: `/tmp/map-live/${session}.ts` } }), lastSeen],
      );
    };
    add("live-session", null, now);
    add("ended-session", now - 1_000, now);
    add("stale-session", null, now - 180_000);

    const agents = buildMap({ scope: null }).agents;
    expect(agents.find((agent) => agent.session_id === "live-session")?.live).toBe(true);
    expect(agents.find((agent) => agent.session_id === "ended-session")?.live).toBe(false);
    expect(agents.find((agent) => agent.session_id === "stale-session")?.live).toBe(false);
  });

  test("keeps a hierarchy when whole-machine paths form a forest", () => {
    db.run("DELETE FROM events");
    db.run("DELETE FROM env_events");
    observed("/alpha/project/src/a.ts");
    observed("/beta/project/src/b.ts");

    const full = buildMap({ scope: null, nodeCap: 100 });
    expect(full.root).toBeNull();
    expect(full.nodes.find((node) => node.path === "/alpha")?.kind).toBe("dir");
    expect(full.nodes.find((node) => node.path === "/alpha/project/src/a.ts")?.depth).toBe(3);
    expect(full.nodes.find((node) => node.path === "/beta/project/src/b.ts")?.depth).toBe(3);

    const capped = buildMap({ scope: null, nodeCap: 5 });
    const visible = new Set(capped.nodes.map((node) => node.path));
    for (const node of capped.nodes) {
      if (node.depth === 0) continue;
      const parent = node.path.slice(0, node.path.lastIndexOf("/"));
      expect(visible.has(parent)).toBe(true);
    }
  });

  test("does not leak old filesystem observations into a scoped project map", () => {
    db.run("DELETE FROM events");
    db.run("DELETE FROM env_events");
    const active = join(dir, "combined-agentglass");
    const retired = join(dir, "retired-argus");
    mkdirSync(active, { recursive: true });
    mkdirSync(retired, { recursive: true });
    observed(join(active, "src", "current.ts"));
    observed(join(retired, "src", "old.ts"));

    const map = buildMap({ scope: active, nodeCap: 100 });
    expect(map.nodes.some((node) => node.path === join(active, "src", "current.ts"))).toBe(true);
    expect(map.nodes.some((node) => node.path.startsWith(retired))).toBe(false);
    expect(map.unclaimed_total).toBe(1);
  });

  test("uses the filesystem lens for labeled activity too", async () => {
    db.run("DELETE FROM events");
    db.run("DELETE FROM env_events");
    const active = join(dir, "lens-active");
    const elsewhere = join(dir, "lens-elsewhere");
    mkdirSync(active, { recursive: true });
    mkdirSync(elsewhere, { recursive: true });
    const insertTouch = (session: string, project: string, file: string) => {
      insertEvent({
        source_app: "map-test",
        session_id: session,
        hook_event_type: "PostToolUse",
        tool_name: "Edit",
        tool_use_id: null,
        agent_id: null,
        agent_type: null,
        model_name: null,
        is_error: 0,
        error_text: null,
        usage: {},
        usage_is_cumulative: false,
        cost_cumulative: null,
        summary: null,
        timestamp: Date.now(),
        payload: {
          project_path: project,
          cwd: project,
          tool_input: { file_path: file },
        },
        chat: null,
      });
    };
    insertTouch("inside-lens", active, join(active, "src", "current.ts"));
    insertTouch("outside-lens", elsewhere, join(elsewhere, "src", "old.ts"));

    await setFsWatch({ enabled: true, dir: active });
    const map = buildMap({ nodeCap: 100 });
    expect(map.agents.map((agent) => agent.session_id)).toEqual(["inside-lens"]);
    expect(map.nodes.some((node) => node.path.startsWith(elsewhere))).toBe(false);
    await setFsWatch({ enabled: false });
  });
});
