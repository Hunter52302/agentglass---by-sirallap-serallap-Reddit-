import { useEffect, useRef, useState, type RefObject } from "react";
import type { FsEntry } from "../../../shared/types.ts";
import { api } from "../lib/api.ts";

export function PathAutocomplete({
  value,
  onChange,
  onSubmit,
  placeholder,
  inputRef,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  placeholder?: string;
  inputRef?: RefObject<HTMLInputElement>;
}) {
  const ownRef = useRef<HTMLInputElement>(null);
  const ref = inputRef ?? ownRef;
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [selected, setSelected] = useState(-1);
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    const prefix = value.trim();
    if (!focused || (!prefix.startsWith("/") && !prefix.startsWith("~"))) {
      setEntries([]);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      api.fsComplete(prefix)
        .then((result) => { if (live) setEntries(result.entries); })
        .catch(() => { if (live) setEntries([]); });
    }, 120);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [value, focused]);

  useEffect(() => setSelected(-1), [entries]);

  const accept = (entry: FsEntry) => {
    onChange(entry.path + "/");
    setSelected(-1);
    ref.current?.focus();
  };

  return (
    <div className="relative">
      <input
        ref={ref}
        value={value}
        onFocus={() => setFocused(true)}
        onBlur={() => setTimeout(() => setFocused(false), 120)}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Tab" && entries.length) {
            e.preventDefault();
            accept(entries[selected >= 0 ? selected : 0]!);
          } else if (e.key === "ArrowDown" && entries.length) {
            e.preventDefault();
            setSelected((i) => (i + 1) % entries.length);
          } else if (e.key === "ArrowUp" && entries.length) {
            e.preventDefault();
            setSelected((i) => (i <= 0 ? entries.length : i) - 1);
          } else if (e.key === "Enter") {
            if (selected >= 0 && entries[selected]) accept(entries[selected]!);
            else onSubmit();
          } else if (e.key === "Escape") {
            e.stopPropagation();
            setEntries([]);
          }
        }}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        className="w-full px-2 py-1 rounded-lg text-[11px] outline-none"
        style={{
          color: "var(--text2)",
          background: "var(--bg2)",
          border: "1px solid color-mix(in srgb, var(--border) 45%, transparent)",
          fontFamily: "var(--font-mono, ui-monospace)",
        }}
      />
      {focused && entries.length > 0 && (
        <div
          className="absolute z-[80] left-0 right-0 top-full mt-1 max-h-48 overflow-y-auto rounded-lg p-1 shadow-xl"
          style={{
            background: "var(--bg2)",
            border: "1px solid color-mix(in srgb, var(--border) 55%, transparent)",
          }}
        >
          {entries.map((entry, index) => (
            <button
              key={entry.path}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => accept(entry)}
              className="w-full flex items-center gap-2 rounded px-2 py-1 text-left text-[10px]"
              style={{
                color: "var(--text2)",
                background: selected === index
                  ? "color-mix(in srgb, var(--primary) 16%, transparent)"
                  : "transparent",
              }}
              title={entry.path}
            >
              <span>{entry.repo ? "⌂" : "📁"}</span>
              <span className="truncate">{entry.path}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
