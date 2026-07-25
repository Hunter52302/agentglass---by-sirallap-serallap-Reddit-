// Serrallapa for Argus — passive LLM/agent process discovery.
//
// Origin: Argus src/processes.js — MIT © 2026 Zac Rieger.
// Ported to TypeScript; detection logic and signatures unchanged so this file
// stays diffable against Argus upstream.
//
// WHAT THIS ADDS TO AGENTGLASS: agentglass sees an agent when the agent tells
// it something — a hook fires, an OTLP span arrives, a transcript appears. A
// runtime that was never wired is completely invisible to it. This adapter
// reads the OS process table, so an Ollama, an LM Studio, or an unwired Claude
// Code shows up whether or not it cooperates.
//
// HONEST LIMIT: this proves PRESENCE ONLY. A process name cannot reveal
// prompts, tool calls, model output, or intent. Command lines are inspected
// locally for classification and never stored unless explicitly opted in, and
// even then only for recognized AI processes, with secrets scrubbed first.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Adapter, AdapterCtx } from './types';

const execFileAsync = promisify(execFile);

export interface Signature {
  runtime: string;
  provider: string;
  label: string;
  kind: 'agent' | 'desktop' | 'model-runtime';
  test: (s: string) => boolean;
}

// Known local LLM applications and runtimes. Add signatures here; capture and
// core code stay unchanged.
export const SIGNATURES: Signature[] = [
  {
    runtime: 'claude-code',
    provider: 'anthropic',
    label: 'Claude Code',
    kind: 'agent',
    test: (s) =>
      /[/\\]claude-code[/\\].*[/\\]claude(?:\.exe)?(?:\s|$)/i.test(s) ||
      /(?:^|\s)claude(?:\.exe)?(?:\s|$)/i.test(s),
  },
  {
    runtime: 'claude-desktop',
    provider: 'anthropic',
    label: 'Claude Desktop',
    kind: 'desktop',
    test: (s) =>
      /[/\\]Claude\.app[/\\]Contents[/\\]MacOS[/\\]Claude(?:\s|$)/i.test(s) ||
      /(?:^|[/\\])Claude\.exe(?:\s|$)/i.test(s),
  },
  {
    runtime: 'chatgpt-desktop',
    provider: 'openai',
    label: 'ChatGPT Desktop',
    kind: 'desktop',
    test: (s) =>
      /[/\\]ChatGPT\.app[/\\]Contents[/\\]MacOS[/\\]ChatGPT(?:\s|$)/i.test(s) ||
      /(?:^|[/\\])ChatGPT\.exe(?:\s|$)/i.test(s),
  },
  {
    runtime: 'codex',
    provider: 'openai',
    label: 'Codex',
    kind: 'agent',
    test: (s) =>
      /(?:^|[/\\\s])codex(?:\.exe)?(?:\s|$)/i.test(s) &&
      !/Codex (?:Framework|Service|Renderer|Computer Use)/i.test(s),
  },
  {
    // Windows Copilot / Microsoft Copilot desktop app (Store package
    // Microsoft.Copilot_… → Copilot.exe). Matches the exe as a path segment so
    // a "copilot.microsoft.com" URL in some other process's args can't
    // false-positive (that's a browser tab, not the Copilot process).
    runtime: 'windows-copilot',
    provider: 'microsoft',
    label: 'Windows Copilot',
    kind: 'desktop',
    test: (s) => /(?:^|[/\\])(?:Copilot|Microsoft\.Copilot)(?:\.exe)?(?:\s|$)/i.test(s),
  },
  {
    // GitHub Copilot: the coding agent's language server, or the `gh copilot`
    // CLI. The editor extension proper runs inside the editor and is only
    // visible via that host process's ancestry.
    runtime: 'github-copilot',
    provider: 'github',
    label: 'GitHub Copilot',
    kind: 'agent',
    test: (s) =>
      /copilot-language-server(?:\.exe)?/i.test(s) ||
      /(?:^|[/\\\s])gh(?:\.exe)?\s+copilot(?:\s|$)/i.test(s),
  },
  {
    runtime: 'ollama',
    provider: 'ollama',
    label: 'Ollama',
    kind: 'model-runtime',
    test: (s) =>
      /(?:^|[/\\\s])ollama(?:\.exe)?(?:\s|$)/i.test(s) || /ollama_llama_server/i.test(s),
  },
  {
    runtime: 'lm-studio',
    provider: 'lm-studio',
    label: 'LM Studio',
    kind: 'model-runtime',
    test: (s) => /LM Studio(?:\.exe|\.app)?/i.test(s) || /[/\\]lms(?:\.exe)?(?:\s|$)/i.test(s),
  },
  {
    runtime: 'llama.cpp',
    provider: 'llama.cpp',
    label: 'llama.cpp',
    kind: 'model-runtime',
    test: (s) => /(?:^|[/\\\s])llama-(?:server|cli|main)(?:\.exe)?(?:\s|$)/i.test(s),
  },
  {
    runtime: 'localai',
    provider: 'localai',
    label: 'LocalAI',
    kind: 'model-runtime',
    test: (s) => /(?:^|[/\\\s])local-?ai(?:\.exe)?(?:\s|$)/i.test(s),
  },
  {
    runtime: 'vllm',
    provider: 'vllm',
    label: 'vLLM',
    kind: 'model-runtime',
    // `\b` rather than `(?:\s|$)`. vLLM's documented launch is
    // `python -m vllm.entrypoints.api_server`, where `vllm` is followed by a
    // DOT — so requiring whitespace-or-end meant the single most common way to
    // start vLLM was never detected at all.
    test: (s) =>
      /(?:^|[/\\\s])vllm(?:\.exe)?\b/i.test(s) ||
      /python(?:\d+(?:\.\d+)?)?\s+-m\s+vllm\b/i.test(s),
  },
  {
    runtime: 'mlx-lm',
    provider: 'mlx',
    label: 'MLX LM',
    kind: 'model-runtime',
    test: (s) => /(?:^|[/\\\s])mlx_lm\.(?:server|generate|chat)(?:\s|$)/i.test(s),
  },
];

