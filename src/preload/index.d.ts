import type { ScApi } from '@shared/ipc'

/**
 * Augments `Window` for the renderer.
 *
 * This file must be in tsconfig.web.json's `include` (it is) or the renderer
 * will not see the augmentation. It is a .d.ts, so it emits nothing and never
 * reaches the preload bundle's runtime path.
 */
declare global {
  interface Window {
    sc: ScApi
  }
}

export {}
