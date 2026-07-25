// Serrallapa for Argus — sensor classification and parsing.
//
// Pure functions only: no process table, no sockets, no filesystem. These are
// the parts that decide what something IS, and they are exactly the parts a
// regression would be silent in — a signature that stops matching does not
// throw, it just quietly stops reporting a runtime.

import { test, expect, describe } from "bun:test";
import { classifyProcess, redactSecrets, SIGNATURES } from "../src/argus/processes.ts";
import { classifyEndpoint, parseWindows, parseLsof } from "../src/argus/network.ts";
import { normalizePath, isUnder } from "../src/argus/paths.ts";
import { lineDiff, makeIgnore } from "../src/argus/watcher.ts";
import { toNative } from "../src/argus/reveal.ts";

describe("process classification", () => {
  test("recognizes the runtimes the tier claims to know", () => {
    const cases: Array<[string, string]> = [
      ["/usr/local/bin/ollama serve", "ollama"],
      ["C:\\Program Files\\Ollama\\ollama.exe", "ollama"],
      ["/Applications/Claude.app/Contents/MacOS/Claude", "claude-desktop"],
      ["C:\\Users\\x\\AppData\\Local\\Programs\\Claude\\Claude.exe", "claude-desktop"],
      ["/opt/homebrew/bin/codex", "codex"],
      ["copilot-language-server --stdio", "github-copilot"],
      ["python3 -m vllm.entrypoints.api_server", "vllm"],
      ["/usr/bin/llama-server -m model.gguf", "llama.cpp"],
      ["mlx_lm.server --model x", "mlx-lm"],
    ];
    for (const [cmd, runtime] of cases) {
      expect(classifyProcess({ pid: 1, ppid: 0, command: cmd })?.runtime).toBe(runtime);
    }
  });

  test("does not classify ordinary programs as AI runtimes", () => {
    for (const cmd of [
      "/usr/bin/firefox",
      "C:\\Windows\\explorer.exe",
      "node server.js",
      "/usr/bin/ssh user@host",
      "steam.exe -silent",
    ]) {
      expect(classifyProcess({ pid: 1, ppid: 0, command: cmd })).toBeNull();
    }
  });

  test("a copilot.microsoft.com URL in another process is not the Copilot app", () => {
    // The signature matches the exe as a path segment precisely so a browser
    // tab pointed at Copilot cannot masquerade as the desktop runtime.
    const asTab = classifyProcess({ pid: 1, ppid: 0, command: "firefox https://copilot.microsoft.com/chat" });
    expect(asTab).toBeNull();
    const asApp = classifyProcess({ pid: 1, ppid: 0, command: "C:\\Program Files\\WindowsApps\\Copilot.exe" });
    expect(asApp?.runtime).toBe("windows-copilot");
  });

  test("every signature has a distinct runtime id", () => {
    const ids = SIGNATURES.map((s) => s.runtime);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("secret redaction", () => {
  test("scrubs the shapes that ride in argv", () => {
    const out = redactSecrets(
      "serve --api-key=sk-abcdef123456 --token abc123secret AUTHORIZATION=Bearer xyz " +
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig ghp_0123456789abcdef"
    );
    expect(out).not.toContain("sk-abcdef123456");
    expect(out).not.toContain("ghp_0123456789abcdef");
    expect(out).not.toContain("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig");
    expect(out).toContain("redacted");
  });

  test("is length-capped so one process cannot dump a novel into an event", () => {
    expect(redactSecrets("x".repeat(5000)).length).toBeLessThanOrEqual(400);
  });
});

describe("endpoint classification", () => {
  test("maps known AI hosts to providers", () => {
    expect(classifyEndpoint("api.anthropic.com")?.provider).toBe("anthropic");
    expect(classifyEndpoint("generativelanguage.googleapis.com")?.provider).toBe("google");
    expect(classifyEndpoint("ab.chatgpt.com")?.provider).toBe("openai");
    expect(classifyEndpoint("api.openrouter.ai")?.provider).toBe("aggregator");
  });

  test("does not match unrelated hosts, including near-misses", () => {
    for (const h of ["example.com", "github.com", "notopenai.com.evil.net", "myanthropic.evil.com"]) {
      expect(classifyEndpoint(h)).toBeNull();
    }
  });

  test("null host is not a match", () => {
    expect(classifyEndpoint(null)).toBeNull();
  });
});

describe("socket table parsing", () => {
  test("windows: joins connections to the DNS cache", () => {
    const payload = JSON.stringify({
      conns: [{ pid: 42, name: "firefox", ip: "1.2.3.4", port: 443 }],
      dns: [{ n: "api.anthropic.com", d: "1.2.3.4" }],
    });
    const [c] = parseWindows(payload);
    expect(c.host).toBe("api.anthropic.com");
    expect(c.pid).toBe(42);
    expect(c.port).toBe(443);
  });

  test("windows: a single object is accepted, not just an array", () => {
    // ConvertTo-Json collapses one-element arrays into a bare object.
    const payload = JSON.stringify({
      conns: { pid: 7, name: "claude", ip: "9.9.9.9", port: 443 },
      dns: { n: "x.com", d: "9.9.9.9" },
    });
    expect(parseWindows(payload)).toHaveLength(1);
  });

  test("windows: empty input yields no rows rather than throwing", () => {
    expect(parseWindows("")).toEqual([]);
    expect(parseWindows("   ")).toEqual([]);
  });

  test("lsof: parses established TCP rows and ignores the rest", () => {
    const out = [
      "claude 123 zac 14u IPv4 0x1 0t0 TCP 10.0.0.2:52341->160.79.104.10:443 (ESTABLISHED)",
      "claude 123 zac 15u IPv4 0x2 0t0 TCP 10.0.0.2:52342->1.1.1.1:443 (CLOSE_WAIT)",
      "garbage line",
    ].join("\n");
    const rows = parseLsof(out);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ pid: 123, name: "claude", ip: "160.79.104.10", port: 443 });
  });
});

describe("path normalization", () => {
  test("one canonical id per file across separators and drive case", () => {
    expect(normalizePath("C:\\Users\\Zac\\a.txt")).toBe("/c:/Users/Zac/a.txt");
    expect(normalizePath("c:/Users/Zac/a.txt")).toBe("/c:/Users/Zac/a.txt");
    expect(normalizePath("C:\\Users\\Zac\\a.txt")).toBe(normalizePath("c:/Users/Zac/a.txt"));
  });

  test("keeps UNC hosts and collapses duplicate separators", () => {
    expect(normalizePath("\\\\server\\share\\f")).toBe("//server/share/f");
    expect(normalizePath("/a//b///c")).toBe("/a/b/c");
  });

  test("trailing separators do not mint a second node", () => {
    expect(normalizePath("/a/b/")).toBe("/a/b");
    expect(normalizePath("/")).toBe("/");
  });

  test("isUnder is separator-agnostic and not fooled by a name prefix", () => {
    expect(isUnder("C:\\repo\\src\\a.ts", "/c:/repo")).toBe(true);
    expect(isUnder("/c:/repo", "/c:/repo")).toBe(true);
    // "/c:/repo-other" must NOT count as inside "/c:/repo"
    expect(isUnder("/c:/repo-other/a.ts", "/c:/repo")).toBe(false);
  });
});

describe("line diff", () => {
  test("counts added and removed lines around a common prefix/suffix", () => {
    const d = lineDiff("a\nb\nc", "a\nB\nc");
    expect(d.plus).toBe(1);
    expect(d.minus).toBe(1);
    expect(d.start_line).toBe(2);
  });

  test("treats an empty original as pure addition", () => {
    expect(lineDiff("", "x\ny")).toMatchObject({ plus: 2, minus: 0 });
  });

  test("identical content is a no-op", () => {
    expect(lineDiff("same", "same")).toMatchObject({ plus: 0, minus: 0 });
  });

  test("sample is bounded so one huge write cannot blow up an event", () => {
    const big = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n");
    expect(lineDiff("", big).sample.length).toBeLessThanOrEqual(80);
  });
});

describe("watcher ignore rules", () => {
  test("prunes the directories that explode a broad watch", () => {
    const ig = makeIgnore("/c:/Users/zac");
    expect(ig("/c:/Users/zac/proj/node_modules/x/y.js")).toBe(true);
    expect(ig("/c:/Users/zac/proj/.git/objects/ab")).toBe(true);
    expect(ig("/c:/Users/zac/proj/src/index.ts")).toBe(false);
  });

  test("never ignores the watch root itself", () => {
    expect(makeIgnore("/c:/Users/zac")("/c:/Users/zac")).toBe(false);
    // A root that would otherwise be pruned by a contains-rule stays watchable.
    expect(makeIgnore("/var/folders/tmp-test")("/var/folders/tmp-test")).toBe(false);
  });

  test("prunes sockets, which the native watcher cannot watch", () => {
    const ig = makeIgnore("/tmp/x");
    expect(ig("/tmp/x/app.sock")).toBe(true);
  });
});

describe("reveal path conversion", () => {
  test("normalized paths become native ones", () => {
    expect(toNative("/c:/Users/Zac/a.txt")).toBe("C:\\Users\\Zac\\a.txt");
    expect(toNative("/c:")).toBe("C:\\");
  });
});
