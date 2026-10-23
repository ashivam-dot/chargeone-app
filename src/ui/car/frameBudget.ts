/** Share of the main thread the 3D car may spend drawing while it animates; the rest stays free for taps and scrolling. */
export const DRAW_SHARE = 0.25;
/** Frame interval on a CPU-drawn canvas: the wheels still turn while driving, at about 8 frames a second. */
export const LITE_FRAME_MS = 120;
const VSYNC_MS = 16;

/**
 * How long to wait before asking for the next animation frame, given what a frame has been costing (ms).
 * On a real GPU a frame costs 1-3 ms and this is 0 (every vsync). On SwiftShader at 2x it can be 50 ms or
 * more, and drawing every vsync would leave no time for input: Playwright and real fingers then wait seconds.
 */
export function nextFrameDelay(costMs: number, lite: boolean): number {
  const cost = Number.isFinite(costMs) && costMs > 0 ? costMs : 0;
  const forShare = cost / DRAW_SHARE - cost - VSYNC_MS;
  return Math.round(Math.min(1000, Math.max(0, forShare, lite ? LITE_FRAME_MS : 0)));
}
