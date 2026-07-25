# Argus identity boundary

Argus has one primary identity, one supporting capability, and one explicitly
operator-controlled diagnostic mode.

## Primary: agent runtime integrity and intervention

Argus shows what agents, their shells, and their process trees actually do beneath
AgentGlass's semantic reports. It may observe recognized agent runtimes, attached
PTY/shell sessions, spawned processes, project filesystem effects, and relevant
network metadata. When an agent-associated task crosses an explicit redline,
Argus may deny the action, stop the task, or stop its process tree.

Containment is not general host administration. A target must be tied to an agent,
a descendant, an explicitly attached shell, a gated request carrying a PID, or a
manual operator decision made from Argus evidence.

## Supporting: development provenance

Argus correlates declared agent actions with actual project effects from agents,
editors, build tools, package managers, Git, tests, shells, and unattributed
writers. Temporal proximity is evidence for review, not proof of causation.
Environment observations remain separate from AgentGlass semantic telemetry.

## Operator-expanded diagnostic mode

The user owns the lens. Argus therefore permits deliberate expansion beyond the
active workspace:

- `network: all` may show every process represented in the socket table;
- the filesystem watcher may be pointed at a parent directory, drive root, or `/`;
- an existing local, SSH, WSL, PuTTY/plink, or other terminal may be explicitly
  attached to the shell recorder.

These modes are never the default. The UI must label them as machine-wide or
operator-expanded, and observations must not be presented as agent-attributed
merely because they occurred near an agent session.

## Deferred: persistent endpoint-security platform

The following remain outside the current foundation:

- boot, kernel, driver, firmware, registry-persistence, service, or scheduled-task
  monitoring;
- packet contents, TLS interception, keylogging, screen capture, clipboard capture,
  or arbitrary personal-file contents;
- automatic malware classification of unrelated software;
- tamper-proof, antivirus, EDR, or complete-host-protection claims;
- autonomous termination of unrelated processes without an explicit policy or
  operator decision.

## Invariants

1. Agent events and environment observations use separate storage and wire types.
2. Filesystem observation is off by default.
3. AI/agent-relevant network metadata is the normal view; every-process network
   visibility is an explicit opt-in.
4. Broader filesystem scope requires the operator to choose the path deliberately.
5. Unattributed means unknown, not malicious.
6. PTY/shell recording requires explicit attachment or agent ownership.
7. Process containment requires agent association, a gated PID, an attached shell,
   an explicit redline, or direct operator confirmation.
8. Argus refuses PID 0/1, itself, and its parent.
9. AgentGlass continues to function when Argus is disabled or unavailable.
10. Weak observations retain fidelity labels and are never converted into fake
    sessions, costs, prompts, or tool calls.

## Product language

Use:

> Argus reveals and contains activity beneath agent self-report, while keeping
> broader machine visibility under the user's explicit control.

Do not use:

> Argus detects all malicious activity.

or:

> Every event observed near an agent was caused by that agent.
