# Glasses for Argus

A local, experimental merge of [Argus](https://github.com/Hunter52302) into
[agentglass](https://github.com/SirAllap/agentglass). Not a release, not a fork
intended to diverge, and nothing has been sent upstream.

See [`../NOTICE.md`](../NOTICE.md) for licensing and provenance.

## The idea in one paragraph

agentglass observes what an agent **reports about itself** — hooks, OTLP spans,
transcripts, tokens, cost — and deliberately never taps the filesystem, so
everything it shows is labeled and semantic. Argus observes the layers
**underneath** that self-report — the OS process table, the socket table, and
filesystem writes — so it can see software that reports nothing at all. Neither
replaces the other. This branch carries Argus in as a clearly separate lens.

## What it adds

**Argus's own cockpit** — the eye icon in the header, or the `ENVIRONMENT`
panel's link. A full surface of its own, deliberately *not* a tab: agentglass's
cockpit answers "what is my fleet doing and what does it cost", and every widget
there assumes a labeled event with a session behind it. Argus asks "what is
running on this machine and what is touching my files", and most of its answers
have no session, no cost, and frequently no name. It contains:

- **live lens controls** — flip the file tier on/off, widen the network tier to
  every process, and move the watched directory, all without a restart
- **stat strip** — runtimes, silent runtimes, actors, connections, unattributed
  writes, distinct paths
- **suspect band** — always visible, red when anything is unclaimed
- **actor lanes** — one per runtime / program / the single unattributed lane
- **raw feed** — every environment event, filterable by tier, focusable by actor

**On agentglass's cockpit** — an `ENVIRONMENT` panel in the right column,
between Radar and Alerts. It is on the *watching* surface deliberately: the first cut put this
only in the workspace overlay, which is where you **do** things (stage a commit,
restart a container), and two keystrokes deep in a work surface it may as well
not have existed.

**Env** (`Ctrl+\` → `e`) — the detail view, in three sections:

| Section | Answers | Fidelity |
|---|---|---|
| AI runtimes present | Which AI runtimes are on this machine, and which are **running while reporting nothing** | presence only |
| Outbound AI connections | Which processes are talking to which AI endpoints — including a browser tab with no local footprint | connection metadata |
| Unclaimed file activity | Writes on disk that no agent reported *(opt-in, off by default)* | fs observed |

**Map** (`Ctrl+\` → `m`) — Argus's original idea: stop reading a log of what
happened and read a **place**. The filesystem is the substrate; agents stand on
it. See below.

The number that justifies the whole tier is **"not reporting"**: a runtime
present in the OS that produced no hook, no span and no transcript. Before this,
those were not merely unlabeled in agentglass — they were absent.

## The map, and why it is better here than in either project

Argus could only ever draw half of its own map well. Its fs watcher proves a
write happened but cannot name the writer, so most nodes were anonymous.
agentglass has the other half and cannot draw a map at all.

In the merge both halves exist, from different sources:

| layer | source | knows the writer? |
|---|---|---|
| **labeled** | agentglass's `PostToolUse` events — `tool_input.file_path` plus a session id | **yes** — a named agent on an exact file |
| **unclaimed** | Argus's fs watcher — writes no tool call accounts for | **no**, and that is the signal |

They are separate fields on every node (`touches` vs `unclaimed`), never summed
into "activity", because collapsing them would discard the exact distinction
this project exists to make. A write is claimed when a tool call named the same
normalized path within 3s — Argus's own correlation rule.

With the fs tier off, the map still works and shows only the labeled layer. The
header says which layers are live, so an empty red layer is never mistaken for
a clean machine.

## The one design decision that matters

Environment observations have **no session, no tokens and no cost**. Writing
them into agentglass's `events` table would require inventing a fake
`session_id`, which would drag them into the cockpit's spend, throughput,
latency and radar queries and quietly corrupt every number on the dashboard.

So they live in their own table (`env_events`), travel over their own WebSocket
frame type (`env`, never `event`), and are joined to agent data **in the UI
only**. No query in the environment tier can perturb a cockpit statistic.

## Fidelity, and refusing to overclaim

Every row carries an explicit ceiling on what it is allowed to mean:

- `presence_only` — a process exists. Says nothing about prompts, tool calls,
  model output, or intent.
- `runtime_api` — a local runtime API named a model it has loaded.
- `connection_metadata` — who talked to which endpoint. **Never contents.**
  Modern traffic is TLS-encrypted; reading it would mean breaking your own
  encryption, which this refuses to do.
- `fs_observed` — a write happened. Author unknown.

The UI follows the same rule. A connection listed because its *destination* is a
known AI endpoint gets a provider chip; one listed only because its *source* is
a known AI process gets the weaker "AI process" label, so `claude →
browser-intake-datadoghq.com` can never read as though Datadog were an AI API.

## Configuration

All off-switches, all optional. Defaults are conservative.

| var | default | meaning |
|---|---|---|
| `GLASSES_ENV_TIER` | `1` | master switch for the whole tier |
| `GLASSES_PROCESS_SCAN` | `1` | OS process-table discovery |
| `GLASSES_PROCESS_POLL_MS` | `5000` | process poll interval |
| `GLASSES_PROCESS_CMDLINE` | `0` | include the **secret-scrubbed** launch command line of *recognized AI processes only* |
| `GLASSES_NETWORK_SCAN` | `1` | outbound socket-table discovery |
| `GLASSES_NETWORK_POLL_MS` | `10000` | socket poll interval |
| `GLASSES_NETWORK_ALL` | `0` | surface **every** connection, not just AI-relevant ones |
| `GLASSES_FS_WATCH` | `0` | **off by default** — filesystem tier (see below) |
| `GLASSES_FS_DIR` | scoped project | root for the filesystem tier |
| `GLASSES_OLLAMA_URL` | `http://127.0.0.1:11434` | Ollama API, for loaded-model names |
| `GLASSES_REVEAL_DISABLED` | `0` | set `1` to refuse all reveal-in-file-manager requests |
| `GLASSES_SERVER` | `http://localhost:4000` | where `tools/argus-record.mjs` ships to |

### Why the filesystem tier ships dark

agentglass's author drew an explicit line: it never taps the filesystem, so that
everything it shows is semantic and labeled. That is a design position, not an
oversight. The fs tier is therefore **off unless you set `GLASSES_FS_WATCH=1`**,
and even then its output stays in `env_events`, unlabeled and clearly marked.

## Endpoints

Reads are unguarded; every mutating route takes the same CSRF origin check as
upstream's. `/env/pty` is intake, so like `/ingest` and the OTLP sinks it is
exempt — the poster is a local CLI with no Origin to present.

```
GET  /env/status          tier + per-sensor state
GET  /env/summary         counts for the header chips
GET  /env/runtimes        discovered runtimes, with the `blind` flag
GET  /env/connections     currently-open AI-relevant connections
GET  /env/files           unclaimed file writes (fs tier only)
GET  /env/map             the merged tree: labeled touches + unclaimed writes
GET  /env/lanes           one lane per actor
GET  /env/suspect         the unclaimed-activity rollup
GET  /env/shells          recorded shells, reassembled
GET  /env/recent          raw env events, ?tier=process|network|file|pty
GET  /env/redlines        loaded rules, or the parse error
GET  /env/gate/killable   held gates that carry a pid
GET  /env/replay/bounds   first/last/count
GET  /env/replay?at=      state folded to that instant

POST /env/watch           enable/disable the fs tier, or move it
POST /env/scope           widen/narrow the network tier
POST /env/redlines/reload re-read redlines.json
POST /env/gate/kill       deny AND stop the process tree
POST /env/pty             shell-recorder intake
```

## Layout, and why it is shaped this way

Everything Argus-derived is confined to one directory plus two new files, so the
diff against upstream is almost entirely additions and the work stays separable:

```
server/src/argus/        vendored sensors + orchestrator + storage
  types.ts               Argus §5 event shape, adapter interface
  paths.ts               cross-OS path normalization
  processes.ts           process-table discovery + Ollama model probe
  network.ts             socket-table discovery + AI endpoint table
  watcher.ts             native recursive fs.watch (opt-in tier)
  store.ts               env_events table + queries
  index.ts               orchestrator; §5 → EnvEvent mapping lives HERE only
  map.ts                 merges labeled tool calls + unclaimed writes into a tree
shared/env.ts            wire types shared with the UI
web/src/components/EnvPanel.tsx     the Env view
web/src/components/MapPanel.tsx     the Map view
web/src/components/Environment.tsx  the cockpit panel
```

Only **eight** upstream files are touched, and five of those by a line or two:

| file | change |
|---|---|
| `server/src/index.ts` | start the tier; seven read-only routes |
| `shared/types.ts` | `"env"`/`"map"` added to `ViewId`; one `WsFrame` member |
| `web/src/lib/api.ts` | six client methods (+ demo stubs) |
| `web/src/App.tsx` | one import; the `Environment` panel in the right column |
| `web/src/components/workspace/views.ts` | two `VIEWS` entries |
| `web/src/components/workspace/Workspace.tsx` | two `BODY` entries |
| `web/src/components/Header.tsx` | the wordmark |
| `web/index.html` | page title + boot splash name |

The last two are branding for the local build only. Upstream's identity is left
alone everywhere it names the **project** — the repo link, the demo badge, the
package name, the config paths, the `AGENTGLASS_*` env vars and the SQLite file
are all untouched.

The sensors add **zero dependencies** — they use only Node builtins, and the
watcher uses native recursive `fs.watch` rather than pulling in chokidar the way
Argus does. That was deliberate: a lockfile change is a much harder thing to ask
an upstream maintainer to accept.

## The control plane: how the two gates compare

agentglass's `/gate` is the better **transport**, and it is not close. Argus's
gate is the better **policy layer**, and has the only **escalation**. They are
not competitors, so the merge keeps `/gate` byte-identical and puts redline
evaluation in front of it.

| | agentglass `/gate` | Argus redlines |
|---|---|---|
| Durability | **Persists to SQLite on arrival; `restoreGates()` rehydrates pending requests after a restart** | In-memory only — a restart silently strands every pending decision |
| Reconnect | **Hook supplies a UUID; `awaitGate(id)` re-attaches or replays a missed outcome** | None — a dropped connection strands the gate |
| History | **`gateHistory()`, with `human` / `timeout` / `restart` resolution recorded** | Events on the bus only |
| Timeout hardening | **Floors at 1s (a negative env value would otherwise auto-allow instantly), clamps to the operator's configured ceiling** | Fixed 120s, no env knob to abuse |
| Policy | None — the hook's `matcher` decides what is dangerous, scattered per project | **Server-side rules: action/target regex, `not_target_prefix` path exemptions, one auditable file** |
| Enforcement | Deny only — the agent is free to try something else next call | **Deny *and* kill the process tree** |
| Automatic escalation | None | **`"kill": true` on a rule → immediate deny+kill, no human wait** |
| pid tracking | Not carried | **Hook sends `os.getppid()`, so there is something to stop** |

**They disagree on failure posture, and both are right for their goal.**
agentglass is fail-**open**: a timeout allows, and the hook exits 0 if the
server is unreachable — an observability tool must never brick the fleet.
Argus is fail-**closed** on timeout (an unattended dangerous action does not
happen) while its hook still fails open if the gate is down. Upstream's
`AGENTGLASS_GATE_FAILCLOSED=1` already offers Argus's posture, so this is a
configuration difference, not a design gap.

**How they compose here.** Rules are evaluated in `/gate` *before* `submitGate`:

```
rule matches + kill:true  → deny and kill NOW, no human wait
rule matches              → hand to agentglass's gate, tagged with the rule
no rule matches           → hand to agentglass's gate unchanged
```

A redline can only ever make the gate **stricter**, never looser, so a project
already using `/gate` keeps its exact behaviour. The pid and matched rule live
in a side table keyed by the gate id (`argus/redlines.ts`) rather than in
`gate.ts`, so upstream's control plane is untouched.

Edit [`redlines.json`](../redlines.json) at the repo root; `POST
/env/redlines/reload` re-reads it. A malformed file is reported in the UI rather
than swallowed — a security control that silently allows everything after a
typo is the failure mode worth designing against.

## The shell recorder

`tools/argus-record.mjs` attaches to a terminal you are **already in**.

agentglass's terminal panel spawns its PTY from the browser, so it can only ever
show a shell it started. That leaves real gaps: a shell open before the
dashboard was, an SSH session on another box, a CI step, a sudo shell, a
container exec. The recorder covers those and nothing else — it is not a second
terminal, and the panel remains the right tool for interactive work.

```bash
node tools/argus-record.mjs                      # wrap your default shell
node tools/argus-record.mjs --agent build -- make release
node tools/argus-record.mjs --server http://desktop:4000   # from another machine
```

Bytes land as a `pty` tier in `env_events` and appear under **recorded shells**
in the Argus cockpit. PTY source per OS: `script` on macOS/Linux, ConPTY via
`node-pty` on Windows when installed, piped capture otherwise. If the server is
unreachable the recorder warns once and the shell keeps working — a recorder
that kills the terminal you are working in is worse than no recorder.

This is the **highest-fidelity tier here**, and the only one that is not
inferred: the others read a process name, a socket, or a write with no author,
while this is the literal output. It is also the only actor whose name is
authoritative, because a human typed it.

## Two map renderers

The Map view has two modes; the choice is remembered.

**`nodes` (default)** — the filesystem as a **place**. A tidy-tree layout gives
every node a real (x, y): depth runs left to right, siblings stack, a parent
sits at the mean of its children. Node radius grows with activity, colour is the
touching agent (or red for unclaimed). Drag to pan, wheel to zoom about the
pointer, `fit` to reframe.

**`tree` (secondary)** — the indented list. Better for scanning a long column of
names, which is the one thing the node map is worse at.

The split exists because trails proved the list could not carry them. A path
drawn over an indented list is a set of straight lines between rows that are
adjacent in the *list* and unrelated in the *filesystem* — it came out as
scribble. Position carried no meaning, so a line between positions carried none
either. In the node map, distance on screen is distance in the tree, so a trail
is finally readable.

## Reveal in the file manager

**Right-click any node** — in either renderer — to open it in Explorer / Finder
/ your file manager. `explorer /select,` and `open -R` select the file itself;
Linux opens the containing directory. Windows' `explorer` exits non-zero even on
success, so its exit code is deliberately ignored.

The guard is worth explaining, because upstream's usual one is wrong here. Every
other write-ish capability honours `inScope()` — one project must not reach into
another. This tier watches the *machine*, so most of what it surfaces is by
definition out of scope, and `inScope()` would refuse exactly the rows the tier
exists to show. Blanket-allowing arbitrary paths is also wrong.

So the guard is **an allowlist of what was already observed**: a path can be
revealed only if the tier has a record of it — an `env_events` row, a tool call
that named it, or being an ancestor directory of one. You can open what Argus
saw, and nothing else. Verified: a known path opens, a `../..` traversal out of
the home directory is refused, and a cross-origin POST gets a 403. Argv arrays throughout, never a
shell string, so a path containing quotes or `&` cannot become a command.
Disable entirely with `GLASSES_REVEAL_DISABLED=1`.

## Trails

Argus drew agent trails on a spatial map where every node had an (x, y). Here
the tree is an indented list, so a node's position is its row — enough to draw
the same thing: a dashed polyline through the files a session touched in order,
oldest faintest, with a pulsing marker on where it is now. x follows the node's
own indentation, so the path visibly moves in and out of directories.

Click a session in the map's right rail to follow only its trail.

Row height is **measured from the DOM**, never assumed. Rows are 24px at the
default zoom, but this app has a user-adjustable UI scale — and a trail drawn
against the wrong row height drifts a couple of pixels per row, which over a few
hundred rows puts the marker on an entirely different file.

## Replay

`env_events` is append-only and nothing is ever rewritten, so "what was true at
T" is just the fold of every row with `ts <= T` — no snapshots, no history
table. The scrubber in the Argus cockpit is what turns the tier from a live feed
into an investigation tool: *that Ollama appeared some time this afternoon —
when, and what else happened in that minute?* is unanswerable from a live view.

## An observer must not watch its own recording

The first time the fs tier ran over `$HOME` it reported thousands of
unattributed writes, nearly all of them `agentglass.db-wal`. Every filesystem
event is persisted to SQLite, SQLite writes its WAL, the WAL is a file inside
the watched tree, and that write produces another event — an unbounded feedback
loop that drowned the exact signal the suspect band exists to show.

`startWatcher` therefore takes an `exclude` list, and the tier passes
`db.filename` (read at runtime, so a relocated `AGENTGLASS_DB` is still covered;
the bare path prefix-matches the `-wal` and `-shm` siblings). Any future sink
that writes inside a watched tree needs the same treatment.

## Known limits

- **Blindness is matched by provider, not by process.** Nothing in the OS
  process table carries a session id, so a second *unwired* Claude Code running
  beside a wired one will look attributed. Tightening this needs the agent to
  volunteer its own pid — which the Claude Code hook can do, and which is the
  obvious next step.
- **The signature registry is finite.** An unrecognized program will not appear
  as a runtime. Add signatures to `SIGNATURES` in `argus/processes.ts` and
  endpoints to `AI_ENDPOINTS` in `argus/network.ts`; no other code changes.
- **Hostnames are best-effort.** Windows reads the OS DNS cache; elsewhere it is
  reverse DNS. CDNs and shared IPs blur attribution.
- **The Windows process scan is not free.** It spawns PowerShell per poll, hence
  the 5s/10s defaults rather than Argus's 2s/4s.
- **Linux fs tier.** Where recursive `fs.watch` is unavailable, the tier reports
  itself unavailable rather than adding a dependency.
- **Live toggles do not persist.** Flipping the file tier or the network scope
  in the Argus cockpit lasts until the server restarts, then the `GLASSES_*`
  env vars win again. Set the env vars for a durable choice.
- **Kill needs a pid, and only the gate hook has one.** `hooks/gate_event.py`
  now sends `os.getppid()`. A gated call from anything else shows `deny & kill`
  disabled, because there is genuinely nothing to stop.
- **Kill is best-effort on permissions.** `taskkill /T /F` on Windows, SIGKILL
  leaves-up on POSIX. A process owned by another user simply fails, and the
  result lists it under `failed` rather than claiming success.
- **The shell recorder does not replace the terminal panel** and is not meant
  to. The panel is better for interactive work; the recorder exists only for
  shells it cannot reach (see above).
- **Piped fallback loses TTY fidelity.** Without `node-pty` on Windows there is
  no ConPTY, so raw mode and cursor control are not faithful — every byte of
  output is still captured. `bun add node-pty` for full fidelity.
- **Trails only draw steps that are visible.** A path can leave the tree (a file
  outside the root, or one past the node cap), and those steps are skipped
  rather than faked — which is why a trail can appear to jump.
