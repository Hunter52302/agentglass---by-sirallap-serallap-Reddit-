import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = mkdtempSync(join(tmpdir(), "agx-map-reveal-"));
process.env.AGENTGLASS_DB = join(dir, "map.db");
process.env.XDG_CONFIG_HOME = dir;

const { db } = await import("../src/db.ts");
const { insertEnvEvent } = await import("../src/argus/store.ts");
const { isKnownPath } = await import("../src/argus/reveal.ts");
const { compareMapNodes } = await import("../src/argus/map.ts");

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
});
