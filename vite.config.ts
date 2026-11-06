import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
    host: "127.0.0.1",
    port: 1420,
    open: true,
    strictPort: true,
    watch: {
      ignored: [
        "**/backend/**",
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
