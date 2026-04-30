import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

const port = Number(process.env.PORT) || 5173;
const basePath = process.env.BASE_PATH || "/";

function ogAbsoluteUrls() {
  return {
    name: "og-absolute-urls",
    transformIndexHtml(html: string) {
      const siteUrl = process.env.PUBLIC_URL || "";
      if (!siteUrl) return html;
      return html
        .replace(/content="\/opengraph\.jpg"/g, `content="${siteUrl}/opengraph.jpg"`)
        .replace(/content="\/apple-touch-icon\.png"/g, `content="${siteUrl}/apple-touch-icon.png"`);
    },
  };
}

export default defineConfig({
  base: basePath,
  plugins: [
    react(),
    tailwindcss(),
    ogAbsoluteUrls(),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "@assets": path.resolve(import.meta.dirname, "..", "..", "attached_assets"),
    },
    dedupe: ["react", "react-dom"],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
  },
  server: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
    proxy: {
      "/api": {
        // Mirror the preview block's PREVIEW_API_PROXY_TARGET escape hatch
        // (Task #324): the dev-mode Playwright harness can override the
        // api-server port via E2E_API_PORT, and the dev proxy must follow
        // it. Default keeps the historical "http://localhost:8080" so
        // local `pnpm --filter @workspace/vulnrap run dev` is unchanged.
        target: process.env.DEV_API_PROXY_TARGET || "http://localhost:8080",
        changeOrigin: true,
      },
    },
    fs: {
      strict: true,
      deny: ["**/.*"],
    },
  },
  preview: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
    proxy: {
      "/api": {
        target: process.env.PREVIEW_API_PROXY_TARGET || "http://localhost:8080",
        changeOrigin: true,
      },
    },
  },
});
