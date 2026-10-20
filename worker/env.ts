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
  /** Business UPI ID that direct UPI payments go to, e.g. chargeone@okaxis. Unset = UPI off. */
  UPI_VPA?: string;
  UPI_PAYEE_NAME?: string;
  /** Bearer token for the owner's payment tools (scripts/upi-admin.ts). At least 24 characters. */
  ADMIN_TOKEN?: string;
  /** Google Play Developer API service account key (JSON). Unset = Play billing off. */
  PLAY_SERVICE_ACCOUNT_JSON?: string;
  PLAY_PACKAGE_NAME?: string;
  AGENT_MODEL?: string;
  AGENT_FALLBACK_MODEL?: string;
}

export const isDev = (env: Env) => env.ENVIRONMENT === 'development';
