import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

/**
 * Vite plugin that provides a synthetic module for rpc-websockets.
 * The browser-specific bundle only exports `Client`, but the Turbo SDK
 * also imports `CommonClient`. This plugin intercepts any rpc-websockets
 * import and returns a module that exports both names.
 */
function rpcWebsocketsShimPlugin(): Plugin {
  const RESOLVED_ID = '\0rpc-websockets-shim';
  return {
    name: 'rpc-websockets-shim',
    resolveId(id) {
      if (id === 'rpc-websockets' || id.startsWith('rpc-websockets/')) {
        return RESOLVED_ID;
      }
    },
    load(id) {
      if (id === RESOLVED_ID) {
        // Synthetic ESM module that satisfies all named imports
        // the Turbo SDK needs from rpc-websockets in a browser context.
        return `
class WSClient {
  constructor() {}
  open() {}
  close() {}
  call() { return Promise.resolve(null); }
  notify() {}
  on() { return this; }
  once() { return this; }
  off() { return this; }
  connect() {}
}
export { WSClient as Client, WSClient as CommonClient };
export default WSClient;
`;
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), nodePolyfills(), rpcWebsocketsShimPlugin()],
  base: './',
  optimizeDeps: {
    exclude: ['rpc-websockets'],
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: undefined,
      },
    },
  },
  resolve: {
    alias: [
      { find: '@', replacement: '/src' },
      { find: 'rpc-websockets', replacement: '/src/shims/rpc-websockets.js' },
      { find: 'rpc-websockets/dist/index.browser.cjs', replacement: '/src/shims/rpc-websockets.js' },
    ],
  },
});
