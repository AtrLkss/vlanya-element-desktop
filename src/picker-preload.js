const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("vlanyaPicker", {
  onSources: (callback) => {
    ipcRenderer.on("display-sources", (_event, payload) => callback(payload));
  },
  choose: (selection) => ipcRenderer.invoke("picker:choose", selection),
  refresh: () => ipcRenderer.invoke("picker:refresh"),
  cancel: () => ipcRenderer.invoke("picker:cancel"),
});
