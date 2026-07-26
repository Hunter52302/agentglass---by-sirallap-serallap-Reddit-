import { describe, expect, test } from "bun:test";
import { browserFromUserAgent, clientIdentity } from "../src/clientIdentity.ts";

const req = (headers: Record<string, string>) =>
  new Request("http://localhost/gate/decide", { method: "POST", headers });

describe("control-plane client identity", () => {
  test("uses a one-way stable pseudonym without retaining raw token", () => {
    const token = "A".repeat(43);
    const a = clientIdentity(req({
      "x-agentglass-client-token": token,
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15) Gecko/20100101 Firefox/140.0",
    }), "192.168.1.8");
    const b = clientIdentity(req({
      "x-agentglass-client-token": token,
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15) Gecko/20100101 Firefox/140.0",
    }), "192.168.1.8");

    expect(a.id).toBe(b.id);
    expect(a.id).not.toContain(token);
    expect(a.label).toBe("macOS Firefox");
    expect(a.remote_address).toBe("192.168.1.8");
    expect(a.fidelity).toBe("browser_pseudonym");
  });

  test("invalid or missing pseudonym falls back to request metadata", () => {
    const c = clientIdentity(req({
      "x-agentglass-client-token": "../../machine-id",
      "user-agent": "Mozilla/5.0 (iPhone) Version/18.0 Mobile/15E148 Safari/604.1",
    }));
    expect(c.id).toBeNull();
    expect(c.label).toBe("iOS Safari");
    expect(c.fidelity).toBe("request_metadata");
  });

  test("names Chromium-family browsers without calling every one Chrome", () => {
    expect(browserFromUserAgent("Mozilla/5.0 Chrome/140.0 Safari/537.36 Edg/140.0")).toBe("Edge");
    expect(browserFromUserAgent("Mozilla/5.0 Chrome/140.0 Electron/38.0 Safari/537.36")).toBe("Electron");
    expect(browserFromUserAgent("Mozilla/5.0 Chrome/140.0 Safari/537.36")).toBe("Chrome");
  });
});
