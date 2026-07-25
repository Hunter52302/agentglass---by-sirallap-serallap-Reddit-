#!/usr/bin/env node
import fs from "node:fs";

function edit(path, transform) {
  const before = fs.readFileSync(path, "utf8");
  const after = transform(before);
  if (after === before) throw new Error(`${path}: expected anchor not found or no change produced`);
  fs.writeFileSync(path, after);
}

edit("server/src/index.ts", (s) => {
  s = s.replace(
    "  redlineStatus, reloadRedlines, killTree,\n} from \"./argus/redlines.ts\";",
    "  redlineStatus, reloadRedlines, upsertRedline, deleteRedline, killTree,\n} from \"./argus/redlines.ts\";",
  );
  const anchor = `    if (pathname === "/env/redlines/reload" && req.method === "POST") {\n      if (!localOrigin(req)) return csrfBlocked();\n      reloadRedlines(workspaceRoot());\n      return json({ ok: true, ...redlineStatus() });\n    }`;
  const routes = `${anchor}\n    if (pathname === "/env/redlines/upsert" && req.method === "POST") {\n      if (!localOrigin(req)) return csrfBlocked();\n      let b: any = {};\n      try { b = await req.json(); } catch { return json({ ok: false, error: "invalid json" }, 400); }\n      try {\n        return json({ ok: true, ...upsertRedline(b, workspaceRoot()) });\n      } catch (e: any) {\n        return json({ ok: false, error: e?.message ?? String(e) }, 400);\n      }\n    }\n    if (pathname === "/env/redlines/delete" && req.method === "POST") {\n      if (!localOrigin(req)) return csrfBlocked();\n      let b: any = {};\n      try { b = await req.json(); } catch { return json({ ok: false, error: "invalid json" }, 400); }\n      const id = String(b.id || "").trim();\n      if (!id) return json({ ok: false, error: "id required" }, 400);\n      return json({ ok: true, ...deleteRedline(id, workspaceRoot()) });\n    }`;
  if (!s.includes(anchor)) throw new Error("server redline route anchor missing");
  return s.replace(anchor, routes);
});

edit("web/src/components/ArgusCockpit.tsx", (s) => {
  s = s.replace(
    'import { Portal } from "./Portal.tsx";',
    'import { Portal } from "./Portal.tsx";\nimport { RedlineEditor } from "./RedlineEditor.tsx";',
  );
  s = s.replace(
    '  const [openShell, setOpenShell] = useState<string | null>(null);',
    '  const [openShell, setOpenShell] = useState<string | null>(null);\n  const [redlineEditorOpen, setRedlineEditorOpen] = useState(false);',
  );
  s = s.replace(
    '    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };',
    '    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !redlineEditorOpen) onClose(); };',
  );
  s = s.replace(
    '  }, [open, onClose]);',
    '  }, [open, onClose, redlineEditorOpen]);',
  );
  const actorAnchor = '              {redlines && (\n                <p className="text-[10px] mt-2 leading-relaxed"';
  const button = `              <button\n                onClick={() => setRedlineEditorOpen(true)}\n                className="mt-2 px-2 py-1 rounded text-[10px] font-medium transition-opacity hover:opacity-80"\n                style={{ color: "var(--primary-hover)", background: "color-mix(in srgb, var(--primary) 14%, transparent)" }}\n              >\n                manage redlines\n              </button>\n`;
  if (!s.includes(actorAnchor)) throw new Error("cockpit actor anchor missing");
  s = s.replace(actorAnchor, button + actorAnchor);
  const portalClose = '    </Portal>\n  );\n}';
  const editor = `      <RedlineEditor\n        open={redlineEditorOpen}\n        onClose={() => setRedlineEditorOpen(false)}\n        onSaved={refresh}\n      />\n    </Portal>\n  );\n}`;
  if (!s.includes(portalClose)) throw new Error("cockpit portal anchor missing");
  return s.replace(portalClose, editor);
});

console.log("Applied Argus visual redline editor integration.");
