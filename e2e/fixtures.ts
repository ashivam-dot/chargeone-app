import { test as base } from '@playwright/test';

export { expect } from '@playwright/test';

/** On macOS, Chrome's speechSynthesis plays through the system voice, which --mute-audio doesn't cover. */
export const test = base.extend({
  page: async ({ page, browserName }, use) => {
    // E2E_CPU_THROTTLE=4 runs every page 4x slower (DevTools CPU throttling), like a cheap Android phone or a busy
    // laptop. Use it to check that a change holds up under load before trusting a green run on an idle machine.
    const throttle = Number(process.env.E2E_CPU_THROTTLE ?? 0);
    if (throttle > 1 && browserName === 'chromium') {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
    }
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
