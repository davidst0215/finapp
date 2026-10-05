import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import path from 'path';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/*.png'],
      manifest: {
        name: 'Wabid',
        short_name: 'Wabid',
        description: 'Tu asistente personal',
        start_url: '/',
        display: 'standalone',
        background_color: '#141417',
        theme_color: '#141417',
        orientation: 'portrait',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        // Mantener presionado el ícono → «Conversar»: abre Wabid ya escuchando (aunque «Escuchar al abrir» esté apagado).
        shortcuts: [
          { name: 'Conversar con Wabid', short_name: 'Conversar', url: '/?conversar=1', icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }] },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        // Páginas estáticas públicas (política de privacidad): no las reemplaza el shell de la app.
        navigateFallbackDenylist: [/^\/privacidad\.html$/],
        // Avisos push: public/sw-push.js agrega los eventos push y notificationclick al sw.js generado.
        // Se carga con importScripts (el navegador lo revisa al buscar actualizaciones del service worker)
        // y por eso no entra al precache.
        importScripts: ['sw-push.js'],
        globIgnores: ['sw-push.js'],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/.*supabase\.co\/rest\/v1\/(transactions|accounts|categories)/,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'api-data',
              expiration: { maxEntries: 100, maxAgeSeconds: 600 },
              networkTimeoutSeconds: 5,
            },
          },
          {
            urlPattern: /^https:\/\/.*supabase\.co\/rest/,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'api-other',
              expiration: { maxEntries: 50, maxAgeSeconds: 300 },
            },
          },
          {
            urlPattern: /^https:\/\/.*googleusercontent\.com/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'avatar-cache',
              expiration: { maxEntries: 20, maxAgeSeconds: 86400 },
            },
          },
        ],
      },
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