/** Best-effort scrub of secrets that routinely ride in argv, so opt-in command
 *  visibility can't leak an API key even for a recognized AI process. */
export function redactSecrets(s: string): string {
  return String(s)
    .replace(
      /((?:api[_-]?key|apikey|token|secret|password|passwd|pwd|authorization|auth|bearer)\s*[=:]\s*)("?)([^\s"']+)\2/gi,
      '$1$2***redacted***$2'
    )
    // Separator is `[-_]`, not `-`. GitHub's tokens are `ghp_…`/`gho_…` with an
    // UNDERSCORE, so a hyphen-only pattern let every GitHub token through
    // unredacted — the exact leak this function exists to prevent. OpenAI uses
    // `sk-` and Slack `xoxb-`, hence both separators.
    .replace(/\b(sk|pk|ghp|gho|ghu|ghs|ghr|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{6,}/g, '$1_***redacted***')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, 'jwt-***redacted***')
    .slice(0, 400);
}

export interface RawProc {
  pid: string | number;
  ppid: string | number | null;
  command: string;
}

export interface KnownProc {
  pid: string;
  ppid: string | null;
  runtime: string;
  provider: string;
  label: string;
  runtime_kind: string;
  command?: string;
  parent_process_id?: string;
}

export function classifyProcess(proc: { pid?: any; ppid?: any; command?: any; name?: any }): KnownProc | null {
  const privateText = String(proc.command || proc.name || '');
  if (/[/\\]Contents[/\\]Helpers[/\\]disclaimer(?:\s|$)/i.test(privateText)) return null;
  const match = SIGNATURES.find((s) => s.test(privateText));
  if (!match) return null;
  return {
    pid: String(proc.pid),
    ppid: proc.ppid == null ? null : String(proc.ppid),
    runtime: match.runtime,
    provider: match.provider,
    label: match.label,
    runtime_kind: match.kind,
    // kept for the opt-in command view; only reaches an event when includeCommand
    command: privateText,
  };
}

function parseUnixProcesses(text: string): RawProc[] {
  const out: RawProc[] = [];
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (m) out.push({ pid: m[1], ppid: m[2], command: m[3] });
  }
  return out;
}

