import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist/viewer' },
  base: process.env.VITE_BASE_PATH ?? '/',
});
