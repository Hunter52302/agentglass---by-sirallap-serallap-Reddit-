// Glasses for Argus — outbound connection (network) discovery.
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
  '$procs=@{};Get-Process|ForEach-Object{$procs[$_.Id]=$_.ProcessName};',
  '$conns=Get-NetTCPConnection -State Established -ErrorAction SilentlyContinue|',
  "Where-Object{$_.RemoteAddress -and $_.RemoteAddress -ne '127.0.0.1' -and $_.RemoteAddress -ne '::1' -and $_.RemoteAddress -notlike '0.*' -and $_.RemoteAddress -notlike 'fe80*'}|",
  'ForEach-Object{[pscustomobject]@{pid=$_.OwningProcess;name=$procs[[int]$_.OwningProcess];ip=[string]$_.RemoteAddress;port=$_.RemotePort}};',
  '$dns=Get-DnsClientCache -ErrorAction SilentlyContinue|Where-Object{$_.Data -and ($_.Type -eq 1 -or $_.Type -eq 28)}|ForEach-Object{[pscustomobject]@{n=$_.Entry;d=[string]$_.Data}};',
  '[pscustomobject]@{conns=@($conns);dns=@($dns)}|ConvertTo-Json -Depth 4 -Compress',
].join('');

export function parseWindows(text: string): Conn[] {
  if (!text || !text.trim()) return [];
  const obj = JSON.parse(text);
  const ipToHost = new Map<string, string>();
  for (const d of arr(obj.dns)) if (d && d.d) ipToHost.set(String(d.d), String(d.n));
  return arr(obj.conns)
    .filter(Boolean)
    .map((c: any) => ({
      pid: Number(c.pid),
      name: c.name || '',
      ip: String(c.ip),
      port: Number(c.port),
      host: ipToHost.get(String(c.ip)) || null,
    }));
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

async function defaultScan(): Promise<Conn[]> {
  if (process.platform === 'win32') {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', WIN_SCRIPT], {
      maxBuffer: 8 * 1024 * 1024,
    });
    return parseWindows(stdout);
  }
  try {
    const { stdout } = await execFileAsync('lsof', ['-nP', '-iTCP', '-sTCP:ESTABLISHED'], {
      maxBuffer: 8 * 1024 * 1024,
    });
    return parseLsof(stdout);
  } catch {
    return []; // an ss-based Linux fallback can be added as its own adapter
  }
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
  scan?: () => Promise<Conn[]>;
}

export class NetworkAdapter implements Adapter {
  name = 'network';
  private pollMs: number;
  private all: boolean;
  private scan: () => Promise<Conn[]>;
  private known = new Map<string, { c: Conn; rel: Relevance }>();
  private ctx: AdapterCtx | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private warned = false;

  // all=false → only AI-relevant connections (a known AI process, or a known AI
  // endpoint) are surfaced, so the feed doesn't drown in ordinary traffic.
  constructor({ pollMs = 10000, all = false, scan = defaultScan }: NetworkAdapterOpts = {}) {
    this.pollMs = pollMs;
    this.all = all;
    this.scan = scan;
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
      const conns = await this.scan();
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
      for (const [key, { c, rel }] of this.known) if (!current.has(key)) this.emit(c, rel, 'net_close');
      this.known = current;
      this.warned = false;
    } catch (e: any) {
      if (!this.warned) {
        this.warned = true;
        console.error(`[argus/network] scan failed: ${e?.message ?? e}`);
      }
    } finally {
      this.busy = false;
    }
  }
}
