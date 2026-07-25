import { useCallback, useEffect, useState } from "react";
import type { ImpactSummary } from "../../../shared/impact.ts";
import { api } from "./api.ts";

function pollFor(windowMs: number): number {
  if (windowMs <= 3_600_000) return 4_000;
  if (windowMs <= 24 * 3_600_000) return 10_000;
  if (windowMs <= 7 * 86_400_000) return 20_000;
  return 30_000;
}

export function useImpact(windowMs: number, provider = "") {
  const [impact, setImpact] = useState<ImpactSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    api.impact(windowMs, { provider: provider || undefined, water_type: "consumption" })
      .then((value) => { setImpact(value); setError(null); })
      .catch((reason) => setError(String(reason)));
  }, [windowMs, provider]);
  useEffect(() => {
    reload();
    const timer = setInterval(reload, pollFor(windowMs));
    return () => clearInterval(timer);
  }, [reload, windowMs]);
  return { impact, error, reload };
}
