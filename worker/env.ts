export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  /** Workers AI; absent in CI and wherever the binding isn't configured. */
  AI?: Ai;
  ENVIRONMENT: 'production' | 'development';
  GOOGLE_CLIENT_ID: string;
  SESSION_SECRET?: string;
  ORS_API_KEY?: string;
  RAZORPAY_KEY_ID: string;
  RAZORPAY_KEY_SECRET?: string;
  RAZORPAY_WEBHOOK_SECRET?: string;
  RAZORPAY_PLAN_MONTHLY: string;
  RAZORPAY_PLAN_YEARLY: string;
  AGENT_MODEL?: string;
  AGENT_FALLBACK_MODEL?: string;
}

export const isDev = (env: Env) => env.ENVIRONMENT === 'development';
