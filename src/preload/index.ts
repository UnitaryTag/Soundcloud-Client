import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC } from '@shared/ipc'
import type { ScApi } from '@shared/ipc'
import type { AuthStatus } from '@shared/sc'

/**
 * The entire renderer-facing surface.
 *
 * `ipcRenderer` itself is never exposed — it cannot cross the contextBridge as
 * of Electron 29, and exposing it would hand the renderer every channel.
 * Individual channels are wrapped instead.
 *
 * This file is bundled into a single CommonJS file on purpose: a sandboxed
 * preload's `require` is a polyfill limited to `electron`, `events`, `timers`,
 * `url`, so it cannot be split across sibling files.
 */

const api: ScApi = {
  shell: {
    openExternal: (url) => ipcRenderer.invoke(IPC.ShellOpenExternal, url)
  },

  creds: {
    get: () => ipcRenderer.invoke(IPC.CredsGet)
  },

  auth: {
    onChanged: (cb) => {
      const listener = (_event: IpcRendererEvent, status: AuthStatus): void => cb(status)
      ipcRenderer.on(IPC.AuthChanged, listener)
      // Returning an unsubscriber is not optional: React StrictMode mounts
      // twice in dev, and leaking ipcRenderer listeners across mounts is the
      // classic Electron + React bug.
      return () => {
        ipcRenderer.removeListener(IPC.AuthChanged, listener)
      }
    }
  }
}

contextBridge.exposeInMainWorld('sc', api)
