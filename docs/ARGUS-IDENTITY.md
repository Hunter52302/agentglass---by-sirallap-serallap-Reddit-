# Argus identity boundary

Argus has exactly two identities. They are exhaustive, not milestones toward a
third identity.

## Identity 1: passive runtime truth

Argus passively reports what the operating system exposes about recognized agent
runtimes, their process trees, attached shells, relevant network metadata, and
opt-in filesystem effects.

Observations retain their real limits:

- process presence does not reveal prompts, tool calls, output, or intent;
- socket metadata does not reveal packet contents, browser tabs, or purpose;
- a filesystem event without a writer PID remains `writer unknown`;
- temporal proximity is context, never proof of causation;
- restricted or failed sensors remain visibly `limited` or `unavailable`.

Argus does not gain privileges to erase these limits. Honest uncertainty is part
of its identity.

### Single intervention exception: redline kill

Argus has one direct operating-system intervention: stop an agent-associated
process tree that matched an operator-owned redline.

The exception is narrow:

1. a proposed action must match a loaded redline;
2. the request must carry a valid actor PID;
3. the PID must be tied to that held request;
4. the operator must explicitly click `deny & kill`;
5. PID 0/1, Argus itself, and Argus's parent remain unkillable.

An ordinary held gate is not killable merely because it carries a PID. Argus has
no arbitrary PID-kill surface and no autonomous response to unrelated activity.
AgentGlass's existing gate continues to own ordinary approval and denial.
Redline matching never kills automatically.

## Identity 2: declared-vs-observed development provenance

Argus keeps agent declarations beside machine observations without collapsing
them:

- AgentGlass reports which agent declared a tool action or file touch.
- Argus reports which path, process, socket, or attached shell the machine
  exposed.
- A declaration plus a nearby observation is corroboration, not proof that one
  caused the other.
- An observation with no declaration remains visible and unattributed.
- Environment observations remain separate from sessions, tokens, costs,
  prompts, and tool-call statistics.

The declared-vs-observed gap is a product result, not a defect to hide through
guessed attribution.

## Operator-expanded lens is a mode, not another identity

The user may deliberately widen passive observation:

- network scope may include every process represented in the readable socket
  table;
- filesystem scope may be a parent directory, drive root, or `/`;
- an existing local, SSH, WSL, PuTTY/plink, or other terminal may be explicitly
  attached to the shell recorder.

Expansion changes scope, not authority. It does not add privileges, enforcement,
content capture, or agent attribution. The UI must label it machine-wide or
operator-expanded.

## Outside Argus permanently

A privileged watchdog, sandbox, endpoint agent, antivirus, EDR, or host
enforcement platform is a different project and program. It is not a deferred
Argus identity, optional Argus mode, future Argus tier, or roadmap destination.

Argus must not add bridge work toward that product, including:

- kernel, driver, minifilter, eBPF, Endpoint Security, or packet-filter
  components;
- boot, service, daemon, registry, scheduled-task, or persistence monitoring;
- process sandboxing, filesystem access control, secret brokering, network
  filtering, proxying, or TLS interception;
- packet contents, keylogging, screen capture, clipboard capture, or arbitrary
  personal-file contents;
- malware classification, tamper-proofing, antivirus, EDR, or complete-host
  protection claims;
- autonomous termination of unrelated processes.

If a proposal needs any capability above, it belongs in another product. Argus
does not accept a partial foundation for it.

## Hard invariants

1. Argus has only Identity 1 and Identity 2.
2. Observation is passive, metadata-only, and honest about missing capability.
3. Filesystem observation is off by default and never reads file contents.
4. AI/agent-relevant network metadata is the default; broader readable scope is
   explicit opt-in.
5. Unattributed means unknown, not suspicious or malicious.
6. Agent events and environment observations use separate storage and wire types.
7. Weak observations never become fake sessions, costs, prompts, or tool calls.
8. PTY/shell recording requires explicit attachment or agent ownership.
9. The only direct OS intervention is killing a redline-matched,
   agent-associated process tree after an explicit operator action.
10. Non-redlined gates and unrelated processes are never killable through Argus.
11. Argus continues to function when any passive sensor is unavailable.
12. No privileged-watchdog capability may be introduced as scaffolding,
    abstraction, adapter placeholder, or future-facing extension point.
13. Redline matching never triggers autonomous termination.

## Actor labels

Argus keeps actor, destination, and evidence separate:

- a socket-owning PID may be labeled `Firefox -> Google Gemini`;
- a dashboard browser profile may be recorded as the client that approved a
  gate decision;
- a filesystem watcher event remains `writer unknown` when the operating-system
  API supplied no writer PID.

Browser-profile continuity uses a random local pseudonym. It is not hardware
fingerprinting and does not prove a physical device, person, tab, or intent.
Nearby process activity may be shown as context, never rewritten as causation.
The recorded address is the direct network peer. Argus does not trust forwarded
address headers from an unspecified proxy.

## Product language

Use:

> Argus passively reveals runtime truth beneath agent self-report, preserves the
> gap between declared and observed activity, and can stop only an
> agent-associated process that crossed an operator-owned redline.

Do not use:

> Argus is becoming an endpoint-security or host-enforcement platform.

or:

> Every event observed near an agent was caused by that agent.
