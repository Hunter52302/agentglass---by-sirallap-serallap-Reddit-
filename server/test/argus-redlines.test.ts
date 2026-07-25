import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "argus-redlines-"));
const file = join(dir, "redlines.json");
const priorFile = process.env.GLASSES_REDLINES;
process.env.GLASSES_REDLINES = file;

let redlines: typeof import("../src/argus/redlines.ts");

beforeAll(async () => {
  redlines = await import(`../src/argus/redlines.ts?test=${Date.now()}`);
});

beforeEach(() => {
  writeFileSync(file, "[]\n");
  redlines.reloadRedlines(null);
});

afterAll(() => {
  if (priorFile === undefined) delete process.env.GLASSES_REDLINES;
  else process.env.GLASSES_REDLINES = priorFile;
  rmSync(dir, { recursive: true, force: true });
});

const save = (rules: unknown, watchDir: string | null = null) => {
  writeFileSync(file, JSON.stringify(rules, null, 2));
  redlines.reloadRedlines(watchDir);
};

describe("Argus redline loading", () => {
  test("a missing file means no rules", () => {
    rmSync(file);
    redlines.reloadRedlines(null);
    expect(redlines.redlineStatus()).toMatchObject({ error: null, loaded_from: null, rules: [] });
  });

  test("malformed JSON and invalid regex activate no partial rules", () => {
    writeFileSync(file, `[{"id":"valid","target":"safe"},{"id":"broken","target":"["}]`);
    redlines.reloadRedlines(null);
    expect(redlines.redlineStatus().error).toContain("regular expression");
    expect(redlines.redlineStatus().rules).toEqual([]);
    expect(redlines.evaluate({ action: "Bash", target: "safe" })).toBeNull();
  });

  test("disabled rules do not match", () => {
    save([{ id: "off", enabled: false, kind: "command", target: "blocked", decision: "gate" }]);
    expect(redlines.evaluate({ action: "Bash", target: "blocked" })).toBeNull();
  });

  test("upsert replaces duplicate IDs and rejects invalid input before writing", () => {
    redlines.upsertRedline({ id: "same", target: "first", decision: "flag" });
    redlines.upsertRedline({ id: "same", target: "second", decision: "kill" });
    const stored = JSON.parse(readFileSync(file, "utf8"));
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ id: "same", target: "second", decision: "kill" });

    const before = readFileSync(file, "utf8");
    expect(() => redlines.upsertRedline({ id: "bad", target: "[" })).toThrow();
    expect(readFileSync(file, "utf8")).toBe(before);
  });
});

describe("command redlines", () => {
  test.each(["flag", "gate", "kill"] as const)("%s decision survives action and target matching", (decision) => {
    save([{ id: decision, kind: "command", action: "^Bash$", target: "git\\s+push", decision }]);
    expect(redlines.evaluate({ action: "Bash", target: "git push origin main" })?.decision).toBe(decision);
    expect(redlines.evaluate({ action: "Write", target: "git push origin main" })).toBeNull();
    expect(redlines.evaluate({ action: "Bash", target: "git status" })).toBeNull();
  });
});

describe("protected-path redlines", () => {
  test("exact and descendant files match, unrelated siblings do not", () => {
    save([{
      id: "secrets",
      kind: "path",
      protected_path: "/workspace/secrets",
      operations: ["create", "write", "delete"],
      decision: "flag",
    }]);
    expect(redlines.evaluateFileObservation({ action: "fs_write", path: "/workspace/secrets" })).not.toBeNull();
    expect(redlines.evaluateFileObservation({ action: "fs_create", path: "/workspace/secrets/key.txt" })).not.toBeNull();
    expect(redlines.evaluateFileObservation({ action: "fs_delete", path: "/workspace/secrets-old/key.txt" })).toBeNull();
  });

  test("operation filters and both separator styles are honored", () => {
    save([{
      id: "windows",
      kind: "file",
      protected_path: "C:\\work\\secrets",
      operations: ["write"],
      decision: "gate",
    }]);
    expect(redlines.evaluateFileObservation({ action: "fs_write", path: "c:/work/secrets/a.txt" })).not.toBeNull();
    expect(redlines.evaluateFileObservation({ action: "fs_create", path: "C:\\work\\secrets\\a.txt" })).toBeNull();
  });

  test("${WATCH_DIR} binds to the selected directory and stays inactive before selection", () => {
    const rule = [{
      id: "watch",
      kind: "path",
      protected_path: "${WATCH_DIR}/protected",
      operations: ["write"],
      decision: "flag",
    }];
    save(rule);
    expect(redlines.redlineStatus().rules[0].enabled).toBe(false);
    expect(redlines.evaluateFileObservation({ action: "fs_write", path: "/protected/a" })).toBeNull();

    save(rule, "/chosen");
    expect(redlines.redlineStatus().rules[0].enabled).toBe(true);
    expect(redlines.evaluateFileObservation({ action: "fs_write", path: "/chosen/protected/a" })).not.toBeNull();
  });

  test("relative protected paths fail visibly", () => {
    save([{ id: "relative", kind: "path", protected_path: "secrets", decision: "flag" }]);
    expect(redlines.redlineStatus().error).toContain("must be absolute");
    expect(redlines.redlineStatus().rules).toEqual([]);
  });
});
