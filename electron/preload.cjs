const { contextBridge, ipcRenderer } = require("electron");
const { enableSync } = require("./features.cjs");

const api = {
  scan: (opts) => ipcRenderer.invoke("scan:run", opts),
  sessionDetail: (opts) => ipcRenderer.invoke("session:detail", opts),
  sessionTranscript: (opts) => ipcRenderer.invoke("session:transcript", opts),
  features: { enableSync: !!enableSync },
};

if (enableSync) {
  api.sync = {
    getConfig: () => ipcRenderer.invoke("sync:getConfig"),
    saveConfig: (patch) => ipcRenderer.invoke("sync:saveConfig", patch),
    signIn: (opts) => ipcRenderer.invoke("sync:signIn", opts),
    signOut: () => ipcRenderer.invoke("sync:signOut"),
    upload: (scanResult) => ipcRenderer.invoke("sync:upload", scanResult),
    status: () => ipcRenderer.invoke("sync:status"),
  };
}

contextBridge.exposeInMainWorld("tokenStats", api);
