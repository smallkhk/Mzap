import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Served under /portal on the same origin as the backend (see
// PORTAL_DIST_PATH in the backend), so asset URLs are rooted there in both
// dev and the production build — `npm run dev` serves at
// http://localhost:5175/portal/, matching where it lives in production.
export default defineConfig({
  base: '/portal/',
  plugins: [react()],
  server: { port: 5175, strictPort: true },
  build: {
    outDir: 'dist',
    sourcemap: false,
    // Fixed filenames rather than content hashes — deployed by copying files
    // onto a host with no build toolchain, same reasoning as admin/.
    rollupOptions: {
      output: {
        entryFileNames: 'assets/app.js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/app.[ext]',
      },
    },
  },
});
