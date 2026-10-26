import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: path.join(root, "src/ui"),
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "~": path.join(root, "src/ui") } },
  build: { outDir: path.join(root, "dist/ui"), emptyOutDir: true },
  server: {
    port: 5178,
    proxy: { "/api": "http://127.0.0.1:8742" },
  },
});
