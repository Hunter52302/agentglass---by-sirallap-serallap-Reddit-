import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// UI on 6180; talks to the server (default :4000) over CORS.
// Override the server URL at build/dev time with VITE_CW_SERVER.
// The demo build (VITE_DEMO=1) is served from GitHub Pages at
// /agentglass/demo/ (the landing page owns /agentglass/), so asset
// URLs need that base path.
const base = process.env.VITE_DEMO === "1" ? "/agentglass/demo/" : "/";

export default defineConfig({
  base,
  plugins: [react()],
  // Do not silently jump to 6181. The UI is paired with one server, and a
  // second dev command should fail clearly instead of opening a stale copy.
  server: { port: 6180, host: true, strictPort: true },
  preview: { port: 6180, host: true, strictPort: true },
});
