import { defineConfig } from 'vite';

export default defineConfig({
  publicDir: false,
  build: {
    emptyOutDir: true,
    lib: {
      entry: {
        cli: 'src/cli/diagnose.ts',
        mcp: 'src/mcp/investigationServer.ts',
        public: 'src/public.ts',
      },
      formats: ['es'],
    },
    outDir: 'dist/package',
    rollupOptions: {
      external: [/^node:/, /^@modelcontextprotocol\//, /^rawsql-ts(?:\/|$)/, /^zod(?:\/|$)/],
      output: { entryFileNames: '[name].js' },
    },
  },
});
