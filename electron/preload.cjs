const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("secureclaw", {
  setupSubmit: (payload) => ipcRenderer.invoke("setup:submit", payload),
  setupCancel: () => ipcRenderer.invoke("setup:cancel"),
  unlockSubmit: (payload) => ipcRenderer.invoke("unlock:submit", payload),
});
