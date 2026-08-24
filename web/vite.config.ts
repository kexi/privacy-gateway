import { defineConfig } from 'vite';

// In dev, Vite serves the UI and forwards only the API calls to the gateway, so the
// same relative paths work in development and in production (where the gateway itself
// serves web/dist).
const GATEWAY = process.env.GATEWAY_URL ?? 'http://localhost:8081';

export default defineConfig({
  // `development` makes @privacy-gateway/common resolve to its TypeScript
  // sources, so the UI builds against the working tree rather than a stale dist/.
  resolve: { conditions: ['development', 'import', 'browser', 'default'] },
  server: {
    port: 5173,
    proxy: {
      '/v1': { target: GATEWAY, changeOrigin: true },
      '/healthz': { target: GATEWAY, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
