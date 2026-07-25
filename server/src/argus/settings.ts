// AgentGlass Argus integration — persisted lens settings.
//
// MIT © 2026 Zac Rieger. See NOTICE.md.
//
// Persist only choices the operator made deliberately in the Argus UI. Launch
// environment variables remain authoritative.

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
  /** False = AI/agent-relevant connections; true = explicit whole-network lens. */
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
    cache = {};
  }
  return cache!;
}

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
