// Glasses for Argus — filesystem write observation.
//
// Origin: Argus src/watcher.js — MIT © 2026 Zac Rieger.
// Ported to TypeScript. Deliberate change from Argus: the chokidar fallback is
// dropped so this adds ZERO dependencies to agentglass's lockfile. Where
// recursive fs.watch is unavailable the tier reports itself unavailable rather
// than pulling in a package.
//
// THIS TIER IS OFF BY DEFAULT, ON PURPOSE.
// agentglass's author drew an explicit line: it never taps the filesystem, so
// that everything it shows is semantic and labeled. That is a real design
// position, not an oversight, and this port respects it — the fs tier ships
// dark and only turns on when someone deliberately sets GLASSES_FS_WATCH=1.
//
// What it buys when you do turn it on: every write in the watched tree is
// captured whether or not the writer reported anything. A program that ignored
// the hooks, or one nobody has a signature for, still cannot un-write a file.
// Those unclaimed writes are exactly the blind spot the environment tier is
// for — but they arrive UNLABELED, which is why they are kept in their own
// table and never mixed into agentglass's labeled agent data.

import fs from 'node:fs';
import path from 'node:path';
import { normalizePath } from './paths';

const MAX_BYTES = 512 * 1024; // don't snapshot or diff huge/binary files

export interface LineDiff {
  plus: number;
  minus: number;
  start_line: number;
  sample: string[];
}

export interface FsChange {
  ts: number;
  path: string;
  action: 'fs_create' | 'fs_write' | 'fs_delete';
  diff: LineDiff | null;
}

/** Trim common prefix/suffix line diff — enough for +N/−N counts and a sample
 *  hunk. Full-fidelity diffs come from the agent's own telemetry; this is
 *  corroboration, not a replacement. */
export function lineDiff(oldStr: string, newStr: string): LineDiff {
  const a = oldStr === '' ? [] : oldStr.split('\n');
  const b = newStr === '' ? [] : newStr.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const removed = a.slice(start, endA);
  const added = b.slice(start, endB);
  return {
    plus: added.length,
    minus: removed.length,
    start_line: start + 1,
    sample: [...removed.map((l) => '- ' + l), ...added.map((l) => '+ ' + l)].slice(0, 80),
  };
}

// Directories that never carry owner-meaningful agent activity but explode
// watcher cost — or are OS-protected and make the native watcher throw EPERM.
// Pruning them is what makes watching a broad tree feasible AND safe.
const IGNORE_SEGMENTS =
  /(^|[\\/])(node_modules|\.git|\.hg|\.svn|\.DS_Store|\.Trash|\.npm|\.cache|\.cargo|\.rustup|\.nvm|\.gradle|\.m2|Caches|DerivedData|\.Spotlight-V100|\.fseventsd|\.DocumentRevisions-V100|\.TemporaryItems|\.PKInstallSandboxManager.*|CloudStorage|AppData[\\/]Local[\\/]Temp)([\\/]|$)/;
const IGNORE_CONTAINS = ['/Library/', '/Mobile Documents/', '/.Trash/', '/.ssh/', '/ipc/'];
const IGNORE_SUFFIX = ['.sock', '.socket'];
const IGNORE_PREFIXES = [
  '/System/', '/Volumes/', '/private/var/', '/var/', '/dev/', '/proc/', '/sys/',
  '/cores/', '/Library/', '/nix/store/', '/usr/', '/bin/', '/sbin/', '/opt/',
];

// Prefix/contains pruning must not swallow the watched tree itself, so any
// pattern that would hide the watch root is dropped.
export function makeIgnore(dir: string): (p: string) => boolean {
  const root = String(dir).replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  const prefixes = IGNORE_PREFIXES.filter((pre) => !(root + '/').startsWith(pre));
  const contains = IGNORE_CONTAINS.filter((c) => !(root + '/').includes(c));
  return (p: string) => {
    const s = String(p).replace(/\\/g, '/');
    if (s === root) return false; // never ignore the root itself
    return (
      IGNORE_SEGMENTS.test(s) ||
      IGNORE_SUFFIX.some((suf) => s.endsWith(suf)) ||
      contains.some((c) => s.includes(c)) ||
      prefixes.some((pre) => s.startsWith(pre))
    );
  };
}

function readText(p: string): string | null {
  try {
    const buf = fs.readFileSync(p);
    if (buf.length > MAX_BYTES || buf.includes(0)) return null; // binary/huge
    return buf.toString('utf8');
  } catch {
    return null;
  }
}

