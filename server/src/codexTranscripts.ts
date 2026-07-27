// Read Codex CLI/Desktop sessions from ~/.codex/sessions.
//
// Codex writes one append-only rollout JSONL per thread. AgentGlass already
// tails Claude Code transcripts, but ignoring this second standard transcript
// tree made active Codex Desktop tasks invisible even while their files grew.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { IngestBody } from "../../shared/types.ts";
import { workspaceRoot, inScope } from "./config.ts";
import { db, insertEvent, RETENTION_DAYS, setSessionTitles, type InsertResult } from "./db.ts";
import { projectRootOf, safeAbs } from "./git.ts";
import { normalize } from "./ingest.ts";

interface ProgressRow {
  path: string;
  session_id: string;
  lines_done: number;
  size: number;
  mtime: number;
}

db.exec(`
CREATE TABLE IF NOT EXISTS transcript_files (
  path TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  source_app TEXT NOT NULL DEFAULT '',
  project_path TEXT NOT NULL DEFAULT '',
  lines_done INTEGER NOT NULL DEFAULT 0,
  size INTEGER NOT NULL DEFAULT 0,
  mtime INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS codex_transcript_files (
  path TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  lines_done INTEGER NOT NULL DEFAULT 0,
  size INTEGER NOT NULL DEFAULT 0,
  mtime INTEGER NOT NULL DEFAULT 0
);
`);

const getProgress = db.query<ProgressRow, [string]>(
  "SELECT * FROM codex_transcript_files WHERE path = ?"
);
const putProgress = db.query(`
  INSERT INTO codex_transcript_files (path, session_id, lines_done, size, mtime)
  VALUES ($path, $sid, $lines, $size, $mtime)
  ON CONFLICT(path) DO UPDATE SET
    session_id = excluded.session_id,
    lines_done = excluded.lines_done,
    size = excluded.size,
    mtime = excluded.mtime
`);
const putTranscript = db.query(`
  INSERT INTO transcript_files (path, session_id, source_app, project_path, lines_done, size, mtime)
  VALUES ($path, $sid, $src, $proj, $lines, $size, $mtime)
  ON CONFLICT(path) DO UPDATE SET
    session_id = excluded.session_id,
    source_app = excluded.source_app,
    project_path = excluded.project_path,
    lines_done = excluded.lines_done,
    size = excluded.size,
    mtime = excluded.mtime
`);

const known = new Map<string, string>();
for (const row of db.query<{ source_app: string; project_path: string }, []>(
  `SELECT DISTINCT source_app, project_path
     FROM transcript_files
    WHERE path LIKE '%/.codex/sessions/%' AND project_path != ''`
).all()) {
  known.set(row.source_app, row.project_path);
}

export function codexKnownProjects(): { source_app: string; path: string }[] {
  return [...known].map(([source_app, path]) => ({ source_app, path }));
}

function sessionsRoot(): string | null {
  const explicit = process.env.AGENTGLASS_CODEX_SESSIONS_DIR?.trim();
  if (explicit) return explicit;
  // Scanner tests point AGENTGLASS_PROJECTS_DIR at a fixture. Do not also read
  // the developer's real Codex history in that process unless a Codex fixture
  // was explicitly supplied.
  if (process.env.AGENTGLASS_PROJECTS_DIR) return null;
  return join(homedir(), ".codex", "sessions");
}

function walk(dir: string, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(path);
  }
  return out;
}

const str = (value: unknown): string | null =>
  typeof value === "string" && value.length ? value : null;

function objectInput(value: unknown): unknown {
  if (typeof value !== "string") return value ?? {};
  try {
    return JSON.parse(value);
  } catch {
    return { value: value.slice(0, 4000) };
  }
}

function outputText(value: unknown): string {
  if (typeof value === "string") return value.slice(0, 4000);
  try {
    return JSON.stringify(value).slice(0, 4000);
  } catch {
    return "";
  }
}

function titleIndex(): Map<string, string> {
  const root = sessionsRoot();
  const result = new Map<string, string>();
  if (!root) return result;
  const path = process.env.AGENTGLASS_CODEX_SESSION_INDEX
    || join(root, "..", "session_index.jsonl");
  let raw = "";
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return result;
  }
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      const row = JSON.parse(line) as Record<string, unknown>;
      const id = str(row.id);
      const title = str(row.thread_name);
      if (id && title) result.set(id, title);
    } catch {}
  }
  return result;
}

