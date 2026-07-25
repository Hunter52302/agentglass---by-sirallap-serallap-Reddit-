// Glasses for Argus — enforcement boundary.
//
// MIT © 2026 Zac Rieger. See NOTICE.md.
//
// Process-tree termination belongs to Argus identity 3: a host security and
// enforcement product. The current foundation is identities 1 and 2 only:
// scoped agent-integrity verification and development provenance. It observes
// and explains project effects; it does not terminate host processes.
//
// This module preserves the existing API so older redline/UI code fails closed
// without crashing while the identity-3 implementation is removed from the
// active product surface.

export interface KillResult {
  requested: number | null;
  killed: number[];
  failed: number[];
  skipped?: string;
}

/**
 * Retained for compatibility and tests that inspect traversal behavior.
 * No process enumeration is performed in the scoped foundation.
 */
export function processTree(pid: number, _seen = new Set<number>()): number[] {
  const root = Number(pid);
  return Number.isInteger(root) && root > 1 ? [root] : [];
}

/**
 * Host enforcement is deliberately unavailable. Denial remains AgentGlass's
 * gate responsibility; Argus contributes evidence and discrepancy context.
 */
export function killTree(pid: number | null | undefined): KillResult {
  const root = Number(pid);
  return {
    requested: Number.isFinite(root) ? root : null,
    killed: [],
    failed: [],
    skipped: "outside-argus-agent-integrity-scope",
  };
}
