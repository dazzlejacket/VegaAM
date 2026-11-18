/**
 * Global typing for the renderer windows.
 *
 * The API surface is defined once in the preload script and shared by the
 * main window and the mini player.
 */

import type { SxmApi } from '../preload/app';

declare global {
  interface Window {
    sxm: SxmApi;
  }
}

export {};