function parseWindowsProcesses(text: string): RawProc[] {
  if (!text.trim()) return [];
  const parsed = JSON.parse(text);
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows.map((p: any) => ({
    pid: p.ProcessId,
    ppid: p.ParentProcessId,
    command: p.CommandLine || p.ExecutablePath || p.Name || '',
  }));
}

export async function scanLlmProcesses(): Promise<KnownProc[]> {
  let raw: RawProc[];
  if (process.platform === 'win32') {
    const script =
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress';
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', script], {
      maxBuffer: 8 * 1024 * 1024,
    });
    raw = parseWindowsProcesses(stdout);
  } else {
    const { stdout } = await execFileAsync('ps', ['-ww', '-axo', 'pid=,ppid=,command='], {
      maxBuffer: 8 * 1024 * 1024,
    });
    raw = parseUnixProcesses(stdout);
  }

  const all = new Map(raw.map((p) => [String(p.pid), p]));
  const found = raw.map(classifyProcess).filter(Boolean) as KnownProc[];
  const byPid = new Map(found.map((p) => [p.pid, p]));

  // Link through unclassified helpers to the nearest known LLM ancestor, so a
  // bundled worker is shown under the desktop app that spawned it.
  for (const p of found) {
    let parent = p.ppid == null ? undefined : all.get(p.ppid);
    const seen = new Set<string>();
    while (parent && !seen.has(String(parent.pid))) {
      seen.add(String(parent.pid));
      const known = byPid.get(String(parent.pid));
      if (known) {
        p.parent_process_id = known.pid;
        break;
      }
      parent = all.get(String(parent.ppid));
    }
  }
  return found;
}

export interface OllamaModel {
  name: string;
  model: string;
  digest: string | null;
  size: number | null;
  size_vram: number | null;
  context_length: number | null;
  family: string | null;
  parameter_size: string | null;
  quantization_level: string | null;
  expires_at: string | null;
}

export async function probeOllama(
  baseUrl = 'http://127.0.0.1:11434'
): Promise<OllamaModel[] | null> {
  try {
    const res = await fetch(baseUrl.replace(/\/$/, '') + '/api/ps', {
      signal: AbortSignal.timeout(800),
    });
    if (!res.ok) return null;
    const body: any = await res.json();
    return (body.models || []).map((m: any) => ({
      name: String(m.name || m.model || 'unknown'),
      model: String(m.model || m.name || 'unknown'),
      digest: m.digest || null,
      size: Number(m.size) || null,
      size_vram: Number(m.size_vram) || null,
      context_length: Number(m.context_length) || null,
      family: m.details?.family || null,
      parameter_size: m.details?.parameter_size || null,
      quantization_level: m.details?.quantization_level || null,
      expires_at: m.expires_at || null,
    }));
  } catch {
    return null;
  }
}

const processId = (p: { runtime: string; pid: string }) => `process:${p.runtime}:${p.pid}`;

export interface ProcessAdapterOpts {
  pollMs?: number;
  scan?: () => Promise<KnownProc[]>;
  ollamaProbe?: (url?: string) => Promise<OllamaModel[] | null>;
  ollamaUrl?: string;
  includeCommand?: boolean;
}

export class ProcessAdapter implements Adapter {
  name = 'process';
  private pollMs: number;
  private scan: () => Promise<KnownProc[]>;
  private ollamaProbe: (url?: string) => Promise<OllamaModel[] | null>;
  private ollamaUrl?: string;
  private includeCommand: boolean;
  private known = new Map<string, KnownProc>();
  private models = new Map<string, Map<string, OllamaModel>>();
  private ctx: AdapterCtx | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private warned = false;

