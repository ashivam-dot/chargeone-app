import { FEEDBACK_CATEGORIES, type FeedbackCategory, type FeedbackRequest } from '../src/shared/contracts.ts';
import type { User } from './auth.ts';
import type { Env } from './env.ts';
import { HttpError, clientKey, enforceRateLimit, readJson, requireDevice, str } from './http.ts';

const PLATFORMS: Array<FeedbackRequest['platform']> = ['web', 'android', 'ios'];
const MAX_MESSAGE = 1000;
const PER_DEVICE_PER_DAY = 5;
/** Generous because many drivers can share one mobile carrier IP. */
const PER_IP_PER_DAY = 10;

const invalid = (field: string) => new HttpError(400, 'invalid', `Invalid ${field}.`);

/** Keeps line breaks but drops other control characters. */
function cleanMessage(raw: unknown): string {
  if (typeof raw !== 'string') throw invalid('message');
  const text = raw.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').trim();
  if (text.length > MAX_MESSAGE) throw invalid('message');
  return text;
}

export function parseFeedback(body: Record<string, unknown>, signedIn: boolean): FeedbackRequest {
  const { rating, category, platform, contactOk } = body;
  if (typeof rating !== 'number' || !Number.isInteger(rating) || rating < 1 || rating > 5) throw invalid('rating');
  if (typeof category !== 'string' || !FEEDBACK_CATEGORIES.includes(category as FeedbackCategory)) throw invalid('category');
  if (typeof platform !== 'string' || !PLATFORMS.includes(platform as FeedbackRequest['platform'])) throw invalid('platform');
  if (typeof contactOk !== 'boolean') throw invalid('contactOk');
  return {
    rating,
    category: category as FeedbackCategory,
    message: cleanMessage(body.message),
    screen: str(body, 'screen', { max: 40, pattern: /^[A-Za-z0-9 _-]+$/ })!,
    appVersion: str(body, 'appVersion', { max: 20, pattern: /^[A-Za-z0-9._+-]+$/ })!,
    platform: platform as FeedbackRequest['platform'],
    contactOk: signedIn && contactOk,
  };
}

export async function createFeedback(req: Request, env: Env, user: User | null): Promise<void> {
  const device = await requireDevice(req);
  const f = parseFeedback(await readJson(req, 8 * 1024), user !== null);
  await enforceRateLimit(env.DB, `feedback-dev:${device}`, PER_DEVICE_PER_DAY, 86400);
  await enforceRateLimit(env.DB, `feedback-ip:${await clientKey(req)}`, PER_IP_PER_DAY, 86400);
  await env.DB.prepare(
    `INSERT INTO feedback (user_id, device_hash, rating, category, message, screen, app_version, platform, contact_ok, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
  )
    .bind(user?.id ?? null, device, f.rating, f.category, f.message, f.screen, f.appVersion, f.platform, f.contactOk ? 1 : 0, new Date().toISOString())
    .run();
}
