// AgentGlass Argus integration — outbound connection (network) discovery.
//
// Origin: Argus src/network.js — MIT © 2026 Zac Rieger.
// Ported to TypeScript; scanning and classification unchanged.
//
// WHAT THIS ADDS TO AGENTGLASS: the file and process tiers see local effects.
// Neither can see an agent — or a browser tab — reach out to a cloud model.
// This polls the per-process socket table and resolves remote IPs to hostnames,
// so `firefox → generativelanguage.googleapis.com` (a Gemini tab) and
// `claude → api.anthropic.com` both become visible. That is the one class of AI
// use with no local process or file footprint at all, and it is currently a
// total blind spot for hook- and transcript-based observability.
//
// HONEST LIMIT: this is connection METADATA only — process, endpoint, port.
// Never packet contents. Modern traffic is TLS-encrypted and reading contents
// would mean breaking your own encryption, which Argus refuses to do. Metadata
// alone still answers "who is talking to whom". Hostnames are best-effort:
// CDNs and shared IPs blur attribution.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { classifyProcess } from './processes';
import type { Adapter, AdapterCtx } from './types';

const execFileAsync = promisify(execFile);

// Known AI API endpoints → provider. Mirrors the process SIGNATURES table:
// add hosts here, capture and core code stay unchanged.
export const AI_ENDPOINTS = [
  { re: /(^|\.)openai\.com$|(^|\.)chatgpt\.com$|oaistatic|oaiusercontent/i, provider: 'openai', label: 'OpenAI' },
  { re: /(^|\.)anthropic\.com$|(^|\.)claude\.ai$/i, provider: 'anthropic', label: 'Anthropic' },
  { re: /generativelanguage\.googleapis\.com|(^|\.)gemini\.google\.com|makersuite|aistudio\.google/i, provider: 'google', label: 'Google Gemini' },
  { re: /copilot\.microsoft\.com|(^|\.)githubcopilot\.com/i, provider: 'microsoft', label: 'Copilot' },
  { re: /(^|\.)cohere\.(ai|com)$/i, provider: 'cohere', label: 'Cohere' },
  { re: /(^|\.)mistral\.ai$/i, provider: 'mistral', label: 'Mistral' },
  { re: /(^|\.)perplexity\.ai$/i, provider: 'perplexity', label: 'Perplexity' },
  { re: /(^|\.)x\.ai$|(^|\.)groq\.com$/i, provider: 'xai-groq', label: 'xAI / Groq' },
  { re: /(^|\.)together\.(ai|xyz)$|(^|\.)replicate\.com$|(^|\.)openrouter\.ai$/i, provider: 'aggregator', label: 'LLM aggregator' },
  { re: /huggingface\.co|(^|\.)hf\.co$/i, provider: 'huggingface', label: 'Hugging Face' },
];

export function classifyEndpoint(host: string | null): { provider: string; label: string } | null {
  if (!host) return null;
  for (const e of AI_ENDPOINTS) if (e.re.test(host)) return { provider: e.provider, label: e.label };
  return null;
}

export interface Conn {
  pid: number;
  name: string;
  ip: string;
  port: number;
  host: string | null;
}

const arr = (v: any): any[] => (Array.isArray(v) ? v : v == null ? [] : [v]);

const WIN_SCRIPT = [
  '$procs=@{};Get-Process -ErrorAction SilentlyContinue|ForEach-Object{$procs[$_.Id]=$_.ProcessName};',
  '$netError=$null;try{$raw=Get-NetTCPConnection -State Established -ErrorAction Stop}catch{$raw=@();$netError=$_.Exception.Message};',
  '$conns=$raw|',
  "Where-Object{$_.RemoteAddress -and $_.RemoteAddress -ne '127.0.0.1' -and $_.RemoteAddress -ne '::1' -and $_.RemoteAddress -notlike '0.*' -and $_.RemoteAddress -notlike 'fe80*'}|",
  'ForEach-Object{[pscustomobject]@{pid=$_.OwningProcess;name=$procs[[int]$_.OwningProcess];ip=[string]$_.RemoteAddress;port=$_.RemotePort}};',
  '$dns=Get-DnsClientCache -ErrorAction SilentlyContinue|Where-Object{$_.Data -and ($_.Type -eq 1 -or $_.Type -eq 28)}|ForEach-Object{[pscustomobject]@{n=$_.Entry;d=[string]$_.Data}};',
  '$missing=@($conns|Where-Object{-not $_.name}).Count;',
  "$visibility=if($netError){'unavailable'}elseif($missing -gt 0){'limited'}else{'os_visible'};",
  '[pscustomobject]@{conns=@($conns);dns=@($dns);visibility=$visibility;error=$netError;missing_owners=$missing}|ConvertTo-Json -Depth 4 -Compress',
].join('');

