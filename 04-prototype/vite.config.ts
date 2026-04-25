import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
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
  plugins: [react(), mode === "development" && componentTagger()].filter(Boolean),
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
}));
