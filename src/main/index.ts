import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { IPC } from '@shared/ipc'
import { registerAuthHandlers } from './ipc/auth-handlers'
import { registerCatalogHandlers } from './ipc/catalog-handlers'
import { registerCredentialHandlers } from './credentials'
import { registerMediaHandlers } from './ipc/media-handlers'
import { setAllowedSender } from './ipc/register'
import { registerShellHandlers } from './ipc/shell-handlers'
import { log } from './logger'
import { APP_PARTITION } from './media/session'
import { createServices } from './services'

/**
 * Wiring order matters. Handlers are registered once, at ready, before any
 * window exists — a renderer that invokes a channel before it is handled gets
 * an opaque "no handler registered" rejection.
 */

let mainWindow: BrowserWindow | null = null

const createWindow = (): BrowserWindow => {
  const win = new BrowserWindow({
    width: 1100,
    height: 720,
    show: false,
    backgroundColor: '#0d0d10',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // Non-persistent: this session's caches die at quit. See media/session.ts
      // for why that is a ToS requirement, not a preference.
      partition: APP_PARTITION,
      // Electron 44's defaults are already correct. Stated explicitly so that
      // weakening any of them has to be a deliberate edit.
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.once('ready-to-show', () => win.show())

  // The renderer never navigates and never opens windows of its own. External
  // links go through the allowlisted shell:openExternal handler instead.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event) => event.preventDefault())

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl !== undefined && devUrl !== '') {
    void win.loadURL(devUrl)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  setAllowedSender(win.webContents)
  mainWindow = win
  return win
}

void app.whenReady().then(() => {
  const services = createServices({
    // Only URLs constructed by main reach this — the OAuth authorize URL, and
    // links the renderer routes through the allowlisted shell handler.
    openExternal: (url) => shell.openExternal(url),
    onAuthChanged: (status) => {
      // The renderer also polls status() on mount, so a change that lands
      // before the window exists is not lost.
      mainWindow?.webContents.send(IPC.AuthChanged, status)
    }
  })

  registerShellHandlers()
  registerCredentialHandlers()
  registerAuthHandlers(services.auth)
  registerCatalogHandlers(services.api)
  registerMediaHandlers(services.media, services.api)

  createWindow()

  // Fire and forget: startup must not block on a network round trip to /me.
  // The renderer reads status() immediately and receives a push if the restored
  // session resolves later.
  void services.auth.restore().catch((cause) => {
    log.error('could not restore the previous session:', cause)
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  // The loopback listener is closed in AuthService.begin()'s finally block on
  // every path, so there is nothing to release here yet. Kept as the hook for
  // anything that does need it later.
  log.info('shutting down')
})
