import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    strictPort: true,
    // Same-origin API calls in development, like /v1 behind CloudFront in production.
    proxy: { "/v1": "http://localhost:3000" },
  },
});
