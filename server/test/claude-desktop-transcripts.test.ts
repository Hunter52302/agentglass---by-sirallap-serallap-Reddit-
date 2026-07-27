import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fixture = mkdtempSync(join(tmpdir(), "agx-claude-desktop-"));
const root = join(fixture, "local-agent-mode-sessions");
const run = join(root, "account", "project", "local_task");
mkdirSync(run, { recursive: true });

process.env.AGENTGLASS_PROJECTS_DIR = root;
process.env.AGENTGLASS_DB ||= join(fixture, "claude-desktop.db");

const SID = "desktop-cowork-session";
const audit = join(run, "audit.jsonl");
let cwd = join(fixture, "project");
let db: typeof import("../src/db.ts");
let scanner: typeof import("../src/transcripts.ts");

beforeAll(async () => {
  db = await import("../src/db.ts");
  const scope = (await import("../src/config.ts")).workspaceRoot();
  if (scope) cwd = join(scope, "agx-claude-desktop-fixture");
  mkdirSync(cwd, { recursive: true });
  const stamp = new Date().toISOString();
  writeFileSync(audit, [
    JSON.stringify({
      type: "system", subtype: "init", cwd, session_id: SID,
      model: "claude-opus-4-8", timestamp: stamp, _audit_timestamp: stamp,
    }),
    JSON.stringify({
      type: "user", cwd, session_id: SID, _audit_timestamp: stamp,
      message: { role: "user", content: "inspect the project" },
    }),
    JSON.stringify({
      type: "assistant", cwd, session_id: SID, _audit_timestamp: stamp,
      message: {
        id: "msg-1", role: "assistant", model: "claude-opus-4-8",
        content: [{ type: "text", text: "Done." }],
        usage: { input_tokens: 30, output_tokens: 5 },
      },
    }),
  ].join("\n") + "\n");
  scanner = await import("../src/transcripts.ts");
});

afterAll(() => {
  delete process.env.AGENTGLASS_PROJECTS_DIR;
  if (!db) return;
  db.db.run("DELETE FROM events WHERE session_id = ?", [SID]);
  db.db.run("DELETE FROM sessions WHERE session_id = ?", [SID]);
  db.db.run("DELETE FROM transcript_files WHERE session_id = ?", [SID]);
});

describe("Claude Desktop Cowork discovery", () => {
  test("accepts audit session_id and audit timestamps", async () => {
    expect(await scanner.scanOnce(null)).toBe(2);
    const events = db.db.query<{ hook_event_type: string }, [string]>(
      "SELECT hook_event_type FROM events WHERE session_id = ? ORDER BY id"
    ).all(SID);
    expect(events.map((event) => event.hook_event_type)).toEqual([
      "UserPromptSubmit", "Stop",
    ]);
    expect(
      db.db.query<{ model_name: string | null }, [string]>(
        "SELECT model_name FROM sessions WHERE session_id = ?"
      ).get(SID)?.model_name
    ).toBe("claude-opus-4-8");
  });
});
