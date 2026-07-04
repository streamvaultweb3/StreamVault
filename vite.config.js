import { defineConfig } from 'vite';
import path from 'path';
import react from '@vitejs/plugin-react';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import { VitePWA } from 'vite-plugin-pwa';
/**
 * PWA (vite-plugin-pwa): precaches the built app shell (HTML + hashed JS/CSS) so the UI loads offline.
 * Runtime cache is same-origin GET only (/assets/* hashed bundles + listed public PNGs) — no Audius/Arweave/Turbo
 * URLs, so wallet/OAuth flows are not served stale opaque third-party responses.
 */
/**
 * Vite plugin that provides a synthetic module for rpc-websockets.
 * The browser-specific bundle only exports `Client`, but the Turbo SDK
 * also imports `CommonClient`. This plugin intercepts any rpc-websockets
 * import and returns a module that exports both names.
 */
function rpcWebsocketsShimPlugin() {
    var RESOLVED_ID = '\0rpc-websockets-shim';
    return {
        name: 'rpc-websockets-shim',
        resolveId: function (id) {
            if (id === 'rpc-websockets' || id.startsWith('rpc-websockets/')) {
                return RESOLVED_ID;
            }
        },
        load: function (id) {
            if (id === RESOLVED_ID) {
                // Synthetic ESM module that satisfies all named imports
                // the Turbo SDK needs from rpc-websockets in a browser context.
                return "\nclass WSClient {\n  constructor() {}\n  open() {}\n  close() {}\n  call() { return Promise.resolve(null); }\n  notify() {}\n  on() { return this; }\n  once() { return this; }\n  off() { return this; }\n  connect() {}\n}\nexport { WSClient as Client, WSClient as CommonClient };\nexport default WSClient;\n";
            }
        },
    };
}
export default defineConfig({
    plugins: [
        react(),
        nodePolyfills(),
        rpcWebsocketsShimPlugin(),
        VitePWA({
            registerType: 'prompt',
            injectRegister: 'auto',
            manifest: false,
            devOptions: { enabled: false },
            includeAssets: [
                'manifest.webmanifest',
                'favicon.png',
                'streamvault-logo.png',
                'pwa-icon-192.png',
                'pwa-icon-512.png',
                'pwa-icon-192-maskable.png',
                'pwa-icon-512-maskable.png',
            ],
            includeManifestIcons: false,
            workbox: {
                globPatterns: ['**/*.{js,css,html,ico}'],
                globIgnores: ['**/*.map'],
                /** App bundles exceed Workbox’s default 2 MiB; precache full shell for offline. */
                maximumFileSizeToCacheInBytes: 20 * 1024 * 1024,
                navigateFallback: 'index.html',
                runtimeCaching: [
                    {
                        urlPattern: function (_a) {
                            var request = _a.request, url = _a.url;
                            if (request.method !== 'GET')
                                return false;
                            if (url.origin !== self.location.origin)
                                return false;
                            var p = url.pathname;
                            if (p.includes('/assets/') && /\.(js|css|woff2?)$/i.test(p))
                                return true;
                            if (/\.(png|webp)$/i.test(p) &&
                                (/\/pwa-icon-/.test(p) ||
                                    /\/streamvault-logo\.png$/i.test(p) ||
                                    /\/favicon\.png$/i.test(p))) {
                                return true;
                            }
                            return false;
                        },
                        handler: 'StaleWhileRevalidate',
                        options: {
                            cacheName: 'sv-same-origin-static',
                            expiration: { maxEntries: 64, maxAgeSeconds: 7 * 24 * 60 * 60 },
                            cacheableResponse: { statuses: [200] },
                        },
                    },
                ],
            },
        }),
    ],
    base: './',
    server: {
        allowedHosts: [
            'clasp-manor-constrain.ngrok-free.dev',
            '.ngrok-free.dev',
        ],
    },
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
            {
                find: '@permaweb/aoconnect',
                replacement: path.resolve(__dirname, 'node_modules/@permaweb/aoconnect/dist/browser.js'),
            },
            {
                find: '@permaweb/ucm',
                replacement: path.resolve(__dirname, 'node_modules/@permaweb/ucm/dist/browser.js'),
            },
            { find: 'rpc-websockets', replacement: '/src/shims/rpc-websockets.js' },
            { find: 'rpc-websockets/dist/index.browser.cjs', replacement: '/src/shims/rpc-websockets.js' },
        ],
    },
});
