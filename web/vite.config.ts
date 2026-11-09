import { resolve } from "node:path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// VITE_STATIC=1 (`pnpm web:static`): the hosted demo. Relative base so it works under any
// subpath (GitHub Pages), its own outDir, and the build-time JSON from scripts/export-static.mjs.
const STATIC = process.env.VITE_STATIC === "1"

export default defineConfig({
  base: STATIC ? "./" : "/",
  publicDir: STATIC ? "public-static" : "public",
  build: { outDir: STATIC ? "dist-static" : "dist", chunkSizeWarningLimit: 1500 },
  plugins: [react(), tailwindcss()],
  // the wallet-selector / near-js packages expect Node's `global`
  define: { global: "globalThis" },
  resolve: { alias: { "@": resolve(import.meta.dirname, "./src") } },
  // `pnpm --dir web dev` proxies the API to `node web/server.mjs` (default port 5174).
  // fs.allow: the shared tx builders live in the repo-root lib/.
  server: { proxy: { "/api": "http://127.0.0.1:5174" }, fs: { allow: [".."] } },
})
