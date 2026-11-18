import { describe, expect, it } from 'vitest';

import {
  ORB_HEIGHT,
  ORB_WIDTH,
  PANEL_WIDTH,
  computeOrbBounds,
  computePanelBounds,
  normalizeDrawerTab,
} from '../src/main/quickPanel';

describe('Integrated In-Window Launcher Pill & Studio Drawer geometry (VegaAM 3.2)', () => {
  it('normalizes drawer tab names cleanly', () => {
    expect(normalizeDrawerTab('appearance')).toBe('appearance');
    expect(normalizeDrawerTab('themes')).toBe('appearance');
    expect(normalizeDrawerTab('settings')).toBe('appearance');
    expect(normalizeDrawerTab('activity')).toBe('activity');
    expect(normalizeDrawerTab('scrobbling')).toBe('scrobbling');
    expect(normalizeDrawerTab('accounts')).toBe('accounts');
    expect(normalizeDrawerTab('companions')).toBe('companions');
    expect(normalizeDrawerTab('quick')).toBe('companions');
    expect(normalizeDrawerTab('about')).toBe('about');
    expect(normalizeDrawerTab(undefined)).toBe('appearance');
  });

  it('computes the 128x38 top-right pill and integrated right-side drawer at 1280x800', () => {
    const contentBounds = { x: 0, y: 0, width: 1280, height: 800 };
    const pill = computeOrbBounds(contentBounds);
    const drawer = computePanelBounds(contentBounds);

    expect(pill).toEqual({
      x: 1134,
      y: 13,
      width: ORB_WIDTH,
      height: ORB_HEIGHT,
    });
    expect(drawer).toEqual({
      x: 568,
      y: 12,
      width: PANEL_WIDTH,
      height: 776,
    });
    // Left 568px of SiriusXM remains visible
    expect(drawer.x).toBeGreaterThanOrEqual(500);
  });

  it('clamps the drawer inside a minimum 900x600 window while keeping SiriusXM visible on the left', () => {
    const minContentBounds = { x: 0, y: 0, width: 900, height: 600 };
    const pill = computeOrbBounds(minContentBounds);
    const drawer = computePanelBounds(minContentBounds);

    expect(pill).toEqual({
      x: 754,
      y: 13,
      width: ORB_WIDTH,
      height: ORB_HEIGHT,
    });
    expect(drawer).toEqual({
      x: 384,
      y: 12,
      width: 504,
      height: 576,
    });
    expect(drawer.x).toBeGreaterThanOrEqual(240);
    expect(drawer.x + drawer.width).toBeLessThanOrEqual(minContentBounds.width - 12);
    expect(drawer.y + drawer.height).toBeLessThanOrEqual(minContentBounds.height - 12);
  });

  it('clamps bounds to the display workArea when provided', () => {
    const workArea = { x: 0, y: 0, width: 1920, height: 1040 };
    const partiallyOffRight = { x: 1200, y: -10, width: 1000, height: 800 };

    const pill = computeOrbBounds(partiallyOffRight, workArea);
    const drawer = computePanelBounds(partiallyOffRight, workArea);

    expect(pill.x + pill.width).toBeLessThanOrEqual(workArea.x + workArea.width);
    expect(pill.y).toBeGreaterThanOrEqual(workArea.y);
    expect(drawer.x + drawer.width).toBeLessThanOrEqual(workArea.x + workArea.width);
    expect(drawer.y).toBeGreaterThanOrEqual(workArea.y);
  });
});
