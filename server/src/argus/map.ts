// AgentGlass Argus integration — the filesystem map.
//
// MIT © 2026 Zac Rieger. See NOTICE.md.
//
// ─────────────────────────────────────────────────────────────────────────────
// Argus's map put the filesystem tree on screen as the SUBSTRATE and placed
// agents on it — you read position, not a log line. Argus could only ever draw
// half of it well: its fs watcher proves a write happened but cannot name who
// wrote it, so most of its map was unlabeled.
//
// In this merge both halves exist, and they come from different places:
//
//   labeled   — agentglass's own tool calls. A PostToolUse for Edit/Write/Read
//               carries `tool_input.file_path` AND a session id, so we can put
//               a NAMED agent on an exact file. Argus never had this.
//   unclaimed — Argus's fs watcher. A write in the tree that no tool call
//               accounts for. agentglass is blind to these by design.
//
// Drawn together, the map answers the question neither project answers alone:
// "who is working where, and what is touching my files that nobody admits to?"
//
// Correlation is the same rule Argus uses — same normalized path, close in
// time. A watcher event within CLAIM_WINDOW_MS of a tool call for that path is
// that tool call's own write showing up on disk, not a mystery.

import { db, scopeClause } from "../db.ts";
import { isUnderPath, scopeRoots, workspaceRoot } from "../config.ts";
import { normalizePath } from "./paths";
import { envTierStatus } from "./index";

/** How close in time a disk write has to be to a tool call to be considered
 *  the same act. Argus uses 2s; a little slack covers a slow flush without
 *  letting a genuinely unattributed write hide behind an unrelated call. */
const CLAIM_WINDOW_MS = 3000;

const TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit", "Read"];

export interface MapNode {
  path: string;
  name: string;
  depth: number;
  kind: "dir" | "file";
  /** Tool calls that named this exact path. */
  touches: number;
  /** Disk writes here that no tool call accounts for. The Argus half. */
  unclaimed: number;
  /** Sessions that touched this path, most recent first. */
  agents: string[];
  last_ts: number;
  last_tool: string | null;
}

export interface MapAgent {
  session_id: string;
  source_app: string;
  /** Volunteered by the reporting hook; never inferred from proximity. */
  pid: number | null;
  /** Most recently touched path — the agent's position on the tree. */
  current: string | null;
  /** Tool that produced the current position. */
  current_tool: string | null;
  /** Recent positions, oldest first, for a movement trail. */
  trail: string[];
  touches: number;
  last_ts: number;
}

export interface FsMap {
  root: string | null;
  nodes: MapNode[];
  agents: MapAgent[];
  /** True when the node cap clipped the tree — never silently truncated. */
  truncated: boolean;
  total_nodes: number;
  /** Whether the unclaimed layer can have any data at all. */
  fs_tier_enabled: boolean;
  unclaimed_total: number;
}

interface Touch {
  path: string;
  session_id: string;
  source_app: string;
  tool: string;
  ts: number;
}

export function compareMapNodes(a: MapNode, b: MapNode): number {
  return a.kind !== b.kind
    ? (a.kind === "dir" ? -1 : 1)
    : a.name.localeCompare(b.name);
}

/** Longest common directory prefix, so the tree starts where the work is
 *  rather than at a drive root with fifteen empty levels above it. */
function commonRoot(paths: string[]): string | null {
  if (!paths.length) return null;
  let parts = paths[0].split("/");
  for (const p of paths.slice(1)) {
    const seg = p.split("/");
    let i = 0;
    while (i < parts.length && i < seg.length && parts[i] === seg[i]) i++;
    parts = parts.slice(0, i);
    if (!parts.length) break;
  }
  // Never end on a file: the last segment of a single path is the file itself.
  if (paths.length === 1) parts = parts.slice(0, -1);
  return parts.join("/") || null;
}

