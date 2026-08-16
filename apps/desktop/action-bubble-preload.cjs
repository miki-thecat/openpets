const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("openPetsActionBubble", {
  select: (id) => ipcRenderer.invoke("openpets:action-bubble-select", id),
  back: () => ipcRenderer.invoke("openpets:action-bubble-back"),
  close: () => ipcRenderer.send("openpets:action-bubble-close"),
  onModel: (callback) => {
    if (typeof callback !== "function") return () => undefined;
    const listener = (_event, model) => callback(model);
    ipcRenderer.on("openpets:action-bubble-model", listener);
    return () => ipcRenderer.removeListener("openpets:action-bubble-model", listener);
  },
});