export type NetworkVisibility = "probing" | "os_visible" | "limited" | "unavailable";

export interface NetworkScanResult {
  connections: Conn[];
  visibility: NetworkVisibility;
  note: string | null;
}

export function parseWindowsScan(text: string): NetworkScanResult {
  if (!text || !text.trim()) {
    return {
      connections: [],
      visibility: "unavailable",
      note: "Windows socket query returned no capability result.",
    };
  }
  const obj = JSON.parse(text);
  const ipToHost = new Map<string, string>();
  for (const d of arr(obj.dns)) if (d && d.d) ipToHost.set(String(d.d), String(d.n));
  const connections = arr(obj.conns)
    .filter(Boolean)
    .map((c: any) => ({
      pid: Number(c.pid),
      name: c.name || '',
      ip: String(c.ip),
      port: Number(c.port),
      host: ipToHost.get(String(c.ip)) || null,
    }));
  const visibility: NetworkVisibility =
    obj.visibility === "unavailable" ? "unavailable"
      : obj.visibility === "limited" ? "limited"
        : "os_visible";
  const missing = Number(obj.missing_owners) || connections.filter((c) => !c.name).length;
  const note = visibility === "unavailable"
    ? "Windows denied or could not run its socket-table query. No connections are inferred from an empty result."
    : missing > 0
      ? `${missing} OS-visible connection${missing === 1 ? "" : "s"} had no readable owning-process name.`
      : "Shows sockets exposed by Windows to this account. Protected processes may still be absent.";
  return { connections, visibility, note };
}

export function parseWindows(text: string): Conn[] {
  return parseWindowsScan(text).connections;
}

/** macOS/Linux: lsof gives name+pid+remote; hosts stay numeric (best-effort). */
export function parseLsof(text: string): Conn[] {
  const out: Conn[] = [];
  for (const line of String(text).split('\n')) {
    const m = /^(\S+)\s+(\d+)\s+\S+\s+\S+\s+IPv[46]\s+\S+\s+\S+\s+TCP\s+\S+->(.+):(\d+)\s+\(ESTABLISHED\)/.exec(line);
    if (m) out.push({ pid: Number(m[2]), name: m[1], ip: m[3].replace(/[\[\]]/g, ''), port: Number(m[4]), host: null });
  }
  return out;
}

async function defaultScan(): Promise<NetworkScanResult> {
  if (process.platform === 'win32') {
    try {
      const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', WIN_SCRIPT], {
        maxBuffer: 8 * 1024 * 1024,
      });
      return parseWindowsScan(stdout);
    } catch {
      return {
        connections: [],
        visibility: "unavailable",
        note: "Windows socket-table query failed. No connections are inferred from an empty result.",
      };
    }
  }
  try {
    const { stdout } = await execFileAsync('lsof', ['-nP', '-iTCP', '-sTCP:ESTABLISHED'], {
      maxBuffer: 8 * 1024 * 1024,
    });
    const connections = parseLsof(stdout);
    return {
      connections,
      visibility: connections.length ? "os_visible" : "limited",
      note: connections.length
        ? "Shows sockets exposed by lsof to this account. Other users or protected processes may be absent."
        : "No readable socket rows. No-connection and permission-limited states cannot be distinguished without elevated access.",
    };
  } catch (e: any) {
    return {
      connections: [],
      visibility: e?.code === "ENOENT" ? "unavailable" : "limited",
      note: e?.code === "ENOENT"
        ? "lsof is unavailable, so this platform has no socket-table reader."
        : "Socket query returned no readable rows. Hidden processes are not reported as having no connections.",
    };
  }
  // WSL is the one place this reliably returns nothing, and it is not worth a
  // fallback: WSL2 virtualizes networking through the Windows host, so the
  // Linux socket table is genuinely empty — `lsof`, `ss` and `/proc/net/tcp`
  // all report zero established sockets while a download is in flight. There is
  // nothing there to read by any means. Run the tier from the Windows side on
  // such a machine; native Linux and macOS are unaffected.
}

export interface Relevance {
  ai_process: boolean;
  ai_endpoint: boolean;
  provider: string | null;
  label: string | null;
  runtime: string | null;
}

export interface NetworkAdapterOpts {
  pollMs?: number;
  all?: boolean;
  scan?: () => Promise<Conn[] | NetworkScanResult>;
  onVisibility?: (visibility: NetworkVisibility, note: string | null) => void;
}

