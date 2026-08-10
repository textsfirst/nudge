import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "src/web",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src/web", import.meta.url)),
    },
  },
  server: {
    port: 5174,
    proxy: {
      "/api": `http://127.0.0.1:${process.env.CONSOLE_PORT ?? "3100"}`,
    },
  },
  build: {
    outDir: "../../dist/public",
    emptyOutDir: true,
  },
});
