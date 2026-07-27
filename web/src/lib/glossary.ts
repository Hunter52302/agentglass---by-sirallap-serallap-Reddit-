export type GlossaryEntry = {
  term: string;
  definition: string;
};

/**
 * Owner-facing definitions inherited from Argus's original in-place glossary.
 *
 * Keep these local and static: learning a term should not send selected UI text
 * to a third-party dictionary service. The wording follows Argus's passive
 * identity boundary and never upgrades weak evidence into attribution.
 */
export const GLOSSARY: Record<string, GlossaryEntry> = {
  agent: {
    term: "Agent",
    definition: "A program using a model to plan or act. AgentGlass names an agent from its own telemetry; Argus does not guess an agent from nearby machine activity.",
  },
  agent_id: {
    term: "Agent ID",
    definition: "The identifier an agent or telemetry source declared for an actor. It is declared provenance, not proof of a person or physical device.",
  },
  ai_endpoint: {
    term: "AI endpoint",
    definition: "A remote host that matches a known AI service domain. This labels the destination; it does not reveal the request contents or why a process connected.",
  },
  argus: {
    term: "Argus",
    definition: "AgentGlass's passive runtime lens. It shows OS-visible process, socket, shell, and opt-in filesystem metadata beside agent-declared activity.",
  },
  attribution: {
    term: "Attribution",
    definition: "A statement about who caused an event. Argus keeps observed and declared evidence separate and leaves the actor unknown when the evidence cannot support a link.",
  },
  blind: {
    term: "Blind runtime",
    definition: "A recognized agent runtime is visible in the process table but is not reporting enough telemetry to show what it is doing.",
  },
  cache: {
    term: "Prompt cache",
    definition: "Previously processed model input reused to reduce repeated work. Cache-read and cache-write tokens can have different prices from normal input tokens.",
  },
  client_identity: {
    term: "Client identity",
    definition: "A random local browser-profile pseudonym recorded with control decisions. It shows profile continuity, not a physical device, person, tab, or intent.",
  },
  connection_metadata: {
    term: "Connection metadata",
    definition: "The process, destination address, and port exposed by the OS socket table. It never includes packet or TLS contents.",
  },
  context_window: {
    term: "Context window",
    definition: "The maximum amount of text and other tokenized input a model can consider in one request.",
  },
  correlation: {
    term: "Correlation",
    definition: "Placing observations near declarations using time, path, or process evidence. Correlation adds context; it does not by itself prove causation.",
  },
  cost: {
    term: "Cost",
    definition: "An estimated charge computed from reported token use and the selected model's pricing. Missing model or usage data can make it incomplete.",
  },
  declared: {
    term: "Declared activity",
    definition: "What an agent or integration says it did, such as a tool call naming a file. Argus keeps this separate from what the operating system exposed.",
  },
  degraded: {
    term: "Degraded visibility",
    definition: "A sensor returned less evidence than normal because of platform or permission limits. Argus labels the limit instead of treating missing data as no activity.",
  },
  diff: {
    term: "Diff",
    definition: "A comparison showing what lines changed. Argus's passive filesystem watcher does not read or store file contents; detailed diffs come from declared agent telemetry.",
  },
  evidence: {
    term: "Evidence",
    definition: "The source supporting a label, such as a process table, socket owner, filesystem observer, operator attachment, or agent declaration.",
  },
  fidelity: {
    term: "Fidelity",
    definition: "How much a sensor truly reveals. Process presence, socket ownership, and agent-declared tool calls have different fidelity and are not treated as interchangeable.",
  },
  filesystem: {
    term: "Filesystem",
    definition: "Files and directories on disk. Argus filesystem observation is optional, metadata-only, and often cannot identify the writer process.",
  },
  fs: {
    term: "FS (filesystem)",
    definition: "Short for filesystem: the files and directories stored on disk.",
  },
  fs_create: {
    term: "fs_create",
    definition: "A path appeared in the watched filesystem scope. The watcher reports the path but may not know which process created it.",
  },
  fs_delete: {
    term: "fs_delete",
    definition: "A path disappeared from the watched filesystem scope. This observation does not prove which process removed it.",
  },
  fs_write: {
    term: "fs_write",
    definition: "The filesystem observer saw a path change. On common OS watcher APIs the writer PID is unavailable, so the actor remains unknown.",
  },
  gate: {
    term: "Gate",
    definition: "AgentGlass's approval checkpoint for a proposed tool action. A held request waits for an explicit allow or deny decision.",
  },
  kill: {
    term: "Kill",
    definition: "Force-stop a process tree. Argus exposes this only after a user redline matched a held request with an agent-associated PID, and only after an explicit operator action.",
  },
  lane: {
    term: "Actor lane",
    definition: "A grouped timeline for one observed or declared actor label. Its evidence and confidence describe how that label was obtained.",
  },
  live: {
    term: "Live follow",
    definition: "An optional map camera mode. When enabled, it smoothly moves to the most recently active agent node; when off, your pan and zoom stay untouched.",
  },
  map: {
    term: "Map",
    definition: "A spatial filesystem view where agent-declared file touches form trails. Position shows where reported work occurred; it does not turn proximity into attribution.",
  },
  model: {
    term: "Model",
    definition: "The language or multimodal model used for a request, such as a Claude, GPT, Gemini, or local model.",
  },
  net_connect: {
    term: "net_connect",
    definition: "The OS socket table exposed an outbound connection. Argus records the visible owner and destination metadata, never the traffic contents.",
  },
  net_close: {
    term: "net_close",
    definition: "A previously visible socket no longer appeared in a successful scan. Failed or unavailable scans do not fabricate close events.",
  },
  node: {
    term: "Node",
    definition: "A place represented on the map, usually a file or directory. Agent markers rest on the latest node named by their telemetry.",
  },
  node_id: {
    term: "Node ID",
    definition: "Argus's stable identifier for an observed place or process, often derived from a normalized path or PID.",
  },
  observed: {
    term: "Observed activity",
    definition: "Metadata the operating system or an attached recorder exposed. An observation may remain unattributed when it carries no reliable actor identity.",
  },
  operator_expanded: {
    term: "Operator-expanded scope",
    definition: "A user-chosen wider passive lens, such as OS-visible network processes or a broad filesystem root. It changes scope, not privileges or authority.",
  },
  otlp: {
    term: "OTLP",
    definition: "OpenTelemetry Protocol, a standard format programs use to export traces, metrics, and logs.",
  },
  payload: {
    term: "Payload",
    definition: "The structured detail attached to an event. AgentGlass bounds stored values, and Argus filesystem observations exclude file contents.",
  },
  pid: {
    term: "Process ID (PID)",
    definition: "The operating system's number for one running process instance. PIDs can be reused after a process exits, so time and process evidence still matter.",
  },
  ppid: {
    term: "Parent process ID (PPID)",
    definition: "The PID of the process that started another process. It helps describe a process tree but does not reveal prompts, intent, or all ownership relationships.",
  },
  process: {
    term: "Process",
    definition: "A running program managed by the operating system. Argus can observe selected process metadata without reading the program's private contents.",
  },
  process_discovered: {
    term: "process_discovered",
    definition: "A recognized runtime appeared in a successful OS process scan, or was already present when observation began.",
  },
  process_stopped: {
    term: "process_stopped",
    definition: "A previously observed runtime was absent from a later successful process scan.",
  },
  provenance: {
    term: "Provenance",
    definition: "Where information came from. Argus shows agent declarations beside machine observations while preserving the source of each.",
  },
  provider: {
    term: "Provider",
    definition: "The company or project behind a model or runtime, such as Anthropic, OpenAI, Google, or a local model server.",
  },
  pty: {
    term: "PTY (pseudo-terminal)",
    definition: "A software terminal interface used by shells and terminal apps. Argus records a PTY only when the operator explicitly attaches it or the agent owns it.",
  },
  redline: {
    term: "Redline",
    definition: "A user-owned rule that labels or gates a proposed action. Matching never kills automatically; the narrow kill control requires an explicit operator decision.",
  },
  remote_host: {
    term: "Remote host",
    definition: "The destination name associated with a socket address when the OS or resolver makes one available. Shared infrastructure can make the name incomplete.",
  },
  replay: {
    term: "Replay",
    definition: "A reconstruction of Argus observations at an earlier time from its append-only event history.",
  },
  runtime: {
    term: "Runtime",
    definition: "A recognized program that runs an agent, model app, or local model service. Recognition comes from process signatures, not from reading prompts or output.",
  },
  session: {
    term: "Session",
    definition: "One agent conversation or run grouped under a stable identifier supplied by its integration.",
  },
  socket: {
    term: "Socket",
    definition: "An operating-system endpoint for network communication. Socket tables can expose addresses, ports, and sometimes an owning PID, but not encrypted contents.",
  },
  span: {
    term: "Span",
    definition: "One timed unit of work in a trace, such as a model request or tool call, with a start, end, and attributes.",
  },
  telemetry: {
    term: "Telemetry",
    definition: "Structured data a program deliberately reports about its activity. It is declared evidence and remains distinct from passive OS observations.",
  },
  tls: {
    term: "TLS",
    definition: "Transport Layer Security, the encryption used by HTTPS and many APIs. Argus does not intercept or decrypt TLS traffic.",
  },
  token: {
    term: "Token",
    definition: "A small unit of model input or output. A token may be part of a word, a whole word, punctuation, or encoded non-text data.",
  },
  tool_call: {
    term: "Tool call",
    definition: "A structured request from an agent to use a capability such as reading a file, editing text, or running a command.",
  },
  trail: {
    term: "Agent trail",
    definition: "The recent sequence of file nodes named by one agent session's tool telemetry, drawn oldest to newest.",
  },
  unattributed: {
    term: "Unattributed",
    definition: "An event was observed without enough evidence to name its actor. Unknown does not mean hostile, suspicious, or caused by an agent.",
  },
  writer_unknown: {
    term: "Writer unknown",
    definition: "A filesystem event arrived without a writer PID. Argus preserves that limit instead of guessing which nearby process caused it.",
  },
};

export function normalizeGlossaryTerm(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9_ -]/g, "")
    .trim()
    .replace(/[- ]+/g, "_");
}

const tokens = (text: string): string[] =>
  text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/**
 * Resolve a selected word. Exact and singular matches win. Otherwise offer
 * compound terms containing the word, with compounds visible in the clicked
 * element ordered first.
 */
export function glossaryCandidates(raw: string, contextText = ""): string[] {
  const word = normalizeGlossaryTerm(raw);
  if (!word) return [];
  if (GLOSSARY[word]) return [word];
  const singular = word.endsWith("s") ? word.slice(0, -1) : word;
  if (GLOSSARY[singular]) return [singular];

  const context = new Set(tokens(contextText));
  const contextual: string[] = [];
  const related: string[] = [];
  for (const key of Object.keys(GLOSSARY)) {
    const parts = key.split("_");
    if (parts.length < 2 || !parts.includes(word)) continue;
    (parts.every((part) => context.has(part)) ? contextual : related).push(key);
  }
  return [...contextual, ...related];
}