interface CodexContext {
  session_id: string;
  source_app: string;
  project_path: string;
  cwd: string;
  model: string | null;
  originator: string | null;
  tools: Map<string, { name: string; input: unknown }>;
}

function common(ctx: CodexContext): Record<string, unknown> {
  return {
    project_path: ctx.project_path,
    ...(ctx.cwd !== ctx.project_path ? { cwd: ctx.cwd } : {}),
    client: ctx.originator || "Codex",
  };
}

/** Map one Codex rollout row to AgentGlass's provider-neutral event contract. */
export function codexLineToBodies(
  row: Record<string, unknown>,
  ctx: CodexContext,
  fallbackTs: number,
): IngestBody[] {
  const payload = row.payload && typeof row.payload === "object"
    ? row.payload as Record<string, unknown>
    : {};
  const ts = Date.parse(String(row.timestamp ?? "")) || fallbackTs;
  const base = {
    source_app: ctx.source_app,
    session_id: ctx.session_id,
    model_name: ctx.model ?? undefined,
    timestamp: ts,
  };

  if (row.type === "session_meta") {
    return [{
      ...base,
      hook_event_type: "SessionStart",
      payload: common(ctx),
    }];
  }

  if (row.type === "turn_context") {
    const model = str(payload.model);
    if (model) ctx.model = model;
    return [];
  }

  if (row.type === "event_msg" && payload.type === "user_message") {
    const prompt = str(payload.message);
    return prompt ? [{
      ...base,
      model_name: ctx.model ?? undefined,
      hook_event_type: "UserPromptSubmit",
      payload: { ...common(ctx), prompt: prompt.slice(0, 4000) },
    }] : [];
  }

  if (row.type === "event_msg" && payload.type === "agent_message") {
    const message = str(payload.message);
    return [{
      ...base,
      model_name: ctx.model ?? undefined,
      hook_event_type: "Stop",
      payload: {
        ...common(ctx),
        ...(message ? { last_assistant_message: message.slice(0, 4000) } : {}),
      },
    }];
  }

  // One Codex thread can contain many tasks. This is the end of the current
  // turn, not the end of the reusable thread, so it maps to the same Stop event
  // Claude transcripts use after an assistant reply.
  if (row.type === "event_msg" && payload.type === "task_complete") {
    return [{
      ...base,
      model_name: ctx.model ?? undefined,
      hook_event_type: "Stop",
      payload: common(ctx),
    }];
  }

  if (row.type === "event_msg" && payload.type === "token_count") {
    const info = payload.info && typeof payload.info === "object"
      ? payload.info as Record<string, unknown>
      : {};
    const last = info.last_token_usage && typeof info.last_token_usage === "object"
      ? info.last_token_usage as Record<string, unknown>
      : null;
    if (!last) return [];
    return [{
      ...base,
      model_name: ctx.model ?? undefined,
      hook_event_type: "Usage",
      payload: {
        ...common(ctx),
        usage: {
          input_tokens: last.input_tokens,
          output_tokens: last.output_tokens,
          cache_creation_input_tokens: last.cache_write_input_tokens,
          input_tokens_details: { cached_tokens: last.cached_input_tokens },
        },
      },
    }];
  }

  if (row.type !== "response_item") return [];
  const kind = str(payload.type);
  const isCall = kind === "function_call" || kind === "custom_tool_call" || kind === "tool_search_call";
  if (isCall) {
    const id = str(payload.call_id) ?? str(payload.id);
    const name = str(payload.name) ?? (kind === "tool_search_call" ? "ToolSearch" : "tool");
    const input = objectInput(payload.arguments ?? payload.input);
    if (id) ctx.tools.set(id, { name, input });
    return [{
      ...base,
      model_name: ctx.model ?? undefined,
      hook_event_type: "PreToolUse",
      payload: {
        ...common(ctx),
        tool_name: name,
        tool_use_id: id,
        tool_input: input,
      },
    }];
  }

  const isOutput = kind === "function_call_output"
    || kind === "custom_tool_call_output"
    || kind === "tool_search_output";
  if (isOutput) {
    const id = str(payload.call_id) ?? str(payload.id);
    const call = id ? ctx.tools.get(id) : undefined;
    return [{
      ...base,
      model_name: ctx.model ?? undefined,
      hook_event_type: "PostToolUse",
      payload: {
        ...common(ctx),
        tool_name: call?.name ?? (kind === "tool_search_output" ? "ToolSearch" : "tool"),
        tool_use_id: id,
        tool_input: call?.input ?? {},
        tool_response: { content: outputText(payload.output) },
      },
    }];
  }

  return [];
}

