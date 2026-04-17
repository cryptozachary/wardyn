/**
 * Auto-update bootstrap. Uses electron-updater against the `publish` config
 * in package.json — generic update server by default, override via
 * WARDYN_UPDATE_URL.
 *
 * electron-updater is loaded lazily so the app still builds and runs if the
 * package isn't installed yet. Disable with WARDYN_AUTOUPDATE=0.
 */

import { app, dialog } from "electron";

export async function setupAutoUpdate(): Promise<void> {
  if (process.env.WARDYN_AUTOUPDATE === "0") return;
  if (!app.isPackaged) return; // No updates in dev

  let autoUpdater: any;
  try {
    // Lazy import so a missing dep isn't a build-time error.
    const mod = await import("electron-updater");
    autoUpdater = mod.autoUpdater;
  } catch {
    console.log("[electron] electron-updater not installed — skipping auto-update");
    return;
  }

  const urlOverride = process.env.WARDYN_UPDATE_URL;
  if (urlOverride) {
    autoUpdater.setFeedURL({ provider: "generic", url: urlOverride });
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("error", (err: Error) => {
    console.error("[updater] error:", err.message);
  });

  autoUpdater.on("update-available", (info: any) => {
    console.log(`[updater] update available: ${info.version}`);
  });

  autoUpdater.on("update-downloaded", async (info: any) => {
    const r = await dialog.showMessageBox({
      type: "info",
      buttons: ["Restart now", "Later"],
      defaultId: 0,
      title: "Update ready",
      message: `Wardyn ${info.version} is ready to install. Restart now?`,
    });
    if (r.response === 0) autoUpdater.quitAndInstall();
  });

  try {
    await autoUpdater.checkForUpdates();
  } catch (err: any) {
    console.warn("[updater] check failed:", err.message);
  }

  // Re-check every 6 hours while the app is running.
  setInterval(() => {
    autoUpdater.checkForUpdates().catch(() => {});
  }, 6 * 3_600_000).unref?.();
}
