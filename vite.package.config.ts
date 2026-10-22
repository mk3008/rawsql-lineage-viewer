import { defineConfig } from 'vite';

export default defineConfig({
  publicDir: false,
  build: {
    emptyOutDir: true,
    lib: {
      entry: {
        cli: 'src/cli/diagnose.ts',
        public: 'src/public.ts',
      },
      formats: ['es'],
    },
    outDir: 'dist/package',
    rollupOptions: {
      external: [/^node:/, /^rawsql-ts(?:\/|$)/],
      output: { entryFileNames: '[name].js' },
    },
  },
});