function projectOf(cwd: string): { source_app: string; project_path: string } {
  const root = projectRootOf(cwd) ?? safeAbs(cwd) ?? cwd;
  return { source_app: basename(root), project_path: root };
}

async function ingestFile(
  path: string,
  from: number,
  onLive: ((result: InsertResult) => void) | null,
  scope: string | null,
  title: string | null,
): Promise<{ session_id: string; source_app: string; project_path: string; lines: number; ingested: number; skipped?: boolean }> {
  const file = Bun.file(path);
  const raw = await file.text();
  const lines = raw.split("\n");
  if (!lines[lines.length - 1]) lines.pop();
  const fallbackId = basename(path, ".jsonl").split("-").slice(-5).join("-");

  let session_id = fallbackId;
  let cwd = "";
  let originator: string | null = null;
  for (const line of lines) {
    if (!line.includes("session_meta")) continue;
    try {
      const row = JSON.parse(line) as Record<string, unknown>;
      const payload = row.payload as Record<string, unknown> | undefined;
      session_id = str(payload?.session_id) ?? str(payload?.id) ?? session_id;
      cwd = str(payload?.cwd) ?? cwd;
      originator = str(payload?.originator) ?? originator;
      break;
    } catch {}
  }
  const project = projectOf(cwd || homedir());
  if (scope && cwd && !inScope(cwd, scope) && !inScope(project.project_path, scope)) {
    return { session_id, ...project, lines: from, ingested: 0, skipped: true };
  }

  const ctx: CodexContext = {
    session_id,
    ...project,
    cwd,
    model: null,
    originator,
    tools: new Map(),
  };
  let ingested = 0;
  const fallbackTs = statSync(path).mtimeMs;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.length > 16 * 1024 * 1024) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const bodies = codexLineToBodies(row, ctx, fallbackTs);
    if (i < from) continue;
    for (const body of bodies) {
      const result = insertEvent(normalize(body));
      onLive?.(result);
      ingested++;
    }
    if (i > from && i % 500 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  if (title) setSessionTitles(session_id, title, null);
  known.set(project.source_app, project.project_path);
  return { session_id, ...project, lines: lines.length, ingested };
}

/** Sweep Codex rollout files once. Called by the shared transcript timer. */
export async function scanCodexOnce(onLive: ((result: InsertResult) => void) | null): Promise<number> {
  const root = sessionsRoot();
  if (!root) return 0;
  const cutoff = RETENTION_DAYS ? Date.now() - RETENTION_DAYS * 86_400_000 : 0;
  const titles = titleIndex();
  const scope = workspaceRoot();
  let total = 0;

  for (const path of walk(root)) {
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(path);
    } catch {
      continue;
    }
    if (cutoff && st.mtimeMs < cutoff) continue;
    const prev = getProgress.get(path);
    if (prev && prev.size === st.size && prev.mtime === Math.floor(st.mtimeMs)) continue;
    const from = prev && st.size >= prev.size ? prev.lines_done : 0;
    try {
      const result = await ingestFile(path, from, onLive, scope, titles.get(prev?.session_id ?? "") ?? null);
      // Do not mark an out-of-scope file complete. A later workspace switch may
      // widen the lens and must still be able to ingest it.
      if (result.skipped) continue;
      const title = titles.get(result.session_id);
      if (title) setSessionTitles(result.session_id, title, null);
      const values = {
        $path: path,
        $sid: result.session_id,
        $src: result.source_app,
        $proj: result.project_path,
        $lines: result.lines,
        $size: st.size,
        $mtime: Math.floor(st.mtimeMs),
      };
      putProgress.run(values);
      putTranscript.run(values);
      total += result.ingested;
    } catch (error) {
      console.error(`[scan/codex] ${path}: ${error instanceof Error ? error.message : error}`);
    }
  }
  return total;
}
