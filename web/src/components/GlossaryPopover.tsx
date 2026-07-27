import { useEffect, useRef, useState } from "react";
import { GLOSSARY, glossaryCandidates } from "../lib/glossary.ts";
import { Portal } from "./Portal.tsx";

interface GlossState {
  keys: string[];
  x: number;
  y: number;
}

const ignoredTarget = (target: Element | null): boolean =>
  !!target?.closest("input, textarea, select, [contenteditable='true']");

/**
 * App-wide, in-place vocabulary help. Double-clicking a known term uses only
 * the local glossary; selected UI text never leaves the browser.
 */
export function GlossaryPopover() {
  const [state, setState] = useState<GlossState | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onDoubleClick = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (ignoredTarget(target)) return;
      const explicit = target?.closest<HTMLElement>("[data-glossary]")?.dataset.glossary ?? "";
      const selected = String(window.getSelection?.() ?? "").trim();
      const term = explicit || selected;
      if (!term || term.length > 48) return;
      const context = target?.textContent ?? term;
      const keys = glossaryCandidates(term, context);
      if (!keys.length) {
        // A missed word inside a definition should not throw away the current
        // entry. The user may simply have selected punctuation with it.
        if (!popRef.current?.contains(target)) setState(null);
        return;
      }
      setChosen(keys.length === 1 ? keys[0] : null);
      const chained = popRef.current?.contains(target) ?? false;
      setState((current) => ({
        keys,
        // Daisy-chained definitions replace the current entry in place instead
        // of making the card hop after the selected word.
        x: chained && current ? current.x : event.clientX,
        y: chained && current ? current.y : event.clientY,
      }));
    };
    const onClick = (event: MouseEvent) => {
      if (popRef.current?.contains(event.target as Node)) return;
      setState(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setState(null);
    };
    document.addEventListener("dblclick", onDoubleClick);
    document.addEventListener("click", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("dblclick", onDoubleClick);
      document.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  if (!state) return null;
  const key = chosen ?? (state.keys.length === 1 ? state.keys[0] : null);
  const entry = key ? GLOSSARY[key] : null;
  const width = Math.min(380, window.innerWidth - 24);
  const left = Math.max(12, Math.min(state.x, window.innerWidth - width - 12));
  const top = Math.max(12, Math.min(state.y + 14, window.innerHeight - 230));

  return (
    <Portal z={11000}>
      <div
        ref={popRef}
        role="dialog"
        aria-label="Term definition"
        className="fixed rounded-lg p-3 text-[11px] shadow-2xl"
        style={{
          left,
          top,
          width,
          maxHeight: "min(280px, calc(100vh - 24px))",
          overflowY: "auto",
          background: "color-mix(in srgb, var(--bg2) 96%, var(--bg))",
          border: "1px solid color-mix(in srgb, var(--primary) 65%, transparent)",
          color: "var(--text)",
        }}
      >
        <button
          onClick={() => setState(null)}
          aria-label="Close definition"
          className="absolute top-1.5 right-2 text-sm hover:opacity-80"
          style={{ color: "var(--text4)" }}
        >
          ×
        </button>
        {entry ? (
          <>
            <div className="font-semibold pr-5 mb-1" style={{ color: "var(--primary-hover)" }}>
              {entry.term}
            </div>
            <div className="leading-relaxed" style={{ color: "var(--text2)" }}>
              {entry.definition}
            </div>
            {state.keys.length > 1 && (
              <button
                onClick={() => setChosen(null)}
                className="mt-2 text-[10px] hover:opacity-80"
                style={{ color: "var(--text4)" }}
              >
                ← other related terms
              </button>
            )}
          </>
        ) : (
          <>
            <div className="mb-2 pr-5" style={{ color: "var(--text4)" }}>Which term did you mean?</div>
            <div className="flex flex-col gap-1">
              {state.keys.map((candidate) => (
                <button
                  key={candidate}
                  onClick={() => setChosen(candidate)}
                  className="text-left px-2 py-1.5 rounded transition-opacity hover:opacity-80"
                  style={{
                    color: "var(--text2)",
                    background: "var(--bg)",
                    border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)",
                  }}
                >
                  {GLOSSARY[candidate].term}
                </button>
              ))}
            </div>
          </>
        )}
        <div className="mt-2 pt-2 text-[9px] leading-relaxed" style={{
          color: "var(--text4)",
          borderTop: "1px solid color-mix(in srgb, var(--border) 30%, transparent)",
        }}>
          Double-click another term here to keep exploring.<br />
          Local Argus glossary · no lookup leaves this app
        </div>
      </div>
    </Portal>
  );
}
