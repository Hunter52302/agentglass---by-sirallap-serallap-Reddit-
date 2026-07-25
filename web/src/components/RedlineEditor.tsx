import { useCallback, useEffect, useMemo, useState } from "react";
import { Portal } from "./Portal.tsx";
import { useDialogs } from "./ConfirmDialog.tsx";
import { api } from "../lib/api.ts";
import type { RedlineRuleInfo, RedlineRuleInput, RedlineStatus } from "../../../shared/env.ts";

type Decision = "flag" | "gate" | "kill";
type Kind = "command" | "file" | "path" | "any";
type Operation = "create" | "write" | "delete";

interface Draft {
  id: string;
  description: string;
  enabled: boolean;
  kind: Kind;
  action: string;
  target: string;
  protected_path: string;
  operations: Operation[];
  decision: Decision;
}

const EMPTY: Draft = {
  id: "",
  description: "",
  enabled: true,
  kind: "command",
  action: "^bash$",
  target: "",
  protected_path: "",
  operations: ["write", "delete"],
  decision: "gate",
};

function asDraft(rule: RedlineRuleInfo): Draft {
  return {
    id: rule.id,
    description: rule.description,
    enabled: rule.enabled,
    kind: rule.kind,
    action: rule.action ?? "",
    target: rule.target ?? "",
    protected_path: rule.protected_path ?? "",
    operations: rule.operations ?? ["create", "write", "delete"],
    decision: rule.decision ?? (rule.kill ? "kill" : "gate"),
  };
}

