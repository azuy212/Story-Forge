import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  root: "ui",
  server: {
    port: 5173,
    host: "127.0.0.1",
    proxy: {
      "/api": {
        target: "http://localhost:2025",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "../dist/ui",
    emptyOutDir: true,
  },
});
