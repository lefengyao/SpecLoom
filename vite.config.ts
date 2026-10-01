import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL("./src/renderer", import.meta.url)),
  base: "./",
  plugins: [react(), {
    name: "renderer-content-security-policy",
    transformIndexHtml(_html, context) {
      const scripts = context.server ? "'self' 'unsafe-inline'" : "'self'";
      return [{
        tag: "meta",
        attrs: {
          "http-equiv": "Content-Security-Policy",
          content: `default-src 'self'; script-src ${scripts}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws://127.0.0.1:*; object-src 'none'; base-uri 'none'`,
        },
        injectTo: "head-prepend",
      }];
    },
  }],
  server: { host: "127.0.0.1", port: 5173, strictPort: false },
  build: {
    outDir: fileURLToPath(new URL("./dist/renderer", import.meta.url)),
    emptyOutDir: true,
  },
});
