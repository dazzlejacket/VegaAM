/**
 * Renderer script for the 44x44 settings orb (`orb.html`).
 */

import type { VegaQuickApi } from '../../preload/quick';

declare global {
  interface Window {
    vegaQuick: VegaQuickApi;
  }
}

const openButton = document.getElementById('open-orb');

openButton?.addEventListener('click', () => {
  void window.vegaQuick.togglePanel('themes');
});

openButton?.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    void window.vegaQuick.togglePanel('themes');
  }
});
