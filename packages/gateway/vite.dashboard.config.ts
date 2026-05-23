import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "dashboard",
  base: "/dashboard/",
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "../dist/dashboard",
    emptyOutDir: true,
  },
  server: {
    host: "127.0.0.1",
    port: 5174,
    proxy: {
      "/admin": "http://127.0.0.1:2021",
      "/health": "http://127.0.0.1:2021",
    },
  },
});
