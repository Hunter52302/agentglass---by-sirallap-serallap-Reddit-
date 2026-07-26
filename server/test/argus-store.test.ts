// AgentGlass Argus integration — the env_events read models.
//
// These are the queries the cockpit reads on every poll, and each one folds an
// append-only log into a "what is true now" answer. A regression here is silent
// in the worst way: the panel still renders, it just tells you something false.

import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate before importing anything that touches the DB — db.ts resolves its
// path at import time, so the developer's real database must never be reached.
const dir = mkdtempSync(join(tmpdir(), "agx-argus-store-"));
process.env.XDG_CONFIG_HOME = dir;
process.env.AGENTGLASS_DB = join(dir, "t.db");

const store = await import("../src/argus/store.ts");
const { db } = await import("../src/db.ts");

const T0 = 1_700_000_000_000;

function envRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    ts: T0,
    tier: "process",
    action: "process_discovered",
    target: "Ollama",
    node_id: "process:ollama:1",
    parent_node_id: null,
    pid: 1,
    ppid: null,
    runtime: "ollama",
    provider: "ollama",
    runtime_kind: "model-runtime",
    process_name: null,
    remote_host: null,
    remote_ip: null,
    remote_port: null,
    path: null,
    fidelity: "presence_only",
    attributed: 0 as 0 | 1,
    detail: {},
    ...over,
  } as any;
}

beforeAll(() => {
  db.run("DELETE FROM env_events");
});

describe("currentRuntimes folds lifecycle events", () => {
  test("last event per node decides whether it is running", () => {
    db.run("DELETE FROM env_events");
    store.insertEnvEvent(envRow({ ts: T0, node_id: "n:a", target: "A" }));
    store.insertEnvEvent(envRow({ ts: T0 + 1000, node_id: "n:a", target: "A", action: "process_stopped" }));
    store.insertEnvEvent(envRow({ ts: T0, node_id: "n:b", target: "B" }));

    const rt = store.currentRuntimes();
    const a = rt.find((r) => r.node_id === "n:a")!;
    const b = rt.find((r) => r.node_id === "n:b")!;
    expect(a.running).toBe(false);
    expect(b.running).toBe(true);
  });

  test("a restarted runtime is running again", () => {
    db.run("DELETE FROM env_events");
    store.insertEnvEvent(envRow({ ts: T0, node_id: "n:c" }));
    store.insertEnvEvent(envRow({ ts: T0 + 1000, node_id: "n:c", action: "process_stopped" }));
    store.insertEnvEvent(envRow({ ts: T0 + 2000, node_id: "n:c", action: "process_discovered" }));
    expect(store.currentRuntimes().find((r) => r.node_id === "n:c")!.running).toBe(true);
  });

  test("same-millisecond events are broken by insert order, not left to chance", () => {
    // Two lifecycle rows can share a ts under a fast poll. Without a tiebreak
    // the answer would flip between calls, which is worse than being wrong.
    db.run("DELETE FROM env_events");
    store.insertEnvEvent(envRow({ ts: T0, node_id: "n:d", action: "process_discovered" }));
    store.insertEnvEvent(envRow({ ts: T0, node_id: "n:d", action: "process_stopped" }));
    for (let i = 0; i < 5; i++) {
      expect(store.currentRuntimes().find((r) => r.node_id === "n:d")!.running).toBe(false);
    }
  });

  test("loaded models are the loads not since unloaded", () => {
    db.run("DELETE FROM env_events");
    store.insertEnvEvent(envRow({ ts: T0, node_id: "n:e" }));
    store.insertEnvEvent(envRow({
      ts: T0 + 10, node_id: "n:e", action: "model_loaded",
      detail: { model: { name: "llama3", digest: "d1" } },
    }));
    store.insertEnvEvent(envRow({
      ts: T0 + 20, node_id: "n:e", action: "model_loaded",
      detail: { model: { name: "qwen", digest: "d2" } },
    }));
    store.insertEnvEvent(envRow({
      ts: T0 + 30, node_id: "n:e", action: "model_unloaded",
      detail: { model: { name: "llama3", digest: "d1" } },
    }));
    const e = store.currentRuntimes().find((r) => r.node_id === "n:e")!;
    expect(e.models).toHaveLength(1);
    expect((e.models[0] as any).name).toBe("qwen");
  });

  test("models do not bleed between nodes", () => {
    db.run("DELETE FROM env_events");
    store.insertEnvEvent(envRow({ node_id: "n:x" }));
    store.insertEnvEvent(envRow({ node_id: "n:y" }));
    store.insertEnvEvent(envRow({
      ts: T0 + 5, node_id: "n:x", action: "model_loaded",
      detail: { model: { name: "only-on-x", digest: "dx" } },
    }));
    const rt = store.currentRuntimes();
    expect(rt.find((r) => r.node_id === "n:x")!.models).toHaveLength(1);
    expect(rt.find((r) => r.node_id === "n:y")!.models).toHaveLength(0);
  });
});

