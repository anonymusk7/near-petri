import { resolve } from "node:path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": resolve(import.meta.dirname, "./src") } },
  // `pnpm --dir web dev` proxies the API to `node web/server.mjs` (default port 5174).
  server: { proxy: { "/api": "http://127.0.0.1:5174" } },
})
