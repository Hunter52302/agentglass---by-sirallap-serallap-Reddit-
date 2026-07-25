# Glasses for Argus

A local, experimental integration of Argus into AgentGlass. See
[`ARGUS-IDENTITY.md`](ARGUS-IDENTITY.md) for the controlling product boundary and
[`../NOTICE.md`](../NOTICE.md) for licensing and provenance.

## Identity

AgentGlass explains what agents report: sessions, hooks, OTLP spans, tool calls,
tokens, cost, and declared edits. Argus is the runtime-integrity and intervention
layer beneath that report. It exposes recognized agent processes, process trees,
attached shells and PTYs, relevant network metadata, and opt-in filesystem effects.
It can deny and contain agent-associated tasks that cross explicit redlines.

Argus also preserves an operator-expanded diagnostic mode. The user may deliberately
widen network visibility to every socket-table process or point filesystem observation
at a parent directory, drive root, or `/`. These modes are off by default and must be
presented as machine-wide observations, not as proof that an agent caused them.

## Core safety rules

- Environment rows remain in `env_events`, separate from AgentGlass semantic events.
- Filesystem observation is off by default.
- Network observation defaults to AI/agent-relevant connections.
- Whole-network and broad-filesystem modes require an explicit operator choice.
- Unattributed means unknown, not malicious.
- Shell recording requires explicit attachment or agent ownership.
- Process containment is limited to agent-associated, gated, redline-matched, attached,
  or manually confirmed tasks.
- Argus refuses PID 0/1, itself, and its parent.
- No boot, driver, registry-persistence, packet-content, keylogging, screen capture,
  antivirus, EDR, or complete-host-protection claims are made.

## Main surfaces

- **Argus cockpit:** runtime/process lanes, shell recordings, scoped or expanded file
  activity, network metadata, redlines, replay, and containment controls.
- **Environment panel:** compact AgentGlass-side view of Argus state.
- **Map:** declared agent touches and observed filesystem effects remain separate.
- **Shell recorder:** attaches to an existing local or remote terminal, including SSH,
  WSL, PuTTY/plink-style workflows.
- **Redlines:** additive policy evaluated before AgentGlass's gate; matching rules may
  deny or deny-and-stop when explicitly configured.

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
