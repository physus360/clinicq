import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        main:  resolve(__dirname, "index.html"),   // lobby — public TV
        login: resolve(__dirname, "login.html"),   // staff portal
      },
    },
  },
});
