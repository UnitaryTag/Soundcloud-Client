import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { APP_PARTITION } from './media/session'
import { setAllowedSender } from './ipc/register'
import { registerShellHandlers } from './ipc/shell-handlers'
import { registerCredentialHandlers } from './credentials'
import { log } from './logger'

/**
 * Wiring order matters. Handlers are registered once, at ready, before any
 * window exists — a renderer that can invoke a channel before it is handled
 * gets an opaque "no handler registered" rejection.
 */

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
  return win
}

void app.whenReady().then(() => {
  registerShellHandlers()
  registerCredentialHandlers()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// TODO(auth): close the loopback callback server here once it exists — a
// cancelled login must not leak a listening socket.
app.on('will-quit', () => {
  log.info('shutting down')
})
