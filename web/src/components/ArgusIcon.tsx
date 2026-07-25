// AgentGlass Argus integration — the Argus glyph.
//
// MIT © 2026 Zac Rieger. See NOTICE.md.
//
// An eye, for the hundred-eyed giant of the myth who never slept and could not
// be got past. Kept deliberately unlike agentglass's loupe: that mark is a lens
// you point at your fleet, this one is something already watching the machine.

export function ArgusEyeIcon({ size = 15 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
      strokeLinecap="round" strokeLinejoin="round" width={size} height={size}
      role="img" aria-label="Argus"
    >
      <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z" />
      <circle cx="12" cy="12" r="2.6" />
    </svg>
  );
}
