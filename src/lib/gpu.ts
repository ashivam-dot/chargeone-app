/** What the device can draw: no WebGL at all, WebGL on a real GPU, or WebGL emulated on the CPU. */
export interface GlInfo {
  ok: boolean;
  /**
   * WebGL runs on the CPU (SwiftShader, llvmpipe): Chrome does this for blocklisted GPUs on older phones and in
   * headless browsers. Every frame then costs the main thread tens of milliseconds, so the car is drawn on demand.
   */
  software: boolean;
  renderer: string;
}

const SOFTWARE = /swiftshader|llvmpipe|softpipe|software|basic render/i;

let cached: GlInfo | undefined;

export function glInfo(): GlInfo {
  if (cached) return cached;
  cached = { ok: false, software: false, renderer: '' };
  try {
    const c = document.createElement('canvas');
    const gl = (c.getContext('webgl2') ?? c.getContext('webgl')) as WebGLRenderingContext | null;
    if (gl) {
      const debug = gl.getExtension('WEBGL_debug_renderer_info');
      const renderer = String(gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? '');
      // A browser that would fall back to the CPU refuses a context that asks to fail on a major performance caveat.
      const strict = document.createElement('canvas').getContext('webgl', { failIfMajorPerformanceCaveat: true });
      const caveat = strict === null;
      // Hand both probe contexts back at once; browsers cap live WebGL contexts at about 16.
      strict?.getExtension('WEBGL_lose_context')?.loseContext();
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      cached = { ok: true, software: SOFTWARE.test(renderer) || caveat, renderer };
    }
  } catch {
    // No WebGL: the flat drawing is shown.
  }
  return cached;
}
