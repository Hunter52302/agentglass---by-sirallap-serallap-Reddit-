import { memo, useState } from "react";
import { Cell, Pie, PieChart, ResponsiveContainer } from "recharts";
import type { ImpactSummary } from "../../../shared/impact.ts";
import type { StatsSummary } from "../../../shared/types.ts";
import { bottleText, formatWater } from "../lib/impact.ts";
import { fmtTokens, fmtUsd, modelColor } from "../lib/format.ts";
import { Panel } from "./Panel.tsx";
import { ImpactSourcesModal } from "./ImpactSourcesModal.tsx";

type Mode = "cost" | "tokens" | "water" | "energy";

export const ImpactByModel = memo(function ImpactByModel({
  stats, impact,
}: {
  stats: StatsSummary | null;
  impact: ImpactSummary | null;
}) {
  const [mode, setMode] = useState<Mode>("cost");
  const [hi, setHi] = useState<number | null>(null);
  const [sources, setSources] = useState(false);
  const costRows = stats?.by_model ?? [];
  const impactRows = impact?.by_model ?? [];
  const rowsRaw = mode === "cost"
    ? costRows.map((row) => ({ name: row.model_name, value: row.cost_usd, text: fmtUsd(row.cost_usd) }))
    : mode === "tokens"
      ? costRows.map((row) => ({ name: row.model_name, value: row.input_tokens + row.output_tokens, text: `${fmtTokens(row.input_tokens + row.output_tokens)} tok` }))
      : mode === "water"
        ? impactRows.map((row) => ({
            name: row.label,
            value: row.water_consumption_ml.central,
            text: `${formatWater(row.water_consumption_ml.central, impact!.settings.water_unit)} · ${row.boundary_label}`,
          }))
        : impactRows.map((row) => ({
            name: row.label,
            value: row.energy_wh.central,
            text: row.energy_wh.central === null ? "energy unknown" : `${row.energy_wh.central.toLocaleString("en-US", { maximumSignificantDigits: 3 })} Wh`,
          }));
  const rows = impact?.settings.unavailable_behavior === "hide" && (mode === "water" || mode === "energy")
    ? rowsRaw.filter((row) => row.value !== null)
    : rowsRaw;
  const known = rows.filter((row): row is typeof row & { value: number } => row.value !== null && row.value > 0);
  const incompatible = mode === "water"
    && (impact?.totals.boundary_label === "mixed boundaries"
      || (impact?.totals.known_rows ?? 0) > 0 && impact?.totals.water_consumption_ml.central === null);
  const chartRows = incompatible ? [] : known;
  const total = chartRows.reduce((sum, row) => sum + row.value, 0);
  const active = hi === null ? null : chartRows[hi] ?? null;
  const water = impact?.totals.water_consumption_ml.central ?? null;
  const bottle = water === null ? null : bottleText(water);
  const totalText = mode === "cost" ? fmtUsd(total)
    : mode === "tokens" ? `${fmtTokens(total)} tok`
    : mode === "water" ? `${formatWater(incompatible ? null : water, impact?.settings.water_unit)}${incompatible ? "" : ` · ${impact?.totals.boundary_label}`}`
    : `${total.toLocaleString("en-US", { maximumSignificantDigits: 3 })} Wh`;

  return (
    <>
      <Panel eyebrow="Impact" title={`${mode[0].toUpperCase()}${mode.slice(1)} by model`}
        right={<div className="flex items-center gap-1">
          {(["cost", "tokens", "water", "energy"] as Mode[]).map((value) => (
            <button key={value} onClick={() => { setMode(value); setHi(null); }}
              aria-pressed={mode === value} className="text-[9px] px-1.5 py-0.5 rounded"
              style={mode === value ? { color: "var(--text)", background: "color-mix(in srgb, var(--primary) 35%, transparent)" } : { color: "var(--text3)" }}>
              {value}
            </button>
          ))}
          <button onClick={() => setSources(true)} className="text-[9px] px-1.5 py-0.5 t-dim2">Sources</button>
        </div>}>
        {incompatible ? (
          <div className="h-full flex flex-col items-center justify-center text-center px-5">
            <div className="text-[12px]" style={{ color: "var(--warning)" }}>Mixed water boundaries</div>
            <p className="text-[10.5px] t-dim2 mt-1">Chart disabled. Select one boundary in Settings → Environmental impact.</p>
          </div>
        ) : (
          <div className="flex gap-3 h-full items-center">
            <div className="relative h-32 w-32 shrink-0">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={chartRows.length ? chartRows : [{ name: "—", value: 1, text: "No data" }]}
                    dataKey="value" innerRadius={40} outerRadius={59} paddingAngle={2} stroke="none"
                    onMouseEnter={(_, index) => setHi(index)} onMouseLeave={() => setHi(null)}>
                    {(chartRows.length ? chartRows : [{ name: "—" }]).map((row, index) => (
                      <Cell key={index} fill={chartRows.length ? modelColor(row.name) : "color-mix(in srgb, var(--border) 40%, transparent)"} />
                    ))}
                  </Pie>
                </PieChart>
              </ResponsiveContainer>
              <div className="absolute inset-0 flex flex-col items-center justify-center text-center px-2 pointer-events-none">
                <span className="text-[13px] font-semibold tabular-nums">{active?.text ?? totalText}</span>
                <span className="text-[9px] t-dim2 truncate max-w-full">{active?.name ?? "This window"}</span>
              </div>
            </div>
            <div className="flex-1 min-w-0 space-y-1">
              {!known.length && <div className="text-[11px] t-dim2">{mode === "water" ? "Water unavailable for selected sources" : "No impact data yet"}</div>}
              {rows.slice(0, 5).map((row, index) => (
                <div key={row.name} className="flex items-center gap-2 text-[10.5px]">
                  <span className="h-2 w-2 rounded-full shrink-0" style={{ background: modelColor(row.name) }} />
                  <span className="truncate">{row.name}</span>
                  <span className="ml-auto tabular-nums t-dim2">{row.text}</span>
                </div>
              ))}
              {mode === "water" && bottle && (
                <div className="pt-1.5 mt-1.5 text-[9.5px]" style={{ borderTop: "1px solid color-mix(in srgb, var(--border) 35%, transparent)" }}>
                  <div>{bottle.headline}</div>
                  <div className="t-dim2">{bottle.detail} · no manufacturing claim</div>
                </div>
              )}
            </div>
          </div>
        )}
      </Panel>
      <ImpactSourcesModal open={sources} impact={impact} onClose={() => setSources(false)} />
    </>
  );
});
