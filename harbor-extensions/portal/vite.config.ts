import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In development (npm run dev, port 5173), proxy platform APIs to the backend on 8000
const backend = "http://127.0.0.1:8000";
const proxied = ["/api", "/gw", "/auth", "/ext", "/sdk"];

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: Object.fromEntries(proxied.map((p) => [p, { target: backend }])),
  },
  build: { outDir: "dist", emptyOutDir: true },
});
