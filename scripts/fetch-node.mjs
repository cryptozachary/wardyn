/**
 * Downloads a portable Node.js binary for bundling with the Electron app.
 * Places it in electron/node-runtime/ so electron-builder picks it up.
 *
 * Usage: node scripts/fetch-node.mjs [--version 22.15.0] [--platform win32] [--arch x64]
 */
import { promises as fs } from "fs";
import { createWriteStream, existsSync } from "fs";
import https from "https";
import path from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

// Default to the Node version currently running this script. That way the
// bundled runtime matches whatever Node compiled better-sqlite3 during
// `npm install`, so we never ship an ABI-mismatched native module.
const NODE_VERSION = arg("version", process.version.replace(/^v/, ""));
const PLATFORM = arg("platform", process.platform);
const ARCH = arg("arch", process.arch);

const DEST = path.join(REPO, "electron", "node-runtime");

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const follow = (u) => {
      https.get(u, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          follow(res.headers.location);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${u}`));
          return;
        }
        const stream = createWriteStream(dest);
        res.pipe(stream);
        stream.on("finish", () => { stream.close(); resolve(); });
        stream.on("error", reject);
      }).on("error", reject);
    };
    follow(url);
  });
}

async function main() {
  await fs.mkdir(DEST, { recursive: true });

  if (PLATFORM === "win32") {
    const exe = path.join(DEST, "node.exe");
    if (existsSync(exe)) {
      console.log(`Already exists: ${exe}`);
      return;
    }
    const url = `https://nodejs.org/dist/v${NODE_VERSION}/win-${ARCH}/node.exe`;
    console.log(`Downloading ${url} ...`);
    await download(url, exe);
    console.log(`Saved: ${exe} (${(await fs.stat(exe)).size} bytes)`);
  } else {
    const tarName = `node-v${NODE_VERSION}-${PLATFORM}-${ARCH}.tar.gz`;
    const tarPath = path.join(DEST, tarName);
    const url = `https://nodejs.org/dist/v${NODE_VERSION}/${tarName}`;
    console.log(`Downloading ${url} ...`);
    await download(url, tarPath);
    console.log("Extracting node binary...");
    execSync(
      `tar -xzf "${tarPath}" --strip-components=2 -C "${DEST}" "node-v${NODE_VERSION}-${PLATFORM}-${ARCH}/bin/node"`,
      { stdio: "inherit" },
    );
    await fs.unlink(tarPath);
    await fs.chmod(path.join(DEST, "node"), 0o755);
    console.log(`Saved: ${path.join(DEST, "node")}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
