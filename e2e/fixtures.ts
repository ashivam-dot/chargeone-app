import { test as base } from '@playwright/test';

export { expect } from '@playwright/test';

/** On macOS, Chrome's speechSynthesis plays through the system voice, which --mute-audio doesn't cover. */
export const test = base.extend({
  page: async ({ page }, use) => {
    await page.addInitScript(() => {
      if (!('speechSynthesis' in window)) return;
      const synth = window.speechSynthesis;
      synth.speak = (u: SpeechSynthesisUtterance) => {
        setTimeout(() => u.dispatchEvent(new Event('end')), 0);
      };
    });
    await use(page);
  },
});
