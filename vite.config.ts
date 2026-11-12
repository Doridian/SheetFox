import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The viewer is fully static and ships no sheets. In `npm run dev`, the local library/ (CLI output) is
// served for convenience; production builds don't copy it (the server provides its own library).
export default defineConfig({
  root: 'web',
  publicDir: '../library',
  base: './',
  plugins: [react()],
  build: { outDir: '../dist', emptyOutDir: true, copyPublicDir: false, chunkSizeWarningLimit: 6000 },
});
