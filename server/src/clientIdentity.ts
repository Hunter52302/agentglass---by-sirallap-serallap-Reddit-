// Stable browser-profile provenance for control-plane decisions.
//
// This is deliberately NOT device fingerprinting. The browser generates a
// random secret and sends it only on mutating AgentGlass requests. We store a
// one-way fingerprint plus low-entropy browser/platform labels. It proves
// continuity of one browser profile while that secret remains in its storage;
// it does not prove a physical device, person, tab, or intent.
import { createHash } from "node:crypto";

export type ClientIdentityFidelity = "browser_pseudonym" | "request_metadata";

export interface ClientIdentity {
  id: string | null;
  label: string;
  browser: string | null;
  platform: string | null;
  remote_address: string | null;
  fidelity: ClientIdentityFidelity;
}

const TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/;

export function browserFromUserAgent(userAgent: string): string | null {
  if (!userAgent) return null;
  if (/\bElectron\//i.test(userAgent)) return "Electron";
  if (/\bEdg(?:A|iOS)?\//i.test(userAgent)) return "Edge";
  if (/\bFxiOS\//i.test(userAgent)) return "Firefox";
  if (/\bFirefox\//i.test(userAgent)) return "Firefox";
  if (/\bCriOS\//i.test(userAgent)) return "Chrome";
  if (/\bChrome\//i.test(userAgent)) return "Chrome";
  if (/\bSafari\//i.test(userAgent) && /\bVersion\//i.test(userAgent)) return "Safari";
  return null;
}

export function platformFromRequest(req: Request, userAgent: string): string | null {
  const hint = (req.headers.get("sec-ch-ua-platform") || "").replace(/^"|"$/g, "").trim();
  if (hint && /^[\w .-]{1,40}$/.test(hint)) return hint;
  if (/\biPhone\b|\biPad\b|\biPod\b/i.test(userAgent)) return "iOS";
  if (/\bMacintosh\b|\bMac OS X\b/i.test(userAgent)) return "macOS";
  if (/\bWindows\b/i.test(userAgent)) return "Windows";
  if (/\bAndroid\b/i.test(userAgent)) return "Android";
  if (/\bLinux\b/i.test(userAgent)) return "Linux";
  return null;
}

export function clientIdentity(req: Request, remoteAddress: string | null = null): ClientIdentity {
  const userAgent = req.headers.get("user-agent") || "";
  const browser = browserFromUserAgent(userAgent);
  const platform = platformFromRequest(req, userAgent);
  const token = req.headers.get("x-agentglass-client-token") || "";
  const id = TOKEN_RE.test(token)
    ? createHash("sha256").update(token).digest("hex").slice(0, 24)
    : null;
  const label = [platform, browser].filter(Boolean).join(" ") || "unknown client";
  return {
    id,
    label,
    browser,
    platform,
    remote_address: remoteAddress,
    fidelity: id ? "browser_pseudonym" : "request_metadata",
  };
}
