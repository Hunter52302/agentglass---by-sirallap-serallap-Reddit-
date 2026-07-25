// Committing a renamed file used to record only the new path's addition, not the
// old path's deletion: HEAD ended up with both files plus an orphaned staged
// deletion. A rename must land whole.
import { describe, expect, it, beforeEach, afterEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { commit } from "../src/git.ts";

// `bun test` shares ONE process across every file, so a scope this file sets
// stays set for every suite that runs after it — their rows then fall outside
// the leaked scope and vanish from every scoped query, which reads as a
// product bug in whichever file happened to be next. Captured at module load
// (before anything below assigns it) and put back when this file is done.
const __priorScope = process.env.AGENTGLASS_ROOT;
afterAll(() => {
  if (__priorScope === undefined) delete process.env.AGENTGLASS_ROOT;
  else process.env.AGENTGLASS_ROOT = __priorScope;
});


let dir = "";
const git = (...a: string[]) => spawnSync("git", ["-C", dir, ...a], { encoding: "utf8" });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agx-commitrename-"));
  process.env.AGENTGLASS_ROOT = dir; // the commit path is scope-guarded
  delete process.env.AGENTGLASS_COMMIT_DISABLED;
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  // See conflicts.test.ts: byte-exact assertions need a fixed line ending, and
  // a Git-for-Windows default of core.autocrlf=true rewrites checkouts to CRLF.
  git("config", "core.autocrlf", "false");
  writeFileSync(join(dir, "orig.txt"), "content\n");
  git("add", "-A"); git("commit", "-qm", "seed");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("commit() of a rename", () => {
  it("lands the whole rename: HEAD has only the new path, nothing left staged", () => {
    git("mv", "orig.txt", "renamed.txt"); // staged rename → status shows `R orig -> renamed`
    // Sanity: git really does see a rename.
    expect(git("status", "--porcelain").stdout).toMatch(/^R/);

    // The composer only ever offers the new path.
    const r = commit(dir, ["renamed.txt"], "rename it", "");
    expect(r.ok).toBe(true);

    const tree = git("ls-tree", "-r", "--name-only", "HEAD").stdout.trim().split("\n");
    expect(tree).toContain("renamed.txt");
    expect(tree).not.toContain("orig.txt"); // the deletion rode along
    // No orphaned staged deletion left behind.
    expect(git("diff", "--cached", "--name-only").stdout.trim()).toBe("");
  });

  it("still commits an ordinary file without dragging anything in", () => {
    writeFileSync(join(dir, "plain.txt"), "hi\n");
    const r = commit(dir, ["plain.txt"], "add plain", "");
    expect(r.ok).toBe(true);
    const tree = git("ls-tree", "-r", "--name-only", "HEAD").stdout.trim().split("\n");
    expect(tree).toContain("plain.txt");
    expect(tree).toContain("orig.txt");
  });
});
