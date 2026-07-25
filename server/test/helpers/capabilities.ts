// What this machine can actually do, probed once.
//
// A test that needs a capability the host does not have should SKIP, loudly and
// by name — not fail, and above all not throw out of a `beforeAll` and take the
// whole file's other tests down with it. That is what was happening on Windows:
// two symlink calls in setup killed twenty-odd unrelated assertions, and the
// suite reported it as a product failure.
//
// Skipping is honest here because these are genuinely environmental. Creating a
// symlink on Windows needs Developer Mode or an elevated shell; Docker tests
// need a daemon. Neither says anything about whether the code is correct.

import { mkdtempSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function probeSymlink(): boolean {
  let dir = "";
  try {
    dir = mkdtempSync(join(tmpdir(), "agx-cap-"));
    const target = join(dir, "t");
    writeFileSync(target, "x");
    symlinkSync(target, join(dir, "l"));
    return true;
  } catch {
    return false;
  } finally {
    try { if (dir) rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ }
  }
}

/** Can this process create symlinks? False on stock Windows without Developer
 *  Mode, where symlinkSync throws EPERM. */
export const CAN_SYMLINK = probeSymlink();

/** Is a Docker daemon actually reachable? `docker` on PATH is not enough — the
 *  binary exists on plenty of machines whose daemon is not running. */
export const HAS_DOCKER = (() => {
  if (!Bun.which("docker")) return false;
  try {
    return Bun.spawnSync(["docker", "version", "--format", "{{.Server.Version}}"], {
      stdout: "pipe",
      stderr: "pipe",
    }).exitCode === 0;
  } catch {
    return false;
  }
})();

/** One line per unavailable capability, so a green run that skipped things says
 *  so instead of quietly looking complete. */
export function reportSkips(): void {
  if (!CAN_SYMLINK) {
    console.warn(
      `[tests] symlink creation unavailable on ${process.platform} — symlink-dependent tests skipped ` +
        "(enable Developer Mode on Windows, or run elevated, to cover them)"
    );
  }
  if (!HAS_DOCKER) console.warn("[tests] no reachable Docker daemon — docker tests skipped");
}