export interface WatcherHandle {
  close: () => Promise<void>;
  available: boolean;
}

/**
 * One recursive stream for the whole subtree — a single FSEvents stream on
 * macOS, ReadDirectoryChangesW on Windows. Critically NOT a file descriptor
 * per directory, which is what makes watching a broad tree survivable instead
 * of dying on EMFILE.
 */
export function startWatcher(
  dir: string,
  onChange: (c: FsChange) => void,
  opts: { exclude?: string[] } = {}
): WatcherHandle {
  const root = String(dir).replace(/\/+$/, '') || '/';
  const baseIgnore = makeIgnore(root);

  // Caller-supplied exclusions, matched on the normalized path (and any file
  // whose name starts with one, which is what catches SQLite's `-wal`/`-shm`
  // siblings).
  //
  // This exists because of a real feedback loop, not as a nicety: the watcher's
  // own events are persisted to SQLite, SQLite writes its WAL, the WAL lives
  // inside the watched tree, and that write produces another event. Left alone
  // it amplifies without bound — an otherwise idle machine produced thousands
  // of "unattributed writes" that were all this loop, drowning the exact signal
  // the suspect band exists to show. An observer must not watch its own
  // recording.
  const excluded = (opts.exclude ?? []).map((p) => normalizePath(p)).filter(Boolean) as string[];
  const ignore = (p: string) => {
    if (baseIgnore(p)) return true;
    const s = normalizePath(p);
    return !!s && excluded.some((x) => s === x || s.startsWith(x));
  };
  const cache = new Map<string, string>(); // path -> last text content
  const known = new Set<string>(); // paths seen, to split create vs write
  const pending = new Map<string, { sawRename: boolean; timer: ReturnType<typeof setTimeout> }>();
  let closed = false;

  const emit = (full: string, sawRename: boolean) => {
    if (closed || ignore(full)) return;
    let st: fs.Stats | null = null;
    try {
      st = fs.statSync(full);
    } catch {
      st = null;
    }
    if (!st) {
      if (known.has(full)) {
        known.delete(full);
        cache.delete(full);
        onChange({ ts: Date.now(), path: normalizePath(full)!, action: 'fs_delete', diff: null });
      }
      return;
    }
    if (!st.isFile()) return; // directories, sockets, fifos: not content events
    // A create fires 'rename'; a plain modify fires 'change'. First time we see
    // a path via a rename = a genuinely new file.
    const isNew = !known.has(full) && sawRename;
    known.add(full);
    const text = readText(full);
    const seeded = cache.has(full);
    const old = cache.get(full) ?? '';
    if (text != null) cache.set(full, text);
    if (isNew) {
      onChange({
        ts: Date.now(),
        path: normalizePath(full)!,
        action: 'fs_create',
        diff: text != null ? lineDiff('', text) : null,
      });
    } else {
      // A pre-existing file's first change has no baseline → report it without
      // fabricating a diff; later changes diff against the cache.
      const diff = text != null && seeded ? lineDiff(old, text) : null;
      onChange({ ts: Date.now(), path: normalizePath(full)!, action: 'fs_write', diff });
    }
  };

  let watcher: fs.FSWatcher;
  try {
    watcher = fs.watch(root, { recursive: true }, (evtType, filename) => {
      if (!filename) return;
      const full = path.join(root, filename.toString());
      if (ignore(full)) return; // prune before doing any work
      const prev = pending.get(full);
      if (prev) clearTimeout(prev.timer);
      pending.set(full, {
        sawRename: (prev?.sawRename || false) || evtType === 'rename',
        timer: setTimeout(() => {
          const rec = pending.get(full);
          pending.delete(full);
          emit(full, rec ? rec.sawRename : evtType === 'rename');
        }, 40),
      });
    });
    watcher.on('error', (err: any) => {
      if (err && err.code !== 'EPERM' && err.code !== 'ENOENT') {
        console.error(`[argus/watcher] ${err.code || ''} ${err.message || err}`);
      }
    });
  } catch (e: any) {
    // Recursive fs.watch unsupported here (some Linux builds). Argus falls back
    // to chokidar; this port refuses to add a dependency, so the tier reports
    // itself unavailable instead of pretending to work.
    console.error(
      `[argus/watcher] recursive watch unavailable (${e?.code || e?.message}); fs tier disabled on this platform`
    );
    return { close: async () => {}, available: false };
  }

  return {
    available: true,
    close: async () => {
      closed = true;
      for (const { timer } of pending.values()) clearTimeout(timer);
      pending.clear();
      try {
        watcher.close();
      } catch {}
    },
  };
}
