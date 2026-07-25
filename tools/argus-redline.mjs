#!/usr/bin/env node
/**
 * Argus user-redline manager.
 *
 * Examples:
 *   node tools/argus-redline.mjs list
 *   node tools/argus-redline.mjs add-command no-force-push "git\\s+push.*(--force|-f)" --kill
 *   node tools/argus-redline.mjs protect secrets .env --ops write,delete --kill
 *   node tools/argus-redline.mjs protect ssh ~/.ssh --ops create,write,delete
 *   node tools/argus-redline.mjs disable ssh
 *   node tools/argus-redline.mjs remove ssh
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const cwd = process.cwd();
const file = process.env.GLASSES_REDLINES || path.resolve(cwd, "redlines.json");
const server = (process.env.GLASSES_SERVER || "http://localhost:4000").replace(/\/$/, "");

function read() {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Array.isArray(parsed)) throw new Error("redlines file must contain a JSON array");
    return parsed;
  } catch (e) {
    if (e?.code === "ENOENT") return [];
    throw e;
  }
}

function write(rules) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rules, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}

async function reload() {
  try {
    const r = await fetch(server + "/env/redlines/reload", {
      method: "POST",
      headers: { "content-type": "application/json", origin: server },
      body: "{}",
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    console.log(`Reloaded Argus at ${server}`);
  } catch (e) {
    console.log(`Saved. Argus reload unavailable (${e?.message || e}); restart or use the cockpit reload control.`);
  }
}

function option(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
function has(name) { return process.argv.includes(name); }
function decision() { return has("--kill") ? "kill" : has("--flag") ? "flag" : "gate"; }
function expandHome(p) { return p?.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p; }

const [cmd, id, value] = process.argv.slice(2);
const rules = read();

if (!cmd || cmd === "help" || cmd === "--help") {
  console.log(`Argus redline manager\n\n` +
    `list\n` +
    `add-command <id> <regex> [--action <regex>] [--kill|--flag] [--description <text>]\n` +
    `protect <id> <path-or-regex> [--regex] [--ops create,write,delete] [--kill|--flag] [--description <text>]\n` +
    `enable <id> | disable <id> | remove <id>\n\n` +
    `Default decision is gate. --kill denies and stops a verified process tree; --flag records only.`);
  process.exit(0);
}

if (cmd === "list") {
  if (!rules.length) console.log("No redlines configured.");
  for (const r of rules) {
    console.log(`${r.enabled === false ? "off" : "on "}  ${r.id}  ${r.decision || (r.kill ? "kill" : "gate")}  ${r.description || ""}`);
  }
  process.exit(0);
}

if (!id) throw new Error("rule id required");
const existing = rules.findIndex((r) => String(r.id) === id);

if (cmd === "remove") {
  if (existing < 0) throw new Error(`no redline named ${id}`);
  rules.splice(existing, 1);
  write(rules);
  console.log(`Removed ${id}`);
  await reload();
  process.exit(0);
}

if (cmd === "enable" || cmd === "disable") {
  if (existing < 0) throw new Error(`no redline named ${id}`);
  rules[existing].enabled = cmd === "enable";
  write(rules);
  console.log(`${cmd === "enable" ? "Enabled" : "Disabled"} ${id}`);
  await reload();
  process.exit(0);
}

let rule;
if (cmd === "add-command") {
  if (!value) throw new Error("command regex required");
  // Validate before writing.
  new RegExp(value, "i");
  const action = option("--action");
  if (action) new RegExp(action, "i");
  rule = {
    id,
    description: option("--description", `User command redline: ${id}`),
    enabled: true,
    kind: "command",
    action,
    target: value,
    decision: decision(),
  };
} else if (cmd === "protect") {
  if (!value) throw new Error("protected path or regex required");
  const ops = String(option("--ops", "create,write,delete")).split(",").map((x) => x.trim()).filter(Boolean);
  for (const op of ops) if (!new Set(["create", "write", "delete"]).has(op)) throw new Error(`invalid operation: ${op}`);
  rule = {
    id,
    description: option("--description", `Protected path: ${value}`),
    enabled: true,
    kind: "file",
    operations: ops,
    ...(has("--regex") ? { target: value } : { protected_path: path.resolve(expandHome(value)) }),
    decision: decision(),
  };
  if (rule.target) new RegExp(rule.target, "i");
} else {
  throw new Error(`unknown command: ${cmd}`);
}

if (existing >= 0) rules[existing] = rule;
else rules.push(rule);
write(rules);
console.log(`${existing >= 0 ? "Updated" : "Added"} ${id} in ${file}`);
await reload();