  constructor({
    pollMs = 5000,
    scan = scanLlmProcesses,
    ollamaProbe = probeOllama,
    ollamaUrl,
    includeCommand = false,
  }: ProcessAdapterOpts = {}) {
    this.pollMs = pollMs;
    this.scan = scan;
    this.ollamaProbe = ollamaProbe;
    this.ollamaUrl = ollamaUrl;
    this.includeCommand = includeCommand;
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

  private emitProcess(p: KnownProc, action: string, ts = Date.now()) {
    const id = processId(p);
    const parent = p.parent_process_id ? this.known.get(String(p.parent_process_id)) : null;
    this.ctx?.emit({
      ts,
      agent_id: id,
      parent_id: parent ? processId(parent) : null,
      surface: 'process',
      action,
      target: p.label,
      status: 'ok',
      payload: {
        node_id: id,
        node_kind: 'process',
        pid: p.pid === 'api' ? null : Number(p.pid),
        ppid: p.ppid == null ? null : Number(p.ppid),
        runtime: p.runtime,
        provider: p.provider,
        label: p.label,
        runtime_kind: p.runtime_kind,
        source: p.pid === 'api' ? 'local_api' : 'process_table',
        fidelity: 'presence_only',
        // opt-in: the recognized AI process's launch command, secrets scrubbed
        ...(this.includeCommand && p.command ? { command: redactSecrets(p.command) } : {}),
      },
    });
  }

  private emitModel(runtime: KnownProc, action: string, model: OllamaModel, ts = Date.now()) {
    const id = processId(runtime);
    this.ctx?.emit({
      ts,
      agent_id: id,
      parent_id: null,
      surface: 'process',
      action,
      target: model.name,
      status: 'ok',
      payload: {
        node_id: id,
        node_kind: 'process',
        runtime: runtime.runtime,
        provider: runtime.provider,
        label: runtime.label,
        model,
        fidelity: 'runtime_api',
      },
    });
  }

  async pollOnce() {
    if (!this.ctx || this.busy) return;
    this.busy = true;
    try {
      const scanned = await this.scan();
      const current = new Map(scanned.map((p) => [p.pid, p]));
      const ollamaModels = await this.ollamaProbe(this.ollamaUrl);
      let ollama = [...current.values()].find((p) => p.runtime === 'ollama');
      if (ollamaModels && !ollama) {
        // Ollama reachable over its API but absent from the process table —
        // containerized or remote. Still real, so it gets a node.
        ollama = {
          pid: 'api',
          ppid: null,
          runtime: 'ollama',
          provider: 'ollama',
          label: 'Ollama',
          runtime_kind: 'model-runtime',
        };
        current.set(ollama.pid, ollama);
      }

      const previous = this.known;
      this.known = current; // lets discovery events resolve current parents
      // Publish parents before children so the hierarchy is complete.
      for (const p of current.values()) {
        if (!previous.has(p.pid)) this.emitProcess(p, 'process_discovered');
      }

      if (ollama && ollamaModels) {
        const id = processId(ollama);
        const before = this.models.get(id) || new Map<string, OllamaModel>();
        const after = new Map(ollamaModels.map((m) => [m.digest || m.name, m]));
        for (const [key, model] of after) if (!before.has(key)) this.emitModel(ollama, 'model_loaded', model);
        for (const [key, model] of before) if (!after.has(key)) this.emitModel(ollama, 'model_unloaded', model);
        this.models.set(id, after);
      }

      for (const p of previous.values()) {
        if (!current.has(p.pid)) {
          const id = processId(p);
          for (const model of (this.models.get(id) || new Map<string, OllamaModel>()).values()) {
            this.emitModel(p, 'model_unloaded', model);
          }
          this.models.delete(id);
          this.emitProcess(p, 'process_stopped');
        }
      }
      this.warned = false;
    } catch (e: any) {
      if (!this.warned) {
        this.warned = true;
        console.error(`[argus/process] scan failed: ${e?.message ?? e}`);
      }
    } finally {
      this.busy = false;
    }
  }
}