export function buildMap({
  limit = 600,
  nodeCap = 400,
  scope: scopeRoot,
}: {
  limit?: number;
  nodeCap?: number;
  /** Explicit null is useful for whole-machine callers and isolated tests. */
  scope?: string | null;
} = {}): FsMap {
  // `undefined` means use the cockpit's live workspace; explicit null means
  // whole-machine. Keep that distinction for both halves of the map.
  const activeScope = scopeRoot === undefined ? workspaceRoot() : scopeRoot;
  const scope = scopeClause(activeScope);
  const activeRoots = activeScope ? scopeRoots(activeScope) : [];

  // ── labeled layer: agentglass's own tool calls ───────────────────────────
  const placeholders = TOOLS.map(() => "?").join(",");
  const rows = db
    .query(
      `SELECT timestamp, session_id, source_app, tool_name,
              json_extract(payload, '$.tool_input.file_path') AS file_path
         FROM events
        WHERE hook_event_type = 'PostToolUse'
          AND tool_name IN (${placeholders})
          AND json_extract(payload, '$.tool_input.file_path') IS NOT NULL
          ${scope.clause}
        ORDER BY timestamp DESC, id DESC
        LIMIT ?`
    )
    .all(...TOOLS, ...scope.args, limit) as any[];

  const touches: Touch[] = [];
  for (const r of rows) {
    const p = normalizePath(String(r.file_path));
    if (!p) continue;
    touches.push({
      path: p,
      session_id: r.session_id,
      source_app: r.source_app,
      tool: r.tool_name,
      ts: r.timestamp,
    });
  }

  // ── unclaimed layer: Argus's fs watcher ──────────────────────────────────
  const fsRows = db
    .query(
      `SELECT ts, path, action FROM env_events
        WHERE tier = 'file' AND path IS NOT NULL
        ORDER BY ts DESC LIMIT ?`
    )
    .all(limit) as any[];

  // Index tool-call times per path so the claim test is a lookup, not a scan.
  const touchTimes = new Map<string, number[]>();
  for (const t of touches) {
    const arr = touchTimes.get(t.path);
    if (arr) arr.push(t.ts);
    else touchTimes.set(t.path, [t.ts]);
  }

  const unclaimedByPath = new Map<string, number>();
  let unclaimedTotal = 0;
  for (const r of fsRows) {
    const p = normalizePath(String(r.path));
    if (!p) continue;
    // env_events retains observations from earlier lenses. A scoped cockpit
    // must not pull old writes from a retired project back into its live map.
    if (activeRoots.length && !activeRoots.some((root) => isUnderPath(p, root))) continue;
    const times = touchTimes.get(p);
    const claimed = times?.some((t) => Math.abs(t - r.ts) <= CLAIM_WINDOW_MS);
    if (claimed) continue;
    unclaimedByPath.set(p, (unclaimedByPath.get(p) ?? 0) + 1);
    unclaimedTotal++;
  }

  // ── build the tree ───────────────────────────────────────────────────────
  const allPaths = [...new Set([...touches.map((t) => t.path), ...unclaimedByPath.keys()])];
  const root = commonRoot(allPaths);

  const files = new Map<string, MapNode>();
  const ensure = (path: string, kind: "dir" | "file"): MapNode => {
    let n = files.get(path);
    if (!n) {
      n = {
        path,
        name: path.split("/").pop() || path,
        depth: 0,
        kind,
        touches: 0,
        unclaimed: 0,
        agents: [],
        last_ts: 0,
        last_tool: null,
      };
      files.set(path, n);
    }
    return n;
  };

  for (const t of touches) {
    const n = ensure(t.path, "file");
    n.touches++;
    if (t.ts > n.last_ts) {
      n.last_ts = t.ts;
      n.last_tool = t.tool;
    }
    if (!n.agents.includes(t.session_id)) n.agents.push(t.session_id);
  }
  for (const [p, count] of unclaimedByPath) {
    const n = ensure(p, "file");
    n.unclaimed += count;
  }

  // Materialize ancestor directories up to the root, so the tree is connected.
  for (const p of [...files.keys()]) {
    let cur = p;
    for (let guard = 0; guard < 64; guard++) {
      const parent = cur.slice(0, cur.lastIndexOf("/"));
      if (!parent || parent === cur) break;
      if (root && !(parent === root || parent.startsWith(root + "/"))) break;
      const d = ensure(parent, "dir");
      d.kind = "dir";
      cur = parent;
      if (parent === root) break;
    }
  }

  // Roll child activity up into directories, so a collapsed branch still shows
  // that something happened inside it.
  const sorted = [...files.values()].sort((a, b) => b.path.length - a.path.length);
  for (const n of sorted) {
    if (n.kind !== "file") continue;
    let cur = n.path;
    for (let guard = 0; guard < 64; guard++) {
      const parent = cur.slice(0, cur.lastIndexOf("/"));
      if (!parent || parent === cur) break;
      const d = files.get(parent);
      if (!d) break;
      d.touches += n.touches;
      d.unclaimed += n.unclaimed;
      for (const a of n.agents) if (!d.agents.includes(a)) d.agents.push(a);
      if (n.last_ts > d.last_ts) d.last_ts = n.last_ts;
      cur = parent;
      if (parent === root) break;
    }
  }

  // Pre-order depth-first, directories before files, each group alphabetical —
  // Argus's "tidy indented tree". Predictable beats clever: a node stays where
  // it was between refreshes.
  const rootPrefix = root ? root + "/" : "";
  const inTree = [...files.values()].filter((n) => !root || n.path === root || n.path.startsWith(rootPrefix));
  const byParent = new Map<string, MapNode[]>();
  for (const n of inTree) {
    if (n.path === root) continue;
    const parent = n.path.slice(0, n.path.lastIndexOf("/"));
    const arr = byParent.get(parent);
    if (arr) arr.push(n);
    else byParent.set(parent, [n]);
  }
  for (const arr of byParent.values()) {
    arr.sort(compareMapNodes);
  }

  const out: MapNode[] = [];
  const walk = (path: string, depth: number) => {
    for (const child of byParent.get(path) ?? []) {
      child.depth = depth;
      out.push(child);
      if (child.kind === "dir") walk(child.path, depth + 1);
    }
  };
  if (root) {
    walk(root, 0);
  } else {
    // Whole-machine activity is a forest, not a flat list. `commonRoot`
    // deliberately returns null when paths only share the filesystem root
    // (for example /Users and /private). Start at every node whose parent is
    // outside the observed set, then use the same pre-order traversal as a
    // scoped tree. Besides restoring meaningful depth, this keeps ancestors
    // ahead of descendants when the node cap slices the result.
    const forestRoots = inTree
      .filter((n) => {
        const parent = n.path.slice(0, n.path.lastIndexOf("/"));
        return !files.has(parent);
      })
      .sort(compareMapNodes);
    for (const forestRoot of forestRoots) {
      forestRoot.depth = 0;
      out.push(forestRoot);
      if (forestRoot.kind === "dir") walk(forestRoot.path, 1);
    }
  }

  const truncated = out.length > nodeCap;

  // ── agents, positioned ───────────────────────────────────────────────────
  const pidBySession = new Map<string, number>();
  try {
    const pidRows = db.query(`
      SELECT p.session_id, p.pid
        FROM env_agent_pids p
        JOIN (
          SELECT session_id, MAX(last_seen) AS last_seen
            FROM env_agent_pids
           GROUP BY session_id
        ) latest
          ON latest.session_id = p.session_id AND latest.last_seen = p.last_seen
       ORDER BY p.last_seen DESC
    `).all() as Array<{ session_id: string; pid: number }>;
    for (const row of pidRows) {
      if (!pidBySession.has(row.session_id)) pidBySession.set(row.session_id, row.pid);
    }
  } catch {
    // PID evidence is optional. Keep the map available if a partial/older
    // database has not created the passive-tier table yet.
  }

  const agentMap = new Map<string, MapAgent>();
  // touches are newest-first, so walk backwards to build the trail oldest-first
  for (let i = touches.length - 1; i >= 0; i--) {
    const t = touches[i];
    let a = agentMap.get(t.session_id);
    if (!a) {
      a = {
        session_id: t.session_id,
        source_app: t.source_app,
        pid: pidBySession.get(t.session_id) ?? null,
        current: null,
        current_tool: null,
        trail: [],
        touches: 0,
        last_ts: 0,
      };
      agentMap.set(t.session_id, a);
    }
    a.touches++;
    if (a.trail[a.trail.length - 1] !== t.path) a.trail.push(t.path);
    if (a.trail.length > 12) a.trail.shift();
    if (t.ts >= a.last_ts) {
      a.last_ts = t.ts;
      a.current = t.path;
      a.current_tool = t.tool;
    }
  }

  return {
    root,
    nodes: out.slice(0, nodeCap),
    agents: [...agentMap.values()].sort((a, b) => b.last_ts - a.last_ts),
    truncated,
    total_nodes: out.length,
    fs_tier_enabled: envTierStatus().file.enabled,
    unclaimed_total: unclaimedTotal,
  };
}
