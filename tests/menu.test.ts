/**
 * The native application menu must keep the standard editing roles.
 *
 * Electron registers the clipboard accelerators (Ctrl+C / Ctrl+X / Ctrl+V /
 * Ctrl+A) from the menu items that carry the `copy`, `cut`, `paste` and
 * `selectAll` roles. VegaAM replaces the native menu with its own, so the
 * editing roles have to be part of that menu - without them a token or an API
 * key can only be typed by hand.
 */

import { describe, expect, it } from 'vitest';
import type { MenuItemConstructorOptions } from 'electron';

import { buildAppMenuTemplate, type AppMenuActions } from '../src/main/menuTemplate';

function actions(): AppMenuActions {
  const noop = (): void => undefined;
  return {
    showMain: noop,
    openSettings: noop,
    toggleQuickPanel: noop,
    resetSurfaceAppearance: noop,
    openActivity: noop,
    toggleCompact: noop,
    toggleSkin: noop,
    openSkinWithId: noop,
    setColorMode: noop,
    reloadPlayer: noop,
    goBack: noop,
    goForward: noop,
    toggleMute: noop,
    toggleAlwaysOnTop: noop,
    clearSession: noop,
    quit: noop,
  };
}

describe('native application menu', () => {
  const template = buildAppMenuTemplate(actions());

  it('has an Edit menu with the standard editing roles', () => {
    const edit = template.find((item) => item.label === 'Edit');
    expect(edit).toBeDefined();

    const submenu = (edit?.submenu ?? []) as MenuItemConstructorOptions[];
    const roles = submenu
      .map((item) => (item as { role?: string }).role)
      .filter(Boolean);
    expect(roles).toContain('cut');
    expect(roles).toContain('copy');
    expect(roles).toContain('paste');
    expect(roles).toContain('selectAll');
  });

  it('keeps the playback and settings accelerators', () => {
    const accelerators = JSON.stringify(template);
    expect(accelerators).toContain('CmdOrCtrl+,');
    expect(accelerators).toContain('CmdOrCtrl+Shift+A');
    expect(accelerators).toContain('CmdOrCtrl+M');
  });
});
