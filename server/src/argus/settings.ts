// Glasses for Argus — persisted lens settings.
//
// MIT © 2026 Zac Rieger. See NOTICE.md.
//
// The Argus cockpit lets you flip the filesystem tier on, move the watched
// directory, and widen the network tier while the server runs. Those choices
// used to live only in memory, so every restart silently reverted to whatever
// the GLASSES_* environment happened to say — you would come back the next
// morning to a cockpit that had quietly stopped watching.
//
// PRECEDENCE, matching upstream's own rule ("environment variables still win",
// config.ts):
//
//   1. an explicitly set GLASSES_* env var   — an operator decision at launch
//   2. the persisted value from this file    — a decision made in the UI
//   3. the built-in default
//
// So a launch flag is still authoritative and cannot be silently overridden by
// a stored toggle, while the common case — no env vars set — remembers what you
// chose. Stored in its own file rather than upstream's config.json so nothing
// here can corrupt settings that are not ours.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

export const SETTINGS_PATH = join(
  process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
  "agentglass",
  "glasses.json"
);

export interface GlassesSettings {
  fs_enabled?: boolean;
  fs_dir?: string | null;
  network_all?: boolean;
}

let cache: GlassesSettings | null = null;

export function readSettings(): GlassesSettings {
  if (cache) return cache;
  try {
    if (existsSync(SETTINGS_PATH)) {
      const parsed = JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
      cache = parsed && typeof parsed === "object" ? parsed : {};
    } else {
      cache = {};
    }
  } catch {
    // A corrupt file must not take the tier down with it — the sensors are
    // more valuable than the preference.
    cache = {};
  }
  return cache!;
}

/** Merge and persist. Never throws: failing to remember a toggle is a much
 *  smaller problem than crashing the request that made it. */
export function writeSettings(patch: GlassesSettings): GlassesSettings {
  const next = { ...readSettings(), ...patch };
  cache = next;
  try {
    mkdirSync(dirname(SETTINGS_PATH), { recursive: true });
    writeFileSync(SETTINGS_PATH, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  } catch (e: any) {
    console.error(`[argus] could not persist settings to ${SETTINGS_PATH}: ${e?.message ?? e}`);
  }
  return next;
}

/** Was this env var explicitly set? An empty string counts as unset — that is
 *  what a shell leaves behind when a variable is declared but never given a
 *  value, and treating it as an operator decision would pin the setting. */
export const envSet = (name: string): boolean => {
  const v = process.env[name];
  return v != null && v !== "";
};

/** Resolve a boolean under the precedence rule above. */
export function resolveFlag(envName: string, stored: boolean | undefined, dflt: boolean): boolean {
  if (envSet(envName)) {
    const v = process.env[envName]!;
    return v !== "0" && v.toLowerCase() !== "false";
  }
  return stored ?? dflt;
}
