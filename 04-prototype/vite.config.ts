import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";
import { VitePWA } from "vite-plugin-pwa";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const uxTestMode = env.VITE_UX_TEST_MODE === "true";

  return {
  server: {
    host: "::",
    port: 8080,
    hmr: {
      overlay: false,
    },
    proxy: {
      "/api/settings": {
        target: "http://localhost:8787",
        changeOrigin: true,
      },
      "/api/dashboard": {
        target: "http://localhost:8787",
        changeOrigin: true,
      },
      "/api/auth": {
        target: "http://localhost:8787",
        changeOrigin: true,
      },
      "/api/transcribe": {
        target: "http://localhost:8787",
        changeOrigin: true,
      },
      "/api/onboarding": {
        target: "http://localhost:8787",
        changeOrigin: true,
      },
    },
  },
  plugins: [
    react(),
    mode === "development" && !uxTestMode && componentTagger(),
    VitePWA({
      registerType: "autoUpdate",
      devOptions: { enabled: false },
      includeAssets: ["favicon.ico", "apple-touch-icon.png"],
      workbox: {
        globPatterns: ["**/*.{js,css,html,ico,png,svg,webmanifest}"],
        navigateFallback: "/index.html",
        runtimeCaching: [
          {
            urlPattern: /\/api\//,
            handler: "NetworkOnly",
          },
        ],
      },
      manifest: {
        name: "Tempo · Stay in sync with what changed",
        short_name: "Tempo",
        description:
          "Tempo helps communications professionals stay on top of narrative shifts across trusted sources so they can monitor, draft, and respond without losing focus.",
        display: "standalone",
        start_url: "/",
        scope: "/",
        theme_color: "#f7f5f0",
        background_color: "#f7f5f0",
        icons: [
          {
            src: "/icons/icon-192.png",
            sizes: "192x192",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "/icons/icon-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any",
          },
        ],
      },
    }),
  ].filter(Boolean),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@tempo/analytics": path.resolve(
        __dirname,
        "../05-engineering/packages/analytics/src/index.ts"
      ),
      "@tempo/contracts": path.resolve(
        __dirname,
        "../05-engineering/packages/contracts/src/index.ts"
      ),
    },
    dedupe: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime", "@tanstack/react-query", "@tanstack/query-core"],
  },
};
});
