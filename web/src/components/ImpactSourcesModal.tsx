import { useEffect } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { ImpactSummary } from "../../../shared/impact.ts";
import { Portal } from "./Portal.tsx";

export function ImpactSourcesModal({
  open, impact, onClose,
}: {
  open: boolean;
  impact: ImpactSummary | null;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [open, onClose]);
  const refs = impact?.totals.source_refs ?? [];
  const profiles = (impact?.profiles ?? []).filter((profile) =>
    refs.some((ref) => ref.profile_id === profile.profile_id && ref.profile_version === profile.profile_version)
  );
  const factors = (impact?.factors ?? []).filter((factor) =>
    refs.some((ref) => ref.regional_factor_id === factor.factor_id)
  );
  return (
    <Portal>
      <AnimatePresence>
        {open && (
          <>
            <motion.div className="fixed inset-0" style={{ zIndex: 10020, background: "rgba(0,0,0,.58)" }}
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} />
            <motion.div role="dialog" aria-modal="true" aria-label="Environmental impact sources"
              className="fixed right-0 top-0 bottom-0 w-[520px] max-w-[92vw] p-5 overflow-y-auto"
              style={{ zIndex: 10021, background: "var(--bg2)", borderLeft: "1px solid var(--border)" }}
              initial={{ x: 40, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: 40, opacity: 0 }}>
              <div className="flex items-start gap-3 mb-5">
                <div>
                  <div className="panel-eyebrow">Scientific provenance</div>
                  <h2 className="text-[17px] font-semibold" style={{ color: "var(--text)" }}>Impact source details</h2>
                  <p className="text-[11px] t-dim2 mt-1">
                    Boundary: {impact?.totals.boundary_label ?? "water unavailable"} · Estimates remain separate from token and cost telemetry.
                  </p>
                </div>
                <button onClick={onClose} className="ml-auto text-[18px] t-dim2" aria-label="Close source details">×</button>
              </div>
              {!profiles.length && !factors.length && (
                <div className="text-[12px] t-dim2">No compatible source profile for selected window.</div>
              )}
              <div className="space-y-3">
                {refs.length > 0 && (
                  <div className="rounded-xl p-3 text-[10.5px]"
                    style={{ border: "1px solid color-mix(in srgb, var(--border) 50%, transparent)" }}>
                    <div className="panel-eyebrow mb-1">Estimate records</div>
                    {refs.map((ref, index) => (
                      <div key={`${ref.profile_id}@${ref.profile_version}:${index}`} className="t-dim2">
                        {ref.method.replaceAll("_", " ")} · {ref.confidence} confidence · {ref.statistic?.replaceAll("_", " ") ?? "statistic unavailable"}
                      </div>
                    ))}
                  </div>
                )}
                {profiles.map((profile) => (
                  <article key={`${profile.profile_id}@${profile.profile_version}`} className="rounded-xl p-3"
                    style={{ border: "1px solid color-mix(in srgb, var(--border) 50%, transparent)", background: "color-mix(in srgb, var(--bg3) 50%, transparent)" }}>
                    <div className="flex items-start gap-2">
                      <div className="min-w-0">
                        <a href={profile.source_url} target="_blank" rel="noreferrer"
                          className="text-[12.5px] font-medium hover:underline" style={{ color: "var(--primary-hover)" }}>
                          {profile.source_title}
                        </a>
                        <div className="text-[10px] t-dim2 mt-0.5">{profile.source_date} · tier {profile.source_tier} · v{profile.profile_version}</div>
                      </div>
                      <span className="chip ml-auto shrink-0">{profile.statistic.replaceAll("_", " ")}</span>
                    </div>
                    <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-[10.5px] mt-3">
                      <dt className="t-dim2">Provider / model</dt><dd>{profile.provider} · {profile.model_match.join(", ")}</dd>
                      <dt className="t-dim2">Boundary</dt><dd>{profile.scope_unknown ? "Scope unknown" : profile.scopes_included.map((s) => `S${s}`).join("+")}</dd>
                      <dt className="t-dim2">Water type</dt><dd>{profile.water_type}</dd>
                      <dt className="t-dim2">Energy boundary</dt><dd>{profile.energy_boundary}</dd>
                      <dt className="t-dim2">Region</dt><dd>{profile.region}</dd>
                      <dt className="t-dim2">Workload</dt><dd>{profile.workload_class.replaceAll("_", " ")}</dd>
                      <dt className="t-dim2">Status</dt><dd>{profile.statistic === "measured" ? "measured" : "estimated / reported"}</dd>
                      <dt className="t-dim2">Low / central / high</dt>
                      <dd>{profile.low_ml ?? "—"} / {profile.central_ml ?? "—"} / {profile.high_ml ?? "—"} mL</dd>
                    </dl>
                    <p className="text-[10.5px] t-dim2 mt-3 leading-relaxed">{profile.notes}</p>
                  </article>
                ))}
                {factors.map((factor) => (
                  <article key={`${factor.factor_id}@${factor.version}`} className="rounded-xl p-3"
                    style={{ border: "1px solid color-mix(in srgb, var(--border) 50%, transparent)" }}>
                    <a href={factor.source_url} target="_blank" rel="noreferrer"
                      className="text-[12.5px] font-medium hover:underline" style={{ color: "var(--primary-hover)" }}>
                      {factor.source_title}
                    </a>
                    <div className="text-[10.5px] mt-2">{factor.label}: {factor.liters_per_kwh} L/kWh · {factor.region}</div>
                    <p className="text-[10.5px] t-dim2 mt-2">{factor.notes}</p>
                  </article>
                ))}
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </Portal>
  );
}
