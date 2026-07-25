import { describe, expect, it } from "bun:test";
import { layout } from "../src/components/MapGraph.tsx";
import type { MapNode } from "../../shared/env.ts";

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
