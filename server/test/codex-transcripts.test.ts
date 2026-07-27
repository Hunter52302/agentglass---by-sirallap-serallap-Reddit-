import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fixture = mkdtempSync(join(tmpdir(), "agx-codex-scan-"));
const sessions = join(fixture, "sessions");
const day = join(sessions, "2026", "07", "27");
mkdirSync(day, { recursive: true });

process.env.AGENTGLASS_CODEX_SESSIONS_DIR = sessions;
process.env.AGENTGLASS_CODEX_SESSION_INDEX = join(fixture, "session_index.jsonl");
process.env.AGENTGLASS_DB ||= join(fixture, "codex.db");

const SID = "019fa281-916b-70e1-98e1-73706032ee5b";
const transcript = join(day, `rollout-2026-07-27T02-37-08-${SID}.jsonl`);
let cwd = join(fixture, "project");
let db: typeof import("../src/db.ts");
let scanner: typeof import("../src/codexTranscripts.ts");

const row = (type: string, payload: Record<string, unknown>, second: number) =>
  JSON.stringify({ timestamp: new Date(Date.now() - 30_000 + second * 1000).toISOString(), type, payload });

beforeAll(async () => {
  db = await import("../src/db.ts");
  const scope = (await import("../src/config.ts")).workspaceRoot();
  if (scope) cwd = join(scope, "agx-codex-fixture");
  mkdirSync(cwd, { recursive: true });
  scanner = await import("../src/codexTranscripts.ts");

  writeFileSync(process.env.AGENTGLASS_CODEX_SESSION_INDEX!, JSON.stringify({
    id: SID,
    thread_name: "Fix live session detection",
    updated_at: new Date().toISOString(),
  }) + "\n");
  writeFileSync(transcript, [
    row("session_meta", {
      id: SID, session_id: SID, cwd, originator: "Codex Desktop", model_provider: "openai",
    }, 0),
    row("turn_context", { cwd, model: "gpt-5.6-sol" }, 1),
    row("event_msg", { type: "user_message", message: "find every live task" }, 2),
    row("response_item", {
      type: "function_call", id: "fc-1", call_id: "call-1", name: "exec_command",
      arguments: JSON.stringify({ cmd: "pwd" }),
    }, 3),
    row("response_item", {
      type: "function_call_output", id: "out-1", call_id: "call-1", output: "ok",
    }, 4),
    row("event_msg", {
      type: "token_count",
      info: {
        last_token_usage: {
          input_tokens: 100, cached_input_tokens: 40, cache_write_input_tokens: 5,
          output_tokens: 20, total_tokens: 125,
        },
      },
    }, 5),
    row("event_msg", { type: "task_complete" }, 6),
  ].join("\n") + "\n");
});

afterAll(() => {
  delete process.env.AGENTGLASS_CODEX_SESSIONS_DIR;
  delete process.env.AGENTGLASS_CODEX_SESSION_INDEX;
  if (!db) return;
  db.db.run("DELETE FROM events WHERE session_id = ?", [SID]);
  db.db.run("DELETE FROM sessions WHERE session_id = ?", [SID]);
  db.db.run("DELETE FROM transcript_files WHERE session_id = ?", [SID]);
  db.db.run("DELETE FROM codex_transcript_files WHERE session_id = ?", [SID]);
});

describe("Codex transcript discovery", () => {
  test("ingests a live rollout, tools, usage, and title", async () => {
    expect(await scanner.scanCodexOnce(null)).toBe(6);

    const events = db.db.query<{
      hook_event_type: string;
      tool_name: string | null;
      input_tokens: number;
      cache_read_tokens: number;
    }, [string]>(
      `SELECT hook_event_type, tool_name, input_tokens, cache_read_tokens
         FROM events WHERE session_id = ? ORDER BY id`
    ).all(SID);
    expect(events.map((event) => event.hook_event_type)).toEqual([
      "SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Usage", "Stop",
    ]);
    expect(events.find((event) => event.hook_event_type === "PostToolUse")?.tool_name)
      .toBe("exec_command");
    const usage = events.find((event) => event.hook_event_type === "Usage");
    expect(usage?.input_tokens).toBe(60);
    expect(usage?.cache_read_tokens).toBe(40);

    const session = db.db.query<{
      model_name: string | null;
      custom_title: string | null;
      project_path: string | null;
    }, [string]>("SELECT model_name, custom_title, project_path FROM sessions WHERE session_id = ?").get(SID);
    expect(session?.model_name).toBe("gpt-5.6-sol");
    expect(session?.custom_title).toBe("Fix live session detection");
    expect(session?.project_path).toBeTruthy();
  });

  test("tails only new records", async () => {
    expect(await scanner.scanCodexOnce(null)).toBe(0);
    appendFileSync(transcript, row("event_msg", { type: "user_message", message: "one more" }, 7) + "\n");
    expect(await scanner.scanCodexOnce(null)).toBe(1);
    expect(
      db.db.query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM events WHERE session_id = ? AND hook_event_type = 'UserPromptSubmit'"
      ).get(SID)?.n
    ).toBe(2);
  });
});
