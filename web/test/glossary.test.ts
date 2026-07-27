import { describe, expect, test } from "bun:test";
import { GLOSSARY, glossaryCandidates, normalizeGlossaryTerm } from "../src/lib/glossary.ts";

describe("local Argus glossary", () => {
  test("normalizes UI punctuation and spaces", () => {
    expect(normalizeGlossaryTerm(" Process ID (PID) ")).toBe("process_id_pid");
    expect(normalizeGlossaryTerm("writer-unknown")).toBe("writer_unknown");
  });

  test("exact and simple plural terms resolve directly", () => {
    expect(glossaryCandidates("PID", "PID 123")).toEqual(["pid"]);
    expect(glossaryCandidates("tokens", "1,200 tokens")).toEqual(["token"]);
  });

  test("a word can offer relevant compound terms", () => {
    const candidates = glossaryCandidates("write", "latest fs write");
    expect(candidates).toContain("fs_write");
  });

  test("terms used inside definitions resolve for daisy-chain navigation", () => {
    expect(glossaryCandidates("socket", GLOSSARY.net_connect.definition)).toEqual(["socket"]);
    expect(glossaryCandidates("process", GLOSSARY.socket.definition)).toEqual(["process"]);
    expect(glossaryCandidates("PID", GLOSSARY.process.definition)).toEqual(["pid"]);
  });

  test("passive-boundary terms do not describe unknown as hostile", () => {
    expect(GLOSSARY.unattributed.definition.toLowerCase()).toContain("unknown does not mean hostile");
    expect(GLOSSARY.redline.definition.toLowerCase()).toContain("never kills automatically");
  });
});
