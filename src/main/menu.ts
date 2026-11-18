/**
 * Native application menu and keyboard accelerators for VegaAM 3.1.
 *
 * Since the main BrowserWindow displays the official SiriusXM web player edge
 * to edge (`autoHideMenuBar: true`), all VegaAM-specific windows and actions
 * are accessible through the visible top-right settings orb, native keyboard
 * shortcuts, the system tray, and the application menu (Alt on Windows/Linux,
 * top menu bar on macOS).
 */

import { Menu, type MenuItemConstructorOptions } from 'electron';

export interface AppMenuActions {
  showMain: () => void;
  openSettings: () => void;
  toggleQuickPanel: () => void;
  resetSurfaceAppearance: () => void;
  openActivity: () => void;
  toggleCompact: () => void;
  toggleSkin: () => void;
  openSkinWithId: (skinId: string) => void;
  setColorMode: (mode: 'dark' | 'light' | 'system') => void;
  reloadPlayer: () => void;
  goBack: () => void;
  goForward: () => void;
  toggleMute: () => void;
  toggleAlwaysOnTop: () => void;
  clearSession: () => void;
  quit: () => void;
}

export function buildAppMenuTemplate(actions: AppMenuActions): MenuItemConstructorOptions[] {
  return [
    {
      label: 'VegaAM',
      submenu: [
        {
          label: 'Open Official SiriusXM Player',
          accelerator: 'CmdOrCtrl+1',
          click: () => actions.showMain(),
        },
        { type: 'separator' },
        {
          label: 'Appearance…',
          accelerator: 'CmdOrCtrl+Shift+,',
          click: () => actions.toggleQuickPanel(),
        },
        {
          label: 'Show Quick Panel',
          click: () => actions.toggleQuickPanel(),
        },
        {
          label: 'Reset SiriusXM Appearance',
          click: () => actions.resetSurfaceAppearance(),
        },
        { type: 'separator' },
        {
          label: 'Settings…',
          accelerator: 'CmdOrCtrl+,',
          click: () => actions.openSettings(),
        },
        {
          label: 'Scrobble Monitor & History',
          accelerator: 'CmdOrCtrl+Shift+A',
          click: () => actions.openActivity(),
        },
        { type: 'separator' },
        {
          label: 'Clear SiriusXM Session (Sign Out)…',
          click: () => actions.clearSession(),
        },
        { type: 'separator' },
        {
          label: 'Quit VegaAM',
          accelerator: 'CmdOrCtrl+Q',
          click: () => actions.quit(),
        },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Reload Official Player',
          accelerator: 'CmdOrCtrl+R',
          click: () => actions.reloadPlayer(),
        },
        {
          label: 'Back',
          accelerator: 'Alt+Left',
          click: () => actions.goBack(),
        },
        {
          label: 'Forward',
          accelerator: 'Alt+Right',
          click: () => actions.goForward(),
        },
        { type: 'separator' },
        { label: 'Actual Size', role: 'resetZoom' },
        { label: 'Zoom In', role: 'zoomIn' },
        { label: 'Zoom Out', role: 'zoomOut' },
        { type: 'separator' },
        { label: 'Toggle Full Screen', role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Companions',
      submenu: [
        {
          label: 'Toggle Compact Player',
          accelerator: 'CmdOrCtrl+Shift+M',
          click: () => actions.toggleCompact(),
        },
        {
          label: 'Toggle Skinned Companion',
          accelerator: 'CmdOrCtrl+Shift+K',
          click: () => actions.toggleSkin(),
        },
        { type: 'separator' },
        {
          label: 'Bluebird Classic Companion',
          accelerator: 'CmdOrCtrl+Shift+B',
          click: () => actions.openSkinWithId('bluebird-classic'),
        },
        {
          label: 'Retro Amp Companion',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: () => actions.openSkinWithId('retro-amp'),
        },
        {
          label: 'Modern Companion',
          click: () => actions.openSkinWithId('modern'),
        },
        {
          label: 'Retro Satellite Companion',
          click: () => actions.openSkinWithId('retro-satellite'),
        },
        {
          label: 'Classic Compact Companion',
          click: () => actions.openSkinWithId('classic-compact'),
        },
        { type: 'separator' },
        {
          label: 'Companion Colour Mode',
          submenu: [
            { label: 'Dark Mode', click: () => actions.setColorMode('dark') },
            { label: 'Light Mode', click: () => actions.setColorMode('light') },
            { label: 'Follow System', click: () => actions.setColorMode('system') },
          ],
        },
        { type: 'separator' },
        {
          label: 'Keep Companions Always on Top',
          click: () => actions.toggleAlwaysOnTop(),
        },
      ],
    },
    {
      label: 'Playback',
      submenu: [
        {
          label: 'Mute / Unmute Official Player',
          accelerator: 'CmdOrCtrl+M',
          click: () => actions.toggleMute(),
        },
      ],
    },
  ];
}

export function installAppMenu(actions: AppMenuActions): void {
  const menu = Menu.buildFromTemplate(buildAppMenuTemplate(actions));
  Menu.setApplicationMenu(menu);
}