describe("blindness", () => {
  test("a runtime whose provider has no agentglass equivalent is blind", () => {
    db.run("DELETE FROM env_events");
    db.run("DELETE FROM sessions");
    store.insertEnvEvent(envRow({ node_id: "n:ollama", provider: "ollama" }));
    // Ollama never produces a model name in agent telemetry, so it is
    // unobservable to agentglass BY CONSTRUCTION — that is the signal.
    expect(store.currentRuntimes().find((r) => r.node_id === "n:ollama")!.blind).toBe(true);
  });

  test("a stopped runtime is never reported blind", () => {
    db.run("DELETE FROM env_events");
    store.insertEnvEvent(envRow({ node_id: "n:z", provider: "ollama" }));
    store.insertEnvEvent(envRow({ ts: T0 + 1, node_id: "n:z", provider: "ollama", action: "process_stopped" }));
    expect(store.currentRuntimes().find((r) => r.node_id === "n:z")!.blind).toBe(false);
  });

  test("provider aliasing bridges the two vocabularies", () => {
    // Argus names a runtime vendor lowercase; agentglass names a model vendor
    // capitalised. Matching them is what makes "is it reporting?" answerable.
    expect(store.providerIsReporting("anthropic", new Set(["Anthropic"]))).toBe(true);
    expect(store.providerIsReporting("anthropic", new Set(["OpenAI"]))).toBe(false);
    expect(store.providerIsReporting("ollama", new Set(["Anthropic"]))).toBe(false);
    expect(store.providerIsReporting(null, new Set(["Anthropic"]))).toBe(false);
  });
});

describe("currentConnections folds connect/close pairs", () => {
  const conn = (over: any = {}) =>
    envRow({
      tier: "network", action: "net_connect", target: "api.anthropic.com:443",
      node_id: "net:claude", process_name: "claude", remote_host: "api.anthropic.com",
      remote_ip: "1.2.3.4", remote_port: 443, provider: "anthropic",
      fidelity: "connection_metadata", detail: { ai_endpoint: true, label: "Anthropic" },
      ...over,
    });

  test("an open connection is open; a closed one is not", () => {
    db.run("DELETE FROM env_events");
    store.insertEnvEvent(conn({ ts: T0, pid: 10 }));
    store.insertEnvEvent(conn({ ts: T0 + 5, pid: 20 }));
    store.insertEnvEvent(conn({ ts: T0 + 10, pid: 20, action: "net_close" }));
    const rows = store.currentConnections(100, Number.MAX_SAFE_INTEGER);
    expect(rows.find((r) => r.pid === 10)!.open).toBe(true);
    expect(rows.find((r) => r.pid === 20)!.open).toBe(false);
  });

  test("a reconnect after a close is open again", () => {
    db.run("DELETE FROM env_events");
    store.insertEnvEvent(conn({ ts: T0, pid: 30 }));
    store.insertEnvEvent(conn({ ts: T0 + 5, pid: 30, action: "net_close" }));
    store.insertEnvEvent(conn({ ts: T0 + 9, pid: 30 }));
    const rows = store.currentConnections(100, Number.MAX_SAFE_INTEGER);
    expect(rows.filter((r) => r.pid === 30)).toHaveLength(1);
    expect(rows.find((r) => r.pid === 30)!.open).toBe(true);
  });

  test("the time window bounds the scan", () => {
    db.run("DELETE FROM env_events");
    store.insertEnvEvent(conn({ ts: Date.now() - 48 * 3600_000, pid: 40 }));
    store.insertEnvEvent(conn({ ts: Date.now() - 60_000, pid: 41 }));
    const rows = store.currentConnections(100, 3600_000);
    expect(rows.some((r) => r.pid === 41)).toBe(true);
    expect(rows.some((r) => r.pid === 40)).toBe(false);
  });
});

