import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron/simple';

export default defineConfig(({ command }) => ({
  plugins: [
    react(),
    electron({
      main: {
        entry: 'electron/main.ts',
        vite: {
          build: {
            outDir: 'dist-electron',
            sourcemap: command === 'serve',
            minify: command === 'build',
            rollupOptions: {
              // Bundle ethers into the main process; keep electron external.
              external: ['electron'],
            },
          },
        },
      },
      preload: {
        input: 'electron/preload.ts',
        vite: {
          build: {
            outDir: 'dist-electron',
            sourcemap: command === 'serve' ? 'inline' : false,
            minify: command === 'build',
            rollupOptions: { external: ['electron'] },
          },
        },
      },
      // The renderer gets no Node APIs — it talks to main through preload only.
      renderer: undefined,
    }),
  ],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Chromium is bundled with Electron, so there is no need to down-level.
    target: 'chrome128',
    sourcemap: false,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  clearScreen: false,
}));
