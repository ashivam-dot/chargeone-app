export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ENVIRONMENT: 'production' | 'development';
  GOOGLE_CLIENT_ID: string;
  SESSION_SECRET?: string;
  ORS_API_KEY?: string;
  RAZORPAY_KEY_ID: string;
  RAZORPAY_KEY_SECRET?: string;
  RAZORPAY_WEBHOOK_SECRET?: string;
  RAZORPAY_PLAN_MONTHLY: string;
  RAZORPAY_PLAN_YEARLY: string;
}

export const isDev = (env: Env) => env.ENVIRONMENT === 'development';
