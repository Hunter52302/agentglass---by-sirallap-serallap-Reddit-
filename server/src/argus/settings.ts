// Glasses for Argus — persisted scoped-provenance settings.
//
// MIT © 2026 Zac Rieger. See NOTICE.md.
//
// Only the user's opt-in filesystem preference is persisted. The actual path is
// revalidated against the active AgentGlass workspace every time it is used, so
// an old setting can never silently widen observation after the workspace moves.
// Host-wide network expansion is intentionally retained only as a false-valued
// compatibility field while the identity-3 surface is removed.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

export const SETTINGS_PATH = join(
  process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
  "agentglass",
  "glasses.json",
);

export interface GlassesSettings {
  fs_enabled?: boolean;
  fs_dir?: string | null;
  /** Compatibility only. The current foundation always writes false. */
  network_all?: false;
}

let cache: GlassesSettings | null = null;

function sanitize(value: unknown): GlassesSettings {
  if (!value || typeof value !== "object") return {};
  const input = value as Record<string, unknown>;
  return {
    fs_enabled: typeof input.fs_enabled === "boolean" ? input.fs_enabled : undefined,
    fs_dir: typeof input.fs_dir === "string" || input.fs_dir === null ? input.fs_dir : undefined,
    network_all: false,
  };
}

export function readSettings(): GlassesSettings {
  if (cache) return cache;
  try {
    cache = existsSync(SETTINGS_PATH)
      ? sanitize(JSON.parse(readFileSync(SETTINGS_PATH, "utf8")))
      : {};
  } catch {
    cache = {};
  }
  return cache;
}

/** Merge, sanitize, and persist. Never throws into the caller. */
export function writeSettings(patch: GlassesSettings): GlassesSettings {
  const next = sanitize({ ...readSettings(), ...patch, network_all: false });
  cache = next;
  try {
    mkdirSync(dirname(SETTINGS_PATH), { recursive: true });
    writeFileSync(SETTINGS_PATH, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  } catch (e: any) {
    console.error(`[argus] could not persist settings to ${SETTINGS_PATH}: ${e?.message ?? e}`);
  }
  return next;
}

export const envSet = (name: string): boolean => {
  const v = process.env[name];
  return v != null && v !== "";
};

export function resolveFlag(envName: string, stored: boolean | undefined, dflt: boolean): boolean {
  if (envSet(envName)) {
    const v = process.env[envName]!;
    return v !== "0" && v.toLowerCase() !== "false";
  }
  return stored ?? dflt;
}