export function RedlineEditor({ open, onClose, onSaved }: {
  open: boolean;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const [status, setStatus] = useState<RedlineStatus | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { ask, dialog } = useDialogs();

  const load = useCallback(async () => {
    try {
      setStatus(await api.envRedlines());
      setError(null);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  }, []);

  useEffect(() => { if (open) void load(); }, [open, load]);
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [open, onClose]);

  const canSave = useMemo(() => {
    if (!draft.id.trim()) return false;
    if (draft.kind === "file" || draft.kind === "path") return !!(draft.protected_path.trim() || draft.target.trim());
    return !!(draft.action.trim() || draft.target.trim() || draft.protected_path.trim());
  }, [draft]);

  const reset = () => { setDraft(EMPTY); setEditing(null); setError(null); };

  const save = async () => {
    if (!canSave || busy) return;
    setBusy(true);
    try {
      const rule: RedlineRuleInput = {
        id: draft.id.trim(),
        description: draft.description.trim() || draft.id.trim(),
        enabled: draft.enabled,
        kind: draft.kind,
        action: draft.action.trim() || null,
        target: draft.target.trim() || null,
        protected_path: draft.protected_path.trim() || null,
        operations: draft.operations,
        decision: draft.decision,
      };
      const result = await api.envUpsertRedline(rule);
      if (!result.ok) throw new Error(result.error || "redline was not saved");
      await load();
      reset();
      onSaved?.();
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    if (busy) return;
    if (!(await ask({
      title: `Remove redline “${id}”?`,
      body: "This policy will stop applying immediately.",
      confirmLabel: "Remove redline",
      danger: true,
    }))) return;
    setBusy(true);
    try {
      const result = await api.envDeleteRedline(id);
      if (!result.ok) throw new Error(result.error || "redline was not removed");
      await load();
      if (editing === id) reset();
      onSaved?.();
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (rule: RedlineRuleInfo) => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await api.envUpsertRedline({ ...rule, enabled: !rule.enabled });
      if (!result.ok) throw new Error(result.error || "redline was not updated");
      await load();
      onSaved?.();
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  const toggleOp = (op: Operation) => setDraft((d) => ({
    ...d,
    operations: d.operations.includes(op) ? d.operations.filter((x) => x !== op) : [...d.operations, op],
  }));

  if (!open) return null;

  return (
    <>
    <Portal>
      <div className="fixed inset-0 z-[80] flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,.58)" }}>
        <div className="w-full max-w-[1050px] max-h-[92vh] overflow-hidden rounded-xl border flex flex-col"
          style={{ background: "var(--bg)", borderColor: "var(--border)" }}>
          <div className="flex items-center gap-3 px-4 py-3 border-b" style={{ borderColor: "var(--border)" }}>
            <div>
              <div className="text-sm font-semibold" style={{ color: "var(--text)" }}>Argus redlines</div>
              <div className="text-[10px]" style={{ color: "var(--text4)" }}>
                User-owned command, path, and file-operation policies. Kill applies only when Argus has a verified PID.
              </div>
            </div>
            <button onClick={onClose} className="ml-auto px-2 py-1 rounded text-xs" style={{ color: "var(--text3)" }}>close</button>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-[1fr_390px] min-h-0 flex-1">
            <div className="overflow-auto p-4 border-r" style={{ borderColor: "var(--border)" }}>
              {status?.error && <div className="mb-3 text-xs" style={{ color: "var(--error)" }}>{status.error}</div>}
              {!status?.rules.length && <div className="text-xs" style={{ color: "var(--text4)" }}>No redlines configured.</div>}
              <div className="flex flex-col gap-2">
                {status?.rules.map((rule) => (
                  <div key={rule.id} className="rounded-lg border p-3" style={{ borderColor: "var(--border)", opacity: rule.enabled ? 1 : .55 }}>
                    <div className="flex items-start gap-2">
                      <div className="min-w-0">
                        <div className="text-xs font-semibold" style={{ color: "var(--text)" }}>{rule.id}</div>
                        <div className="text-[11px] mt-0.5" style={{ color: "var(--text3)" }}>{rule.description}</div>
                      </div>
                      <span className="ml-auto text-[9px] uppercase px-1.5 py-0.5 rounded" style={{ color: rule.decision === "kill" ? "var(--error)" : rule.decision === "gate" ? "var(--warning)" : "var(--info)", background: "var(--bg2)" }}>{rule.decision}</span>
                    </div>
                    <div className="mt-2 text-[10px] font-mono break-all" style={{ color: "var(--text4)" }}>
                      {rule.protected_path ? `path: ${rule.protected_path}` : null}
                      {rule.action ? `${rule.protected_path ? " · " : ""}action: ${rule.action}` : null}
                      {rule.target ? ` · target: ${rule.target}` : null}
                      {rule.operations?.length ? ` · ops: ${rule.operations.join(",")}` : null}
                    </div>
                    <div className="flex gap-2 mt-3">
                      <button onClick={() => { setEditing(rule.id); setDraft(asDraft(rule)); }} className="text-[10px] px-2 py-1 rounded" style={{ background: "var(--bg2)", color: "var(--text2)" }}>edit</button>
                      <button onClick={() => void toggle(rule)} className="text-[10px] px-2 py-1 rounded" style={{ background: "var(--bg2)", color: rule.enabled ? "var(--warning)" : "var(--success)" }}>{rule.enabled ? "disable" : "enable"}</button>
                      <button onClick={() => void remove(rule.id)} className="text-[10px] px-2 py-1 rounded" style={{ background: "var(--bg2)", color: "var(--error)" }}>remove</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="overflow-auto p-4">
              <div className="flex items-center gap-2 mb-3">
                <div className="text-xs font-semibold" style={{ color: "var(--text)" }}>{editing ? `Edit ${editing}` : "Add redline"}</div>
                {editing && <button onClick={reset} className="ml-auto text-[10px]" style={{ color: "var(--text4)" }}>new rule</button>}
              </div>
              <label className="block text-[10px] mb-1" style={{ color: "var(--text4)" }}>ID</label>
              <input value={draft.id} disabled={!!editing} onChange={(e) => setDraft({ ...draft, id: e.target.value })} className="w-full px-2 py-1.5 rounded border text-xs mb-3" style={{ background: "var(--bg2)", borderColor: "var(--border)", color: "var(--text)" }} />

              <label className="block text-[10px] mb-1" style={{ color: "var(--text4)" }}>Description</label>
              <input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} className="w-full px-2 py-1.5 rounded border text-xs mb-3" style={{ background: "var(--bg2)", borderColor: "var(--border)", color: "var(--text)" }} />

              <div className="grid grid-cols-2 gap-2 mb-3">
                <div>
                  <label className="block text-[10px] mb-1" style={{ color: "var(--text4)" }}>Kind</label>
                  <select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as Kind })} className="w-full px-2 py-1.5 rounded border text-xs" style={{ background: "var(--bg2)", borderColor: "var(--border)", color: "var(--text)" }}>
                    <option value="command">command</option><option value="file">file</option><option value="path">path</option><option value="any">any</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[10px] mb-1" style={{ color: "var(--text4)" }}>Decision</label>
                  <select value={draft.decision} onChange={(e) => setDraft({ ...draft, decision: e.target.value as Decision })} className="w-full px-2 py-1.5 rounded border text-xs" style={{ background: "var(--bg2)", borderColor: "var(--border)", color: "var(--text)" }}>
                    <option value="flag">flag only</option><option value="gate">gate / deny</option><option value="kill">deny and kill</option>
                  </select>
                </div>
              </div>

              <label className="block text-[10px] mb-1" style={{ color: "var(--text4)" }}>Action regex</label>
              <input value={draft.action} onChange={(e) => setDraft({ ...draft, action: e.target.value })} placeholder="^bash$ or ^(Write|Edit)$" className="w-full px-2 py-1.5 rounded border text-xs mb-3 font-mono" style={{ background: "var(--bg2)", borderColor: "var(--border)", color: "var(--text)" }} />

              <label className="block text-[10px] mb-1" style={{ color: "var(--text4)" }}>Target or command regex</label>
              <input value={draft.target} onChange={(e) => setDraft({ ...draft, target: e.target.value })} placeholder="git\\s+push.*--force" className="w-full px-2 py-1.5 rounded border text-xs mb-3 font-mono" style={{ background: "var(--bg2)", borderColor: "var(--border)", color: "var(--text)" }} />

              <label className="block text-[10px] mb-1" style={{ color: "var(--text4)" }}>Protected file or directory</label>
              <input value={draft.protected_path} onChange={(e) => setDraft({ ...draft, protected_path: e.target.value })} placeholder="${WATCH_DIR}/.env.production" className="w-full px-2 py-1.5 rounded border text-xs mb-3 font-mono" style={{ background: "var(--bg2)", borderColor: "var(--border)", color: "var(--text)" }} />

              <div className="mb-3">
                <label className="block text-[10px] mb-1" style={{ color: "var(--text4)" }}>File operations</label>
                <div className="flex gap-2">
                  {(["create", "write", "delete"] as Operation[]).map((op) => <button key={op} onClick={() => toggleOp(op)} className="px-2 py-1 rounded text-[10px]" style={{ background: draft.operations.includes(op) ? "color-mix(in srgb, var(--primary) 18%, transparent)" : "var(--bg2)", color: draft.operations.includes(op) ? "var(--primary-hover)" : "var(--text4)" }}>{op}</button>)}
                </div>
              </div>

              <label className="flex items-center gap-2 text-[11px] mb-4" style={{ color: "var(--text3)" }}>
                <input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} /> enabled
              </label>

              {error && <div className="text-[11px] mb-3" style={{ color: "var(--error)" }}>{error}</div>}
              <button onClick={() => void save()} disabled={!canSave || busy} className="w-full px-3 py-2 rounded text-xs font-semibold disabled:opacity-40" style={{ background: "var(--primary)", color: "white" }}>{busy ? "saving…" : editing ? "save changes" : "add redline"}</button>
            </div>
          </div>
        </div>
      </div>
    </Portal>
    {dialog}
    </>
  );
}
