import { build } from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(await (await import("node:fs/promises")).readFile(path.join(root, "package.json"), "utf8"));

const common = {
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  sourcemap: true,
  logLevel: "info",
  external: ["electron", "node:sqlite"],
  // Bundles are CommonJS; source modules use import.meta.url only as a fallback.
  logOverride: { "empty-import-meta": "silent" },
  define: { __FLEET_VERSION__: JSON.stringify(pkg.version) },
};

await mkdir(path.join(root, "dist"), { recursive: true });
await Promise.all([
  build({ ...common, entryPoints: [path.join(root, "src/main/main.ts")], outfile: path.join(root, "dist/main.cjs") }),
  build({ ...common, entryPoints: [path.join(root, "src/main/preload.ts")], outfile: path.join(root, "dist/preload.cjs") }),
  build({ ...common, entryPoints: [path.join(root, "src/cli.ts")], outfile: path.join(root, "dist/cli.cjs"), banner: { js: "#!/usr/bin/env node" } }),
]);
await mkdir(path.join(root, "dist/assets"), { recursive: true });
for (const icon of ["tray.png", "tray@2x.png", "trayTemplate.png", "trayTemplate@2x.png", "icon.png"]) {
  await copyFile(path.join(root, "build", icon), path.join(root, "dist/assets", icon)).catch(() => {});
}
