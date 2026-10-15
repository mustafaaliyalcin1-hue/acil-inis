import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// GitHub Pages project sites live under /<repo>/ — set BASE in CI.
const base = process.env.BASE ?? '/';

export default defineConfig({
  base,
  build: { target: 'es2022', chunkSizeWarningLimit: 2000, sourcemap: false },
  server: { host: true },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: false,
      includeAssets: ['icons/*.png', 'splash/*.png', 'data/*.json'],
      manifest: {
        name: 'Acil İniş — Uçuş ve Acil İniş Simülatörü',
        short_name: 'Acil İniş',
        description: 'Gerçekçi yolcu uçağı uçuş ve acil iniş simülatörü',
        lang: 'tr',
        start_url: base,
        scope: base,
        display: 'fullscreen',
        orientation: 'landscape',
        background_color: '#05080d',
        theme_color: '#05080d',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
        ]
      },
      workbox: {
        // App shell + airport data precached. The offline world pack (pack/*) is NOT precached:
        // the app downloads it into IndexedDB from the "Offline Paket İndir" screen.
        globPatterns: ['**/*.{js,css,html,png,svg,json,woff2}'],
        globIgnores: ['pack/**'],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        navigateFallback: 'index.html',
        navigateFallbackDenylist: [/\/pack\//],
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          {
            // online mode: streamed imagery/elevation (sources that allow caching)
            urlPattern: /^https:\/\/(tiles\.maps\.eox\.at|s3\.amazonaws\.com\/elevation-tiles-prod)\//,
            handler: 'CacheFirst',
            options: {
              cacheName: 'world-tiles',
              expiration: { maxEntries: 6000, maxAgeSeconds: 60 * 60 * 24 * 60 },
              cacheableResponse: { statuses: [0, 200] }
            }
          }
        ]
      }
    })
  ]
});
