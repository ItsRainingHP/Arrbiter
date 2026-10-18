import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  root: "src/client",
  build: { outDir: "../../dist/client", emptyOutDir: true },
  server: { proxy: { "/api": "http://localhost:8787" } },
  test: { environment: "node" },
});
