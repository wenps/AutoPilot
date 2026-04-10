import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],

  envDir: "..",
  envPrefix: ["VITE_", "GITHUB_", "MINIMAX_", "GLM_"],

  server: {
    port: 3001,
    open: true,
  },

  esbuild: {
    target: "es2022",
  },

  build: {
    outDir: "../dist-demo-v2",
    emptyOutDir: true,
  },
});
