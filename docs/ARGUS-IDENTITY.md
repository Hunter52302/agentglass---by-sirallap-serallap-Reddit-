# Argus identity boundary

Argus currently has one primary identity and one supporting capability.

## Primary: agent-integrity monitor

Argus compares what an AI agent reports with what the selected project actually
experiences. It surfaces declared effects, corroborating effects, and
unattributed project changes without pretending that temporal proximity proves
causation.

## Supporting: development provenance

Within the active AgentGlass workspace, Argus may explain changes produced by
agents, editors, build tools, package managers, Git, tests, and unknown writers.
The evidence remains separate from AgentGlass semantic telemetry.

## Deferred: host-security sensor

The following belong to a different product identity and are not part of this
foundation:

- machine-wide filesystem observation
- every-process network collection
- continuous host process inventory by default
- boot, driver, service, registry, scheduled-task, or persistence monitoring
- packet contents or decrypted traffic
- process-tree termination or automatic host enforcement
- malware, antivirus, EDR, or tamper-proof claims

Code retained from earlier experiments must remain disabled unless and until it
is extracted into a separately reviewed host-security project.

## Invariants

1. Agent events and environment observations use separate storage and wire
   types.
2. Filesystem observation is opt-in.
3. Filesystem observation is limited to the active workspace or a descendant.
4. Unattributed means unknown, not malicious.
5. Argus may add evidence to a gate decision but does not terminate processes.
6. Process and network sensors are off by default.
7. Network scope cannot widen to every host connection.
8. AgentGlass continues to function when Argus is disabled or unavailable.

## Product language

Use:

> Argus verifies agent-reported actions against scoped project effects.

Do not use:

> Argus watches everything on your computer.

or:

> Argus detects all malicious activity.
