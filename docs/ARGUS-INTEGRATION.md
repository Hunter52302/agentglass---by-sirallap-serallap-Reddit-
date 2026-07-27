# agentglass Argus integration

A local, experimental integration of Argus into AgentGlass. See
[`ARGUS-IDENTITY.md`](ARGUS-IDENTITY.md) for the controlling product boundary and
[`../NOTICE.md`](../NOTICE.md) for licensing and provenance.

## Identity

AgentGlass explains what agents report: sessions, hooks, OTLP spans, tool calls,
tokens, cost, and declared edits. Argus is the passive runtime-truth layer beneath
that report. It exposes recognized agent processes, process trees, attached shells
and PTYs, relevant network metadata, and opt-in filesystem effects.

Argus has one narrow intervention: the operator may stop the agent-associated
process tree tied to a redline-matched held request. Matching never kills
automatically. AgentGlass's existing gate continues to own ordinary approval and
denial. A non-redlined gate is never killable through Argus.

Argus also preserves an operator-expanded diagnostic mode. The user may deliberately
widen network visibility to every socket-table process or point filesystem observation
at a parent directory, drive root, or `/`. These modes are off by default and must be
presented as machine-wide observations, not as proof that an agent caused them.

## Core safety rules

- Environment rows remain in `env_events`, separate from AgentGlass semantic events.
- Filesystem observation is off by default.
- Network observation defaults to AI/agent-relevant connections.
- Whole-network and broad-filesystem modes require an explicit operator choice.
- Network results are labeled `OS-visible`, `limited`, or `unavailable`. Empty
  limited/unavailable results never mean another process made no connection.
- Filesystem observation never reads file contents. Rows persist paths and actions
  only; startup also strips content-bearing samples written by legacy builds.
- Unattributed means unknown, not malicious.
- Shell recording requires explicit attachment or agent ownership.
- Process stopping is limited to agent-associated, redline-matched held requests.
- Argus refuses PID 0/1, itself, and its parent.
- Privileged watchdog and endpoint-security capabilities are permanently outside
  Argus, not deferred features or extension points.

## Main surfaces

- **Argus cockpit:** runtime/process lanes, shell recordings, scoped or expanded file
  activity, network metadata, redlines, replay, and redline-kill control.
- **Environment panel:** compact AgentGlass-side view of Argus state.
- **Map:** declared agent touches and observed filesystem effects remain separate.
- **Shell recorder:** attaches to an existing local or remote terminal, including SSH,
  WSL, PuTTY/plink-style workflows.
- **Redlines:** operator-owned matches evaluated before AgentGlass's gate. The only
  direct OS action is stopping the matched agent-associated process tree when
  the operator explicitly clicks the kill control.

## Configuration defaults

| Variable | Default | Meaning |
|---|---:|---|
| `GLASSES_ENV_TIER` | `1` | Argus environment layer available |
| `GLASSES_PROCESS_SCAN` | `1` | recognized agent/runtime discovery |
| `GLASSES_PROCESS_CMDLINE` | `0` | include scrubbed recognized-runtime commands |
| `GLASSES_NETWORK_SCAN` | `1` | agent/AI-relevant network metadata |
| `GLASSES_NETWORK_ALL` | `0` | opt into every represented host connection |
| `GLASSES_FS_WATCH` | `0` | opt into filesystem observation |
| `GLASSES_FS_DIR` | workspace | selected filesystem root; may be widened explicitly |

## Verification status

The original integration baseline passed 585 tests with 32 capability skips on
Windows and all 617 tests on Linux. Changes made after that baseline require a fresh
local or CI test and build run before this draft should be considered merge-ready.
