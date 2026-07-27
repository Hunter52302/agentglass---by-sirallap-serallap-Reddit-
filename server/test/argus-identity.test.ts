import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isArgusWorkspacePath, setNetworkScope } from "../src/argus/index.ts";
import { killTree } from "../src/argus/kill.ts";
import { forgetGate, killableGates, killGate, noteGate } from "../src/argus/redlines.ts";

describe("Argus identity boundary", () => {
  test("workspace classification distinguishes normal and operator-expanded scope", () => {
    const base = mkdtempSync(join(tmpdir(), "argus-identity-"));
    const workspace = join(base, "repo");
    const child = join(workspace, "src");
    const sibling = join(base, "other");
    mkdirSync(child, { recursive: true });
    mkdirSync(sibling, { recursive: true });
    try {
      expect(isArgusWorkspacePath(workspace, workspace)).toBe(true);
      expect(isArgusWorkspacePath(child, workspace)).toBe(true);
      expect(isArgusWorkspacePath(sibling, workspace)).toBe(false);
      expect(isArgusWorkspacePath(base, workspace)).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("whole-network visibility remains an explicit reversible choice", () => {
    expect(setNetworkScope(true).network.all).toBe(true);
    expect(setNetworkScope(false).network.all).toBe(false);
  });

  test("redline kill refuses invalid, system, self, and parent pids", () => {
    expect(killTree(0).skipped).toBe("invalid-pid");
    expect(killTree(1).skipped).toBe("invalid-pid");
    expect(killTree(Number.NaN).skipped).toBe("invalid-pid");
    expect(killTree(process.pid).skipped).toBe("refuses-self-or-parent");
    expect(killTree(process.ppid).skipped).toBe("refuses-self-or-parent");
  });

  test("ordinary held gates never become killable", () => {
    const id = `not-redlined-${Date.now()}`;
    noteGate(id, { pid: process.pid, rule: null, created: Date.now() });
    expect(killableGates().some((gate) => gate.id === id)).toBe(false);
    expect(killGate(id)).toMatchObject({ requested: process.pid, skipped: "not-redlined" });
  });

  test("only a redline match can expose the kill path", () => {
    const id = `redlined-${Date.now()}`;
    noteGate(id, {
      pid: process.pid,
      rule: { id: "operator-rule", description: "operator rule", decision: "gate" },
      created: Date.now(),
    });
    expect(killableGates().find((gate) => gate.id === id)?.rule.id).toBe("operator-rule");
    expect(killGate(id).skipped).toBe("refuses-self-or-parent");
    forgetGate(id);
  });

  test("identity contract excludes privileged-watchdog bridges", () => {
    const identity = readFileSync(join(import.meta.dir, "../../docs/ARGUS-IDENTITY.md"), "utf8");
    expect(identity).toContain("Argus has exactly two identities");
    expect(identity).toMatch(/not a deferred\s+Argus identity/);
    expect(identity).toContain("does not accept a partial foundation");
    expect(identity).toMatch(/only direct OS\s+intervention/);
    expect(identity).toContain("Redline matching never kills automatically");

    const sourceDir = join(import.meta.dir, "../src/argus");
    const implementation = readdirSync(sourceDir)
      .filter((name) => name.endsWith(".ts"))
      .map((name) => readFileSync(join(sourceDir, name), "utf8"))
      .join("\n");
    for (const forbidden of [
      /\bebpf\b/i,
      /\bminifilter\b/i,
      /\bendpoint security\b/i,
      /\bwindows filtering platform\b/i,
      /\btls interception\b/i,
    ]) {
      expect(implementation).not.toMatch(forbidden);
    }
  });

  test.skipIf(process.platform === "win32")("redline kill stops only a verified test process tree", async () => {
    const child = Bun.spawn(["sh", "-c", "sleep 30 & wait"], { stdout: "ignore", stderr: "ignore" });
    try {
      await Bun.sleep(100);
      const result = killTree(child.pid);
      expect(result.requested).toBe(child.pid);
      expect(result.killed).toContain(child.pid);
      expect(result.skipped).toBeUndefined();
    } finally {
      try { child.kill("SIGKILL"); } catch { /* already contained */ }
    }
  });
});
