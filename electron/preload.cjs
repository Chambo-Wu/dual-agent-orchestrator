const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktop", {
  getState: () => ipcRenderer.invoke("state:get"),
  saveState: (state) => ipcRenderer.invoke("state:save", state),
  startServer: () => ipcRenderer.invoke("server:start"),
  stopServer: () => ipcRenderer.invoke("server:stop"),
  restartServer: () => ipcRenderer.invoke("server:restart"),
  apiRequest: (pathname, options) => ipcRenderer.invoke("api:request", pathname, options),
  openExternal: (url) => ipcRenderer.invoke("open:external", url),
  onServerLog: (handler) => {
    const listener = (_event, line) => handler(line);
    ipcRenderer.on("server-log", listener);
    return () => ipcRenderer.removeListener("server-log", listener);
  },
  onServerStatus: (handler) => {
    const listener = (_event, status) => handler(status);
    ipcRenderer.on("server-status", listener);
    return () => ipcRenderer.removeListener("server-status", listener);
  },
});
