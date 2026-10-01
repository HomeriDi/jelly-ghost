import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // three.js is its own lazily-loaded chunk; its size is expected.
  build: { chunkSizeWarningLimit: 700 },
});