describe("suspect rollup", () => {
  test("counts unattributed writes and distinct paths in the window", () => {
    db.run("DELETE FROM env_events");
    const w = (p: string, ts: number) =>
      envRow({ ts, tier: "file", action: "fs_write", target: p, node_id: null, path: p, fidelity: "fs_observed" });
    const now = Date.now();
    store.insertEnvEvent(w("/a", now - 1000));
    store.insertEnvEvent(w("/a", now - 900));
    store.insertEnvEvent(w("/b", now - 800));
    store.insertEnvEvent(w("/old", now - 7200_000));
    const s = store.suspectRollup(3600_000);
    expect(s.unattributed_writes).toBe(3);
    expect(s.unattributed_paths).toBe(2);
  });
});

describe("actor lanes", () => {
  test("names programs and runtimes, but never a file writer", () => {
    db.run("DELETE FROM env_events");
    const now = Date.now();
    store.insertEnvEvent(envRow({ ts: now, node_id: "n:1", target: "Ollama" }));
    store.insertEnvEvent(envRow({
      ts: now, tier: "network", action: "net_connect", target: "x:443",
      node_id: "net:firefox", process_name: "firefox", fidelity: "connection_metadata",
    }));
    store.insertEnvEvent(envRow({
      ts: now, tier: "file", action: "fs_write", target: "/p", node_id: null,
      path: "/p", fidelity: "fs_observed",
    }));

    const lanes = store.actorLanes(3600_000);
    expect(lanes.find((l) => l.actor === "Ollama")!.kind).toBe("runtime");
    expect(lanes.find((l) => l.actor === "firefox")!.kind).toBe("program");
    // The OS reports no writing pid, so this lane can never be named.
    const unknown = lanes.find((l) => l.kind === "unattributed")!;
    expect(unknown.actor).toBe("writer unknown");
    expect(unknown.evidence).toBe("filesystem_observer");
    expect(unknown.confidence).toBe("actor_unknown");
    expect(lanes.find((l) => l.actor === "firefox")!.evidence).toBe("socket_owner");
  });

  test("writer-unknown lane sorts first so the evidence gap cannot be scrolled past", () => {
    db.run("DELETE FROM env_events");
    const now = Date.now();
    store.insertEnvEvent(envRow({
      ts: now, tier: "network", action: "net_connect", target: "x:443",
      node_id: "net:chatty", process_name: "chatty", fidelity: "connection_metadata",
    }));
    store.insertEnvEvent(envRow({
      ts: now - 5000, tier: "file", action: "fs_write", target: "/p",
      node_id: null, path: "/p", fidelity: "fs_observed",
    }));
    expect(store.actorLanes(3600_000)[0].kind).toBe("unattributed");
  });
});

