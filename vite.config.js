import { defineConfig } from "vite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

// Tauri sets TAURI_DEV_HOST when running on a physical Android device.
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  clearScreen: false,
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  resolve: {
    // The reading engine (src/foliate) loads pdf.js as "@pdfjs/pdf.min.mjs", as in Readest.
    alias: { "@pdfjs": fileURLToPath(new URL("./node_modules/pdfjs-dist/legacy/build", import.meta.url)) },
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    // Old enough for Sailfish OS's Gecko-based WebView as well as Tauri's webviews.
    target: ["es2020", "firefox78", "chrome87", "safari14"],
    outDir: "dist",
    emptyOutDir: true,
  },
});
