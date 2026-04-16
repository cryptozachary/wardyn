/**
 * Copies non-TS assets (HTML + CJS preload) next to compiled Electron output,
 * because tsc only emits .ts files.
 */
import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");

async function copyAssets(src, dst, exts) {
  await fs.mkdir(dst, { recursive: true });
  for (const entry of await fs.readdir(src, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!exts.some((e) => entry.name.endsWith(e))) continue;
    await fs.copyFile(path.join(src, entry.name), path.join(dst, entry.name));
    console.log(`  copied ${entry.name}`);
  }
}

await copyAssets(
  path.join(REPO, "electron"),
  path.join(REPO, "dist", "electron"),
  [".html", ".cjs"],
);

await copyAssets(
  path.join(REPO, "electron", "assets"),
  path.join(REPO, "dist", "electron", "assets"),
  [".ico", ".png"],
);
