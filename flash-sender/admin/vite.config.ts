import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5174, strictPort: true },
  build: {
    outDir: 'dist',
    sourcemap: false,
    // Fixed filenames rather than content hashes. The dashboard is deployed by
    // copying these three files onto a server that may have no build
    // toolchain, and stable names mean the copy is the same command every
    // time. The backend serves them with a one-hour max-age, so a refresh
    // after an update is all that is needed.
    rollupOptions: {
      output: {
        entryFileNames: 'assets/app.js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/app.[ext]',
      },
    },
  },
});
