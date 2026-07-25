import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isArgusWorkspacePath, setNetworkScope } from "../src/argus/index.ts";
import { killTree } from "../src/argus/kill.ts";

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

  test("containment refuses invalid, system, self, and parent pids", () => {
    expect(killTree(0).skipped).toBe("invalid-pid");
    expect(killTree(1).skipped).toBe("invalid-pid");
    expect(killTree(process.pid).skipped).toBe("refuses-self-or-parent");
    expect(killTree(process.ppid).skipped).toBe("refuses-self-or-parent");
  });
});
