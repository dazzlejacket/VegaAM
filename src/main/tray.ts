/**
 * System tray integration (Windows, Linux and macOS menu bar) for VegaAM 3.1.
 */

import { join } from 'node:path';

import { Menu, Tray, nativeImage } from 'electron';

export interface TrayActions {
  showMain: () => void;
  openQuickPanel: () => void;
  resetSurfaceAppearance: () => void;
  toggleMini: () => boolean;
  openSkinWithId: (skinId: string) => void;
  openActivity: () => void;
  openSettings: () => void;
  togglePlayback: () => void;
  toggleMute: () => void;
  setAlwaysOnTop: (value: boolean) => void;
  quit: () => void;
}

export interface TrayState {
  alwaysOnTop: boolean;
  playing: boolean;
  muted: boolean;
  canPlayPause: boolean;
  title: string;
}

export class TrayController {
  private tray: Tray | undefined;

  constructor(private readonly actions: TrayActions) {}

  /** Create the tray icon using the monochrome V-star mark (16/32 HiDPI). */
  create(): void {
    if (this.tray) return;
    const iconPath = join(__dirname, '..', 'icons', 'tray.png');
    const image = nativeImage.createFromPath(iconPath);
    const resized = image.isEmpty() ? image : image.resize({ width: 16, height: 16 });
    this.tray = new Tray(resized);
    this.tray.setToolTip('VegaAM');
    this.tray.on('click', () => this.actions.showMain());
    this.update({
      alwaysOnTop: false,
      playing: false,
      muted: false,
      canPlayPause: false,
      title: '',
    });
  }

  /** Update the tray menu and tooltip. */
  update(state: TrayState): void {
    if (!this.tray) return;
    const template: Electron.MenuItemConstructorOptions[] = [
      { label: 'Open Official SiriusXM Player', click: () => this.actions.showMain() },
      { label: 'Appearance / Quick Panel', click: () => this.actions.openQuickPanel() },
      { label: 'Reset to Official Appearance', click: () => this.actions.resetSurfaceAppearance() },
      { type: 'separator' },
      { label: 'Compact Player', click: () => this.actions.toggleMini() },
      {
        label: 'Skinned Companion',
        submenu: [
          {
            label: 'Bluebird Classic',
            click: () => this.actions.openSkinWithId('bluebird-classic'),
          },
          {
            label: 'Retro Amp',
            click: () => this.actions.openSkinWithId('retro-amp'),
          },
          {
            label: 'Modern',
            click: () => this.actions.openSkinWithId('modern'),
          },
          {
            label: 'Retro Satellite',
            click: () => this.actions.openSkinWithId('retro-satellite'),
          },
          {
            label: 'Classic Compact',
            click: () => this.actions.openSkinWithId('classic-compact'),
          },
        ],
      },
      { type: 'separator' },
      { label: 'Scrobble Monitor & History', click: () => this.actions.openActivity() },
      { label: 'Settings…', click: () => this.actions.openSettings() },
      { type: 'separator' },
      ...(state.canPlayPause
        ? [
            {
              label: state.playing ? 'Pause' : 'Play',
              click: () => this.actions.togglePlayback(),
            } as Electron.MenuItemConstructorOptions,
          ]
        : []),
      {
        label: state.muted ? 'Unmute Player' : 'Mute Player',
        click: () => this.actions.toggleMute(),
      },
      {
        label: 'Always on Top (Companions)',
        type: 'checkbox',
        checked: state.alwaysOnTop,
        click: (item) => this.actions.setAlwaysOnTop(item.checked),
      },
      { type: 'separator' },
      { label: 'Quit VegaAM', click: () => this.actions.quit() },
    ];
    const menu = Menu.buildFromTemplate(template);
    this.tray.setContextMenu(menu);
    const tip = state.title ? `VegaAM — ${state.title}` : 'VegaAM';
    this.tray.setToolTip(tip);
  }

  destroy(): void {
    this.tray?.destroy();
    this.tray = undefined;
  }
}
