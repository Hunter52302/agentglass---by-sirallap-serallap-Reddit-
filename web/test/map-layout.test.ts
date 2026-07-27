import { describe, expect, it } from "bun:test";
import { activityFocusView, activityLabel, fitMapView, layout } from "../src/components/MapGraph.tsx";
import type { MapAgent, MapNode } from "../../shared/env.ts";

const nodes: MapNode[] = [
  { path: "/repo", name: "repo", depth: 0, kind: "dir", touches: 1, unclaimed: 0, agents: [], last_ts: 1, last_tool: null },
  { path: "/repo/src", name: "src", depth: 1, kind: "dir", touches: 1, unclaimed: 0, agents: [], last_ts: 1, last_tool: null },
  { path: "/repo/src/app.ts", name: "app.ts", depth: 2, kind: "file", touches: 1, unclaimed: 0, agents: [], last_ts: 1, last_tool: "Edit" },
];

describe("map orientation", () => {
  it("lays depth left to right by default", () => {
    const result = layout(nodes, "left-right").laid;
    expect(result[0]!.x).toBeLessThan(result[2]!.x);
  });

  it("lays depth top to bottom when selected", () => {
    const result = layout(nodes, "top-down").laid;
    expect(result[0]!.y).toBeLessThan(result[2]!.y);
    expect(result[0]!.x).toBe(result[2]!.x);
  });
});

describe("live activity camera", () => {
  it("zooms to a readable scale and places the active node near center", () => {
    const view = activityFocusView({ x: 300, y: 180 }, { width: 1000, height: 700 });
    expect(view.k).toBe(1.25);
    expect(view.x + 300 * view.k).toBe(440);
    expect(view.y + 180 * view.k).toBe(350);
  });

  it("clamps unsafe custom zoom values", () => {
    expect(activityFocusView({ x: 0, y: 0 }, { width: 100, height: 100 }, 99).k).toBe(2);
    expect(activityFocusView({ x: 0, y: 0 }, { width: 100, height: 100 }, 0).k).toBe(0.4);
  });

  it("does not call a historical agent live", () => {
    expect(activityLabel({ live: true } as MapAgent)).toBe("Live activity");
    expect(activityLabel({ live: false } as MapAgent)).toBe("Last recorded activity");
  });

  it("fits a tall node map instead of leaving it off canvas", () => {
    const view = fitMapView(
      { width: 1950, height: 9140 },
      { width: 1000, height: 1400 },
    );
    expect(view).not.toBeNull();
    expect(view!.k).toBeGreaterThanOrEqual(0.08);
    expect(view!.y).toBeGreaterThanOrEqual(0);
  });
});
