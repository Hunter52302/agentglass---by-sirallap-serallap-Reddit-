import { describe, expect, it } from "bun:test";
import { mergeCockpitLayout } from "../src/lib/cockpitLayout.ts";

const defaults = [
  { id: "fleet", width: 3, height: 7, hidden: false, collapsed: false },
  { id: "feed", width: 6, height: 5, hidden: false, collapsed: false },
];

describe("cockpit layout", () => {
  it("keeps user order and adds new shipped widgets", () => {
    const result = mergeCockpitLayout(defaults, [
      { id: "feed", width: 8, height: 4, hidden: false, collapsed: true },
    ]);
    expect(result.map((item) => item.id)).toEqual(["feed", "fleet"]);
    expect(result[0]).toMatchObject({ width: 8, height: 4, collapsed: true });
  });

  it("drops unknown widgets and clamps invalid sizes", () => {
    const result = mergeCockpitLayout(defaults, [
      { id: "ghost", width: 12, height: 2 },
      { id: "fleet", width: 99, height: -5, hidden: true },
    ]);
    expect(result.map((item) => item.id)).toEqual(["fleet", "feed"]);
    expect(result[0]).toMatchObject({ width: 12, height: 1, hidden: true });
  });

  it("uses defaults for corrupt saved data", () => {
    expect(mergeCockpitLayout(defaults, { nope: true })).toEqual(defaults);
  });
});

