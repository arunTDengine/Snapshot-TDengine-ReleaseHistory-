"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("aio", {
  fetchCatalog: () => ipcRenderer.invoke("catalog:fetch"),
  runChecks: (platforms) => ipcRenderer.invoke("checks:run", platforms),
  copyReport: (text) => ipcRenderer.invoke("report:copy", text),
  saveReport: (payload) => ipcRenderer.invoke("report:save", payload),
  sendFeishu: (payload) => ipcRenderer.invoke("report:feishu", payload),
  onProgress: (handler) => {
    const wrapped = (_event, data) => handler(data);
    ipcRenderer.on("checks:progress", wrapped);
    return () => ipcRenderer.removeListener("checks:progress", wrapped);
  },
});
