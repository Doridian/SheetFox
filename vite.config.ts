import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The viewer is fully static: library/ (sheet files + source PDFs) is served as public assets.
export default defineConfig({
  root: "web",
  publicDir: "../library",
  base: "./",
  plugins: [react()],
  build: { outDir: "../dist", emptyOutDir: true, chunkSizeWarningLimit: 6000 },
});
