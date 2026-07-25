// Path handling that must behave the same on macOS, Linux and Windows.
//
// Every bug pinned here had the same shape: a literal "/" written into a path
// comparison. On macOS and Linux that is correct and invisible; on Windows
// `resolve()` produces backslashes and the comparison is silently always false.
// The failures never looked like path bugs — they looked like "outside the open
// project", an empty container list, a worktree with no parent, or nothing ever
// being marked ignored.
//
// So these assert on BOTH spellings regardless of host, and would fail on
// either platform if the separator-agnostic handling regressed. The point is
// not "does it work on Windows" — it is "does it work the same everywhere".

import { describe, expect, test } from "bun:test";
import { isUnderPath } from "../src/config.ts";
import { worktreeLabel } from "../src/worktree.ts";
import { containerInScope } from "../src/docker.ts";
import { normalizePath, isUnder } from "../src/argus/paths.ts";

describe("isUnderPath is separator-agnostic", () => {
  test("a child is inside its parent in either spelling", () => {
    expect(isUnderPath("C:\\code\\orbit\\src\\a.ts", "C:\\code\\orbit")).toBe(true);
    expect(isUnderPath("C:/code/orbit/src/a.ts", "C:/code/orbit")).toBe(true);
    expect(isUnderPath("/home/z/orbit/src/a.ts", "/home/z/orbit")).toBe(true);
  });

  test("the two spellings of the SAME location agree", () => {
    // Not hypothetical: Claude Code reports project_path with forward slashes
    // and cwd with backslashes in one payload, so both forms describe the same
    // directory and must compare equal.
    expect(isUnderPath("C:/code/orbit/src/a.ts", "C:\\code\\orbit")).toBe(true);
    expect(isUnderPath("C:\\code\\orbit\\src\\a.ts", "C:/code/orbit")).toBe(true);
  });

  test("a path is inside itself", () => {
    expect(isUnderPath("/a/b", "/a/b")).toBe(true);
    expect(isUnderPath("C:\\a\\b", "C:\\a\\b")).toBe(true);
  });

  test("a trailing separator on the parent changes nothing", () => {
    expect(isUnderPath("/a/b/c", "/a/b/")).toBe(true);
    expect(isUnderPath("C:\\a\\b\\c", "C:\\a\\b\\")).toBe(true);
  });

  test("a SIBLING sharing the parent's name as a prefix is NOT inside it", () => {
    // The line the old `startsWith(parent + "/")` drew correctly and which the
    // normalised version must keep drawing: `orbit-backup` is not in `orbit`.
    expect(isUnderPath("/code/orbit-backup/x", "/code/orbit")).toBe(false);
    expect(isUnderPath("C:\\code\\orbit-backup\\x", "C:\\code\\orbit")).toBe(false);
    expect(isUnderPath("C:/code/orbit-backup/x", "C:\\code\\orbit")).toBe(false);
  });

  test("on POSIX a backslash is a FILENAME character, not a separator", () => {
    // A directory really can be called `we\ird` on macOS and Linux. Rewriting
    // it to `we/ird` would invent a level of nesting that does not exist and
    // could report an unrelated path as inside a scope, so the rewrite is
    // limited to Windows and to Windows-shaped paths.
    const weird = "/code/we\\ird";
    if (process.platform !== "win32") {
      expect(isUnderPath("/code/or\\bit-x", "/code/or/bit")).toBe(false);
      expect(isUnderPath(weird, weird)).toBe(true);
      expect(isUnderPath(weird, "/code/we")).toBe(false);
    }
    // A Windows path is still understood wherever it is read — a transcript
    // recorded on Windows can be opened on a Mac.
    expect(isUnderPath("C:\\code\\orbit\\a.ts", "C:/code/orbit")).toBe(true);
  });

  test("an unrelated path is out", () => {
    expect(isUnderPath("/other/thing", "/code/orbit")).toBe(false);
    expect(isUnderPath("D:\\other\\thing", "C:\\code\\orbit")).toBe(false);
  });
});

describe("worktreeLabel names the leaf directory", () => {
  test("either separator yields the leaf, never the whole path", () => {
    expect(worktreeLabel("/home/z/code/orbit-WEB-1042")).toBe("orbit-WEB-1042");
    expect(worktreeLabel("C:\\code\\orbit-WEB-1042")).toBe("orbit-WEB-1042");
    expect(worktreeLabel("C:/code/orbit-WEB-1042")).toBe("orbit-WEB-1042");
  });

  test("a POSIX name containing a backslash is not split apart", () => {
    if (process.platform !== "win32") {
      expect(worktreeLabel("/home/z/code/we\\ird")).toBe("we\\ird");
    }
  });

  test("a trailing separator does not produce an empty label", () => {
    expect(worktreeLabel("/home/z/code/orbit/")).toBe("orbit");
    expect(worktreeLabel("C:\\code\\orbit\\")).toBe("orbit");
  });
});

describe("docker scope matching", () => {
  const wd = (workingDir: string | null) => ({ project: null, workingDir });

  test("a container launched inside the scope is in scope, either spelling", () => {
    expect(containerInScope(wd("C:\\code\\orbit"), { dir: "C:\\code\\orbit", project: "orbit" })).toBe(true);
    expect(containerInScope(wd("C:/code/orbit"), { dir: "C:\\code\\orbit", project: "orbit" })).toBe(true);
    expect(containerInScope(wd("/code/orbit/sub"), { dir: "/code/orbit", project: "orbit" })).toBe(true);
  });

  test("a sibling checkout is not swept in by a shared prefix", () => {
    expect(containerInScope(wd("/code/orbit-backup"), { dir: "/code/orbit", project: "orbit" })).toBe(false);
  });

  test("the project-name signal still works when there is no working dir", () => {
    expect(containerInScope({ project: "orbit", workingDir: null }, { dir: "/code/orbit", project: "orbit" })).toBe(true);
  });
});

describe("Argus path normalization", () => {
  test("one canonical id per file, whatever the caller spelled", () => {
    expect(normalizePath("C:\\Users\\z\\a.txt")).toBe(normalizePath("c:/Users/z/a.txt"));
    expect(normalizePath("/home/z/a.txt")).toBe("/home/z/a.txt");
  });

  test("isUnder does not treat a name prefix as containment", () => {
    expect(isUnder("C:\\repo\\src\\a.ts", "/c:/repo")).toBe(true);
    expect(isUnder("/c:/repo-other/a.ts", "/c:/repo")).toBe(false);
  });
});
