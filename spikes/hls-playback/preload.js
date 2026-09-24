const { contextBridge, ipcRenderer } = require('electron')

// Mimics the production `window.sc.media` surface just closely enough that the
// real IpcLoader can be dropped in unchanged.
contextBridge.exposeInMainWorld('sc', {
  media: {
    fetch: (url, range) => ipcRenderer.invoke('spike:media-fetch', url, range)
  }
})

// Spike-only: how the page hands its measurements back to the harness.
contextBridge.exposeInMainWorld('spike', {
  report: (payload) => ipcRenderer.invoke('spike:report', payload)
})
