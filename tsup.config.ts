import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    hku: "src/cli.ts",
    moodle: "src/cli.ts",
  },
  format: ["esm"],
  target: "node22",
  platform: "node",
  bundle: true,
  clean: true,
  sourcemap: false,
  dts: false,
  splitting: false,
  banner: {
    js: "#!/usr/bin/env node",
  },
  outExtension: () => ({ js: ".js" }),
  outDir: "dist",
});
