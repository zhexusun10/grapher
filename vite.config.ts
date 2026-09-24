import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          xyflow: ["@xyflow/react"],
          marked: ["marked"],
        },
      },
    },
  },
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${process.env.GRAPHER_PORT || "1421"}`,
        changeOrigin: true,
      },
    },
  },
  clearScreen: false,
});
