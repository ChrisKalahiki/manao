import { fileURLToPath } from "node:url";
import preact from "@preact/preset-vite";
import { defineConfig } from "vite";
import { SW_ENTRY, shellPlugin } from "./shell-plugin.js";

/** The running hub the dev server proxies `/api` to; `bun run dev` prints its address. */
const hub = process.env.MANAO_API ?? "http://127.0.0.1:7420";
const here = (file: string) => fileURLToPath(new URL(file, import.meta.url));

export default defineConfig({
  root: here("."),
  plugins: [preact(), shellPlugin()],
  build: {
    // Beside the built hub, which serves it from there (src/hub/hub.ts).
    outDir: "../dist/dashboard",
    emptyOutDir: true,
    rollupOptions: {
      input: { index: here("index.html"), [SW_ENTRY]: here("sw/sw.ts") },
      // The worker keeps a fixed name at the root: its scope is `/`, and the hub serves it no-cache.
      output: { entryFileNames: (chunk) => (chunk.name === SW_ENTRY ? "sw.js" : "assets/[name]-[hash].js") },
    },
  },
  server: {
    // changeOrigin makes the Host the hub's own address, which its Host guard admits.
    proxy: { "/api": { target: hub, changeOrigin: true } },
  },
});