export class NetworkAdapter implements Adapter {
  name = 'network';
  private pollMs: number;
  private all: boolean;
  private scan: () => Promise<Conn[] | NetworkScanResult>;
  private onVisibility?: (visibility: NetworkVisibility, note: string | null) => void;
  private known = new Map<string, { c: Conn; rel: Relevance }>();
  private ctx: AdapterCtx | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private warned = false;

  // all=false → only AI-relevant connections (a known AI process, or a known AI
  // endpoint) are surfaced, so the feed doesn't drown in ordinary traffic.
  constructor({ pollMs = 10000, all = false, scan = defaultScan, onVisibility }: NetworkAdapterOpts = {}) {
    this.pollMs = pollMs;
    this.all = all;
    this.scan = scan;
    this.onVisibility = onVisibility;
  }

  start(ctx: AdapterCtx) {
    this.ctx = ctx;
    const first = this.pollOnce();
    if (this.pollMs > 0) this.timer = setInterval(() => void this.pollOnce(), this.pollMs);
    return first;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.ctx = null;
  }

  /**
   * Widen or narrow what counts as worth surfacing, while running.
   *
   * `known` is cleared because it is the diff state for connect/close events:
   * keeping it across a scope change would emit a close for every non-AI
   * connection the moment you narrowed, and suppress the connects for ones
   * already open the moment you widened. Clearing means the next poll
   * re-announces the current world, which is what you actually want to see.
   */
  setAll(all: boolean) {
    if (all === this.all) return;
    this.all = all;
    this.known.clear();
  }

  /** Worth surfacing? A known AI process, a known AI endpoint, or everything
   *  when `all`. Returns the classification, or null to skip. */
  relevance(c: Conn): Relevance | null {
    const proc = classifyProcess({ name: c.name, command: c.name });
    const ep = classifyEndpoint(c.host);
    if (!proc && !ep && !this.all) return null;
    return {
      ai_process: !!proc,
      ai_endpoint: !!ep,
      provider: ep?.provider || proc?.provider || null,
      label: ep?.label || proc?.label || null,
      runtime: proc?.runtime || null,
    };
  }

  private emit(c: Conn, rel: Relevance, action: string, ts = Date.now()) {
    const host = c.host || c.ip;
    this.ctx?.emit({
      ts,
      agent_id: `net:${c.name || 'unknown'}`,
      parent_id: null,
      surface: 'network',
      action, // net_connect | net_close
      target: `${host}:${c.port}`,
      status: 'ok',
      payload: {
        pid: c.pid,
        process: c.name,
        remote_ip: c.ip,
        remote_host: c.host,
        remote_port: c.port,
        provider: rel.provider,
        label: rel.label,
        ai_endpoint: rel.ai_endpoint,
        ai_process: rel.ai_process,
        runtime: rel.runtime,
        fidelity: 'connection_metadata',
      },
    });
  }

  async pollOnce() {
    if (!this.ctx || this.busy) return;
    this.busy = true;
    try {
      const scanned = await this.scan();
      const result: NetworkScanResult = Array.isArray(scanned)
        ? {
            connections: scanned,
            visibility: "os_visible",
            note: "Shows sockets returned by the configured reader.",
          }
        : scanned;
      this.onVisibility?.(result.visibility, result.note);
      if (result.visibility === "unavailable") {
        this.warned = false;
        return;
      }
      const conns = result.connections;
      const current = new Map<string, { c: Conn; rel: Relevance }>();
      for (const c of conns) {
        const rel = this.relevance(c);
        if (!rel) continue;
        // Collapse ephemeral ports: key by process + endpoint, so reconnects to
        // the same host don't spam connect/close churn.
        const key = `${c.pid}|${c.host || c.ip}`;
        if (!current.has(key)) current.set(key, { c, rel });
      }
      for (const [key, { c, rel }] of current) if (!this.known.has(key)) this.emit(c, rel, 'net_connect');
      if (result.visibility === "os_visible") {
        for (const [key, { c, rel }] of this.known) if (!current.has(key)) this.emit(c, rel, 'net_close');
        this.known = current;
      } else {
        // A restricted snapshot cannot prove a previously seen socket closed.
        // Preserve prior state instead of converting missing privilege into a
        // fabricated close event.
        this.known = new Map([...this.known, ...current]);
      }
      this.warned = false;
    } catch (e: any) {
      this.onVisibility?.("unavailable", "Socket-table query failed. No connections are inferred from an empty result.");
      if (!this.warned) {
        this.warned = true;
        console.error(`[argus/network] scan failed: ${e?.message ?? e}`);
      }
    } finally {
      this.busy = false;
    }
  }
}
