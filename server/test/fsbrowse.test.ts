// The project picker's path completion hands directory listings to anything
// that clears the origin/token gate, so the input parsing is worth pinning: a
// NUL that truncates a path at the syscall boundary, a relative path that would
// resolve against whatever directory the server was launched from, and the
// promise that only directory names ever come back.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { completePath, splitPrefix } from "../src/fsbrowse.ts";
import { CAN_SYMLINK } from "./helpers/capabilities.ts";

let base = "";
beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "agx-fsbrowse-"));
  for (const d of ["alpha", "alavera_app", "alavera_api", "beta", ".hidden", "node_modules"]) {
    mkdirSync(join(base, d));
  }
  mkdirSync(join(base, "alavera_app", ".git"));
  writeFileSync(join(base, "a-file.txt"), "not a directory");
  writeFileSync(join(base, "alpha", "secret.env"), "TOKEN=hunter2");
  // Conditional: on Windows without Developer Mode this throws EPERM, and a
  // throw here used to kill every other test in the file.
  if (CAN_SYMLINK) {
    symlinkSync(join(base, "alpha"), join(base, "alink"));
    symlinkSync(join(base, "a-file.txt"), join(base, "afilelink"));
  }
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

const names = (input: string) => completePath(input).entries.map((e) => e.name);

describe("splitPrefix", () => {
  test("a NUL is refused outright, not normalised away", () => {
    // `/etc\0/x` reaches the kernel as `/etc` — refusing is the only safe read.
    expect(splitPrefix("/etc\0/passwd")).toBeNull();
    expect(splitPrefix("\0")).toBeNull();
    expect(completePath("/etc\0").entries).toEqual([]);
  });

  test("relative input is refused — it would resolve against the server's cwd", () => {
    for (const p of ["code", "./code", "../code", ""]) expect(splitPrefix(p)).toBeNull();
  });

  test("non-strings are refused", () => {
    for (const v of [null, undefined, 42, {}, ["/tmp"]]) expect(splitPrefix(v)).toBeNull();
  });

  // splitPrefix answers with a RESOLVED path, which is native-separator by
  // definition — `/usr/local` on POSIX, `C:\usr\local` on Windows, where a
  // rooted "/usr" is resolved against the current drive. Comparing against a
  // hardcoded forward-slash string only ever passed on POSIX and said nothing
  // about the behaviour being tested.
  const R = (p: string) => resolve(p);

  test("a trailing slash lists inside; anything else filters the last segment", () => {
    expect(splitPrefix("/usr/local/")).toEqual({ dir: R("/usr/local"), partial: "" });
    expect(splitPrefix("/usr/loc")).toEqual({ dir: R("/usr"), partial: "loc" });
  });

  test("`..` and doubled separators are collapsed, so the listed dir is the real one", () => {
    expect(splitPrefix("/usr/local/../")).toEqual({ dir: R("/usr"), partial: "" });
    expect(splitPrefix("//usr///local/")).toEqual({ dir: R("//usr///local"), partial: "" });
  });

  test("~ expands to the home directory; ~otheruser does not", () => {
    expect(splitPrefix("~/")).toEqual({ dir: homedir(), partial: "" });
    expect(splitPrefix("~")).toEqual({ dir: homedir(), partial: "" });
    expect(splitPrefix("~root/")).toBeNull();
  });
});

describe("completePath", () => {
  test("returns directories only — never files, and never file contents", () => {
    const out = names(base + "/");
    expect(out).toContain("alpha");
    expect(out).not.toContain("a-file.txt");
    if (CAN_SYMLINK) expect(out).not.toContain("afilelink"); // a symlink pointing at a file
    expect(JSON.stringify(completePath(base + "/"))).not.toContain("hunter2");
  });

  test("entries carry only a name, an absolute path and a repo flag", () => {
    const e = completePath(base + "/alavera")!.entries[0];
    expect(Object.keys(e).sort()).toEqual(["name", "path", "repo"]);
  });

  test("the partial segment filters by prefix, case-insensitively", () => {
    expect(names(base + "/alav").sort()).toEqual(["alavera_api", "alavera_app"]);
    expect(names(base + "/ALAV").sort()).toEqual(["alavera_api", "alavera_app"]);
    expect(names(base + "/zzz")).toEqual([]);
  });

  test("git repos are marked; plain directories are not", () => {
    const byName = new Map(completePath(base + "/").entries.map((e) => [e.name, e.repo]));
    expect(byName.get("alavera_app")).toBe(true);
    expect(byName.get("alavera_api")).toBe(false);
  });

  test("hidden dirs stay out until a dot is typed; dependency trees never appear", () => {
    expect(names(base + "/")).not.toContain(".hidden");
    expect(names(base + "/.")).toContain(".hidden");
    expect(names(base + "/")).not.toContain("node_modules");
    expect(names(base + "/node_")).toEqual([]);
  });

  test.skipIf(!CAN_SYMLINK)("symlinked directories are offered — code on another disk is a normal setup", () => {
    expect(names(base + "/")).toContain("alink");
  });

  test("an unreadable or missing directory answers empty rather than throwing", () => {
    const out = completePath(base + "/does-not-exist/");
    expect(out.entries).toEqual([]);
    expect(out.base).toBe(join(base, "does-not-exist"));
  });

  test("paths returned are absolute and joined to the resolved base", () => {
    const e = completePath(base + "/alpha")!.entries[0];
    expect(e.path).toBe(join(base, "alpha"));
  });
});
