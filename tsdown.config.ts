import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/web/index.ts",
  },
  format: "esm",
  dts: true,
  clean: true,
  outDir: "dist",
  external: ["@sinclair/typebox"],
});