describe("recorded shells", () => {
  const chunk = (agent: string, seq: number, text: string, end = false) =>
    envRow({
      ts: T0 + seq, tier: "pty", action: end ? "pty_end" : "pty_chunk", target: agent,
      node_id: `pty:${agent}`, fidelity: "pty_recorded",
      detail: { chunk_b64: Buffer.from(text).toString("base64"), seq, command: "bash" },
    });

  test("reassembles chunks in sequence order, not arrival order", () => {
    db.run("DELETE FROM env_events");
    store.insertEnvEvent(chunk("s1", 2, "world"));
    store.insertEnvEvent(chunk("s1", 1, "hello "));
    const sh = store.ptyShells().find((s) => s.agent === "s1")!;
    expect(sh.output).toBe("hello world");
    expect(sh.chunks).toBe(2);
  });

  test("marks a shell ended and keeps shells apart", () => {
    db.run("DELETE FROM env_events");
    store.insertEnvEvent(chunk("a", 1, "A"));
    store.insertEnvEvent(chunk("b", 1, "B"));
    store.insertEnvEvent(chunk("a", 2, "", true));
    const shells = store.ptyShells();
    expect(shells.find((s) => s.agent === "a")!.ended).toBe(true);
    expect(shells.find((s) => s.agent === "b")!.ended).toBe(false);
    expect(shells.find((s) => s.agent === "b")!.output).toBe("B");
  });

  test("keeps the tail when output exceeds the cap", () => {
    db.run("DELETE FROM env_events");
    store.insertEnvEvent(chunk("big", 1, "X".repeat(500)));
    store.insertEnvEvent(chunk("big", 2, "END"));
    const sh = store.ptyShells(12, 100).find((s) => s.agent === "big")!;
    expect(sh.output.length).toBeLessThanOrEqual(100);
    // The tail is what you read; the head is the login banner.
    expect(sh.output.endsWith("END")).toBe(true);
  });
});

describe("replay", () => {
  test("reconstructs which runtimes were up at a past instant", () => {
    db.run("DELETE FROM env_events");
    store.insertEnvEvent(envRow({ ts: T0, node_id: "n:r", target: "R" }));
    store.insertEnvEvent(envRow({ ts: T0 + 10_000, node_id: "n:r", target: "R", action: "process_stopped" }));

    const before = store.replayAt(T0 + 5_000);
    const after = store.replayAt(T0 + 20_000);
    expect(before.runtimes.find((r) => r.node_id === "n:r")!.running).toBe(true);
    expect(after.runtimes.find((r) => r.node_id === "n:r")!.running).toBe(false);
  });

  test("an instant before anything happened is empty, not an error", () => {
    db.run("DELETE FROM env_events");
    store.insertEnvEvent(envRow({ ts: T0, node_id: "n:q" }));
    expect(store.replayAt(T0 - 60_000).runtimes).toHaveLength(0);
  });

  test("bounds report the real first and last", () => {
    db.run("DELETE FROM env_events");
    store.insertEnvEvent(envRow({ ts: T0, node_id: "n:1" }));
    store.insertEnvEvent(envRow({ ts: T0 + 500, node_id: "n:2" }));
    const b = store.replayBounds();
    expect(b.first).toBe(T0);
    expect(b.last).toBe(T0 + 500);
    expect(b.count).toBe(2);
  });
});

describe("retention", () => {
  test("prunes rows older than the window and keeps the rest", () => {
    db.run("DELETE FROM env_events");
    store.insertEnvEvent(envRow({ ts: Date.now() - 30 * 86_400_000, node_id: "n:old" }));
    store.insertEnvEvent(envRow({ ts: Date.now(), node_id: "n:new" }));
    store.pruneEnvEvents(8);
    const left = store.recentEnvEvents(50);
    expect(left.some((e) => e.node_id === "n:new")).toBe(true);
    expect(left.some((e) => e.node_id === "n:old")).toBe(false);
  });

  test("retention of 0 means forever, and prunes nothing", () => {
    db.run("DELETE FROM env_events");
    store.insertEnvEvent(envRow({ ts: Date.now() - 365 * 86_400_000, node_id: "n:ancient" }));
    expect(store.pruneEnvEvents(0)).toBe(0);
    expect(store.recentEnvEvents(50)).toHaveLength(1);
  });
});
