const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("wardyn", {
  setupSubmit: (payload) => ipcRenderer.invoke("setup:submit", payload),
  setupCancel: () => ipcRenderer.invoke("setup:cancel"),
  unlockSubmit: (payload) => ipcRenderer.invoke("unlock:submit", payload),
  unlockReset: () => ipcRenderer.invoke("unlock:reset"),
});
