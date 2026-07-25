// Bind the test database BEFORE any test module can load db.ts.
//
// db.ts opens its SQLite file at import and never reopens it, so the first
// module to pull it in decides the database for the entire `bun test` process.
// That is easy to get wrong transitively: evidence.test.ts imports evidence.ts,
// which imports transcripts.ts, which imports db.ts — all at module load, long
// before any test body has set AGENTGLASS_DB. With no value set, db.ts resolves
// its default and the whole suite runs against the DEVELOPER'S REAL DATABASE.
//
// Two consequences, both bad:
//
//   * tests write their fixtures into the user's own history, and
//   * they read it back. open-tool-memo asserts that a freshly inserted
//     PreToolUse appears in openToolCalls(); against a real database with 220
//     already-open calls it never did, because that query is
//     `ORDER BY timestamp ASC LIMIT 200` and the new row sorts last. The test
//     failed only when some earlier file happened to import db.ts first, so it
//     looked like flakiness and was really a data leak.
//
// A preload runs before every test module, which is the only place early enough
// to close this. `??=` so a file that deliberately points at its own fixture
// database still wins.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandbox = mkdtempSync(join(tmpdir(), "agx-test-sandbox-"));

// The database. Nothing in the suite should ever reach the real one.
process.env.AGENTGLASS_DB ??= join(sandbox, "test.db");

// The config directory, for the same reason: config.ts resolves its path from
// XDG_CONFIG_HOME, and an unset value reads the developer's own config.json —
// so a `root` in it would silently scope every suite that reads scoped data.
process.env.XDG_CONFIG_HOME ??= sandbox;

// Never sweep the real ~/.claude/projects: the scanner would ingest the
// developer's actual sessions into the test database, and a slow sweep of a
// large history would look like a hanging test.
process.env.AGENTGLASS_PROJECTS_DIR ??= join(sandbox, "projects");
