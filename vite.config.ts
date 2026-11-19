import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

const isDesktopDev = Boolean(
  process.env.TAURI_ENV_PLATFORM || process.env.GRAPHER_DESKTOP_DEV === "1",
);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  envPrefix: ["VITE_", "TAURI_ENV_"],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          const path = id.replace(/\\/g, "/");
          // Styles remain in the initial cascade; assigning them to a vendor
          // chunk can also make that chunk's JS eager despite a lazy importer.
          if (/\.css(?:\?|$)/.test(path)) return;
          if (/\/node_modules\/(?:react|react-dom|scheduler)\//.test(path)) return "react";
          if (/\/node_modules\/(?:@xyflow|d3-[^/]+|zustand|use-sync-external-store)\//.test(path)) return "xyflow";
          if (/\/node_modules\/(?:motion|motion-dom|motion-utils|framer-motion)\//.test(path)) return "motion";
          if (/\/node_modules\/marked\//.test(path)) return "marked";
          if (/\/node_modules\/katex\//.test(path)) return "katex";
        },
      },
    },
  },
  server: {
    host: process.env.TAURI_DEV_HOST || "127.0.0.1",
    port: 1420,
    open: !isDesktopDev,
    strictPort: true,
    watch: {
      // Editors may truncate before rewriting. Do not cache that temporary
      // empty module or publish an HMR update until the save has settled.
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 20 },
      ignored: [
        "**/backend/**",
        "**/src-tauri/**",
        "**/target/**",
        "**/.grapher/**",
        "**/.pi/**",
        "**/engine/**",
        "**/pi/**",
        "**/.agents/**",
      ],
    },
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${process.env.GRAPHER_PORT || "1421"}`,
        changeOrigin: true,
      },
    },
  },
  clearScreen: false,
});
