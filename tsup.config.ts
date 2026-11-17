import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    cli: "src/cli.ts",
    core: "src/core/index.ts",
    server: "src/server/index.ts",
  },
  format: ["esm"],
  platform: "node",
  target: "node22",
  clean: true,
  splitting: true,
  sourcemap: true,
  dts: true,
});
