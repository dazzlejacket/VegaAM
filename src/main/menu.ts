/**
 * Native application menu and keyboard accelerators for VegaAM 3.1.
 *
 * Since the main BrowserWindow displays the official SiriusXM web player edge
 * to edge (`autoHideMenuBar: true`), all VegaAM-specific windows and actions
 * are accessible through the visible top-right settings orb, native keyboard
 * shortcuts, the system tray, and the application menu (Alt on Windows/Linux,
 * top menu bar on macOS).
 *
 * The menu template itself lives in `menuTemplate.ts` so that it can be
 * tested without Electron.
 */

import { Menu } from 'electron';

import { buildAppMenuTemplate, type AppMenuActions } from './menuTemplate';

export { buildAppMenuTemplate, type AppMenuActions } from './menuTemplate';

export function installAppMenu(actions: AppMenuActions): void {
  const menu = Menu.buildFromTemplate(buildAppMenuTemplate(actions));
  Menu.setApplicationMenu(menu);
}
