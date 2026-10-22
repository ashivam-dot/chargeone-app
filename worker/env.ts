export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  /** Workers AI; absent in CI and wherever the binding isn't configured. */
  AI?: Ai;
  ENVIRONMENT: 'production' | 'development';
  GOOGLE_CLIENT_ID: string;
  /**
   * Firebase Auth (email and password, phone with a one-time code). The public web config, not
   * secrets. API key and project id both set = those sign-in options on; either empty = off.
   */
  FIREBASE_API_KEY?: string;
  FIREBASE_PROJECT_ID?: string;
  FIREBASE_AUTH_DOMAIN?: string;
  FIREBASE_APP_ID?: string;
  SESSION_SECRET?: string;
  ORS_API_KEY?: string;
  /** Keyless router when ORS_API_KEY is unset: 'valhalla' (production default), 'osrm-demo' (development only, the default there) or 'off'. */
  PUBLIC_ROUTER?: 'valhalla' | 'osrm-demo' | 'off';
  RAZORPAY_KEY_ID: string;
  RAZORPAY_KEY_SECRET?: string;
  RAZORPAY_WEBHOOK_SECRET?: string;
  RAZORPAY_PLAN_MONTHLY: string;
  RAZORPAY_PLAN_YEARLY: string;
  /** Business UPI ID that direct UPI payments go to, e.g. chargeone@okaxis. Unset = UPI off. */
  UPI_VPA?: string;
  UPI_PAYEE_NAME?: string;
  /** The owner's admin console (/admin) and scripts/upi-admin.ts. At least 24 characters. Unset = admin off (503). */
  ADMIN_TOKEN?: string;
  /** Google Play Developer API service account key (JSON). Unset = Play billing off. */
  PLAY_SERVICE_ACCOUNT_JSON?: string;
  PLAY_PACKAGE_NAME?: string;
  /** The owner's voice-server (Supertonic 3), e.g. https://voice.example.in. Unset = HD voice off. */
  VOICE_TTS_URL?: string;
  /** Shared secret for voice-server, at least 24 characters. */
  VOICE_TTS_TOKEN?: string;
  /** Deepvue RC verification (registration number -> car). Unset = number lookup off. */
  DEEPVUE_CLIENT_ID?: string;
  DEEPVUE_CLIENT_SECRET?: string;
  /** Cashfree Secure ID vehicle RC, used when Deepvue isn't set up. */
  CASHFREE_CLIENT_ID?: string;
  CASHFREE_CLIENT_SECRET?: string;
  /** '1' = Cashfree sandbox (test numbers only). */
  CASHFREE_SANDBOX?: string;
  AGENT_MODEL?: string;
  AGENT_FALLBACK_MODEL?: string;
  /** Free Plus weeks one network may start a day (default 20). Raised for local end-to-end runs. */
  TRIAL_NETWORK_DAILY_LIMIT?: string;
}

export const isDev = (env: Env) => env.ENVIRONMENT === 'development';
