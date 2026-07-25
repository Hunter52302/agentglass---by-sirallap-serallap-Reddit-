import { describe, expect, it } from "bun:test";
import { ctxLimitOf } from "../src/lib/contextWindow.ts";

const M = 1_000_000;
const K = 1_000;

describe("ctxLimitOf", () => {
  it("recognizes Claude 5 wide-context families", () => {
    for (const id of ["claude-opus-5", "claude-sonnet-5", "claude-fable-5", "claude-mythos-5"]) {
      expect(ctxLimitOf(id)).toBe(M);
    }
  });

  it("recognizes Opus 4.6-4.8 and Sonnet 4.6", () => {
    for (const id of ["claude-opus-4-6", "claude-opus-4-7", "claude-opus-4-8", "claude-sonnet-4-6"]) {
      expect(ctxLimitOf(id)).toBe(M);
    }
  });

  it("keeps older Claude and Haiku at 200k", () => {
    for (const id of ["claude-haiku-4-5", "claude-opus-4-5", "claude-sonnet-4-5", "claude-3-5-sonnet-20241022"]) {
      expect(ctxLimitOf(id)).toBe(200 * K);
    }
  });

  it("lets explicit suffixes override family defaults", () => {
    expect(ctxLimitOf("claude-opus-5[200k]")).toBe(200 * K);
    expect(ctxLimitOf("claude-haiku-4-5[1m]")).toBe(M);
  });

  it("promotes conservative unknown limits from observations", () => {
    expect(ctxLimitOf("claude-new-family", 250_000)).toBe(400 * K);
    expect(ctxLimitOf("claude-new-family", 900_000)).toBe(M);
  });

  it("preserves other-provider limits", () => {
    expect(ctxLimitOf("gemini-3-flash")).toBe(M);
    expect(ctxLimitOf("gpt-5")).toBe(400 * K);
    expect(ctxLimitOf("gpt-4o")).toBe(128 * K);
  });
});
