#!/usr/bin/env node
// AgentGlass Argus integration — shell recorder.
//
// Origin: Argus pty/record.js — MIT © 2026 Zac Rieger. Ported to post at
// Argus integration's /env/pty intake instead of an OTLP log sink.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS ALONGSIDE agentglass's TERMINAL PANEL
//
// The terminal panel is better at what it does — xterm.js, tmux integration,
// persistent sessions — and this does not replace it. But the panel SPAWNS its
// PTY from the browser, so it can only ever show you a shell it started.
//
// This attaches to a terminal you are already sitting in. That covers the cases
// the panel structurally cannot:
//
//   * a shell you started before the dashboard was open
//   * an SSH session on another machine (run this on the far end)
//   * a CI step, a cron job, a sudo shell, a container exec
//   * anything where you want the transcript without moving your work
//
// The shell stays completely usable; every byte is mirrored to the dashboard.
//
// usage:
//   node tools/argus-record.mjs [--agent NAME] [--server URL] -- <cmd> [args...]
//   node tools/argus-record.mjs                 # wraps your default shell
//
// PTY source per OS (same `pty` tier either way):
//   macOS/Linux — the OS `script` utility (BSD and util-linux variants)
//   Windows     — ConPTY via node-pty if installed, else piped capture

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf("--" + name);
  return i > -1 ? argv[i + 1] : dflt;
};
const dashdash = argv.indexOf("--");
const cmd = dashdash > -1 ? argv.slice(dashdash + 1) : [];

const HOST = os.hostname().split(".")[0];
const AGENT = opt("agent", `shell:${HOST}:${process.pid}`);
const PARENT = opt("parent", null);
const SERVER = (opt("server", process.env.GLASSES_SERVER || "http://localhost:4000")).replace(/\/$/, "");
const TOKEN = process.env.AGENTGLASS_TOKEN || "";
const FLUSH_MS = 400;

const defaultShell = () =>
  process.platform === "win32"
    ? process.env.ComSpec || "powershell.exe"
    : process.env.SHELL || "/bin/sh";

const COMMAND = cmd.length ? cmd.join(" ") : defaultShell();

let seq = 0;
let warned = false;

async function ship(chunk, end = false) {
  const body = JSON.stringify({
    ts: Date.now(),
    agent: AGENT,
    parent: PARENT,
    command: COMMAND,
    host: HOST,
    pid: process.pid,
    seq: ++seq,
    chunk_b64: Buffer.from(chunk).toString("base64"),
    end,
  });
  try {
    await fetch(SERVER + "/env/pty", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
      },
      body,
    });
  } catch (e) {
    // Server down must never take the shell with it. Warn once, keep going —
    // the operator is in the middle of real work and a recorder that kills
    // their terminal is worse than no recorder.
    if (!warned) {
      warned = true;
      process.stderr.write(`[argus-record] cannot reach ${SERVER}: ${e.message} (shell continues)\n`);
    }
  }
}

/** Shared flush loop for the piped and ConPTY paths. */
function pump(readChunk) {
  let buffered = "";
  const flush = async (end = false) => {
    const chunk = buffered;
    buffered = "";
    if (chunk || end) await ship(chunk, end);
  };
  const timer = setInterval(flush, FLUSH_MS);
  return {
    push: (d) => { buffered += readChunk(d); },
    done: async (code) => {
      clearInterval(timer);
      await flush(true);
      process.exit(code ?? 0);
    },
  };
}

// ── Windows: ConPTY when available, piped capture otherwise ─────────────────
async function runWindows() {
  try {
    const pty = await import("node-pty");
    return runConPty(pty);
  } catch {
    process.stderr.write(
      "[argus-record] node-pty (ConPTY) not installed — using piped capture.\n" +
        "[argus-record] Interactive TTY fidelity (raw mode, cursor control) is\n" +
        "[argus-record] reduced; every byte of output is still recorded.\n" +
        "[argus-record] For full fidelity: bun add node-pty\n"
    );
    return runPiped();
  }
}

/** No PTY, zero native dependencies, works anywhere. Loses raw-mode fidelity. */
function runPiped() {
  const shellArgv = cmd.length ? cmd : [defaultShell()];
  const child = spawn(shellArgv[0], shellArgv.slice(1), { stdio: ["inherit", "pipe", "pipe"] });
  const p = pump((d) => d.toString("utf8"));
  const onData = (d) => { process.stdout.write(d); p.push(d); };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.on("error", (e) => {
    process.stderr.write(`[argus-record] cannot start ${shellArgv[0]}: ${e.message}\n`);
    process.exit(1);
  });
  child.on("exit", (code) => void p.done(code));
}

function runConPty(pty) {
  const shellArgv = cmd.length ? cmd : [defaultShell()];
  const term = pty.spawn(shellArgv[0], shellArgv.slice(1), {
    name: "xterm-color",
    cols: process.stdout.columns || 120,
    rows: process.stdout.rows || 30,
    cwd: process.cwd(),
    env: process.env,
  });
  const p = pump((d) => d);
  term.onData((d) => { process.stdout.write(d); p.push(d); });
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.on("data", (d) => term.write(d.toString("utf8")));
  process.stdout.on("resize", () => term.resize(process.stdout.columns || 120, process.stdout.rows || 30));
  term.onExit(({ exitCode }) => {
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    void p.done(exitCode);
  });
}

// ── macOS / Linux: the OS `script` utility ──────────────────────────────────
function runScript() {
  const recFile = path.join(os.tmpdir(), `argus-record-${process.pid}.rec`);
  fs.writeFileSync(recFile, "");

  // BSD `script` (macOS) takes the command argv; util-linux takes -c "string".
  const scriptArgs =
    process.platform === "darwin"
      ? ["-q", "-F", recFile, ...(cmd.length ? cmd : [defaultShell()])]
      : ["-q", "-f", ...(cmd.length ? ["-c", cmd.join(" ")] : []), recFile];

  const child = spawn("script", scriptArgs, { stdio: "inherit" });

  let offset = 0;
  const drain = async (end = false) => {
    try {
      const stat = fs.statSync(recFile);
      if (stat.size > offset) {
        const fd = fs.openSync(recFile, "r");
        const buf = Buffer.alloc(stat.size - offset);
        fs.readSync(fd, buf, 0, buf.length, offset);
        fs.closeSync(fd);
        offset = stat.size;
        // Drop the ^D/^H control artifacts `script` prepends on macOS.
        await ship(buf.toString("utf8").replace(/[\x00\x04\x08]/g, ""), end);
      } else if (end) {
        await ship("", true);
      }
    } catch (e) {
      process.stderr.write(`[argus-record] drain error: ${e.message}\n`);
    }
  };
  const timer = setInterval(drain, FLUSH_MS);

  child.on("exit", (code) => {
    clearInterval(timer);
    // Let `script` finish its final write before the last drain.
    setTimeout(async () => {
      await drain(true);
      fs.rmSync(recFile, { force: true });
      process.exit(code ?? 0);
    }, 150);
  });
}

process.stderr.write(`[argus-record] recording "${COMMAND}" as ${AGENT} → ${SERVER}\n`);
if (process.platform === "win32") await runWindows();
else runScript();
