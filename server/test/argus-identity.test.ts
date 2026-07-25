import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isArgusWorkspacePath, setNetworkScope } from "../src/argus/index.ts";
import { killTree } from "../src/argus/kill.ts";

describe("Argus identity boundary", () => {
  test("filesystem observation accepts only the workspace or descendants", () => {
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

  test("network scope cannot widen to every host connection", () => {
    expect(setNetworkScope(true).network.all).toBe(false);
  });

  test("Argus evidence collection cannot terminate host processes", () => {
    const result = killTree(424242);
    expect(result.killed).toEqual([]);
    expect(result.skipped).toBe("outside-argus-agent-integrity-scope");
  });
});
