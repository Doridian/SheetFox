import { defineConfig } from 'vite';

// Bundles server/server.ts and all of its dependencies into one ESM file that only needs node.
export default defineConfig({
  build: {
    ssr: 'server/server.ts',
    outDir: 'dist-server',
    emptyOutDir: true,
    target: 'node22',
    rollupOptions: { output: { entryFileNames: 'server.mjs' } },
  },
  ssr: { noExternal: true, target: 'node' },
});
