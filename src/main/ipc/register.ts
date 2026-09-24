import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { err, AppErrorCode, type Result } from '@shared/result'
import { log } from '../logger'

/**
 * The only place `ipcMain.handle` is called.
 *
 * Two things every handler gets for free:
 *  - sender validation (security checklist item 17 — with more than one window
 *    or any iframe, the caller is not necessarily your main window)
 *  - thrown errors converted to a Result, because only `message` survives IPC
 *    serialization — no stack, no custom properties
 */

let allowedSender: WebContents | null = null

export const setAllowedSender = (contents: WebContents): void => {
  allowedSender = contents
}

type Handler<T> = (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<Result<T>>

export const handle = <T>(channel: string, fn: Handler<T>): void => {
  ipcMain.handle(channel, async (event, ...args: unknown[]): Promise<Result<T>> => {
    if (allowedSender !== null && event.sender !== allowedSender) {
      log.warn(`rejected IPC on ${channel} from an unexpected sender`)
      return err<T>(AppErrorCode.Unknown, 'Rejected IPC from an unexpected sender.')
    }
    try {
      return await fn(event, ...args)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      log.error(`handler ${channel} threw:`, message)
      return err<T>(AppErrorCode.Unknown, message)
    }
  })
}
