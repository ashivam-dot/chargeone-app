// No Cloudflare types here: scripts (the trip benchmark) import this through valhalla.ts under the app tsconfig.

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}
