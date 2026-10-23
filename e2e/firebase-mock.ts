import type { Page, Route } from "@playwright/test";

// A fake Firebase for the sign-in tests: nothing reaches Google. Covers the Identity Toolkit REST
// calls the app makes (sign up, sign in, emails, lookup) and the ones the Firebase SDK makes for phone
// sign-in (with reCAPTCHA off in test mode), the token refresh, and Google's GSI button script.
//
// The Worker can't verify these fake ID tokens, so the three endpoints that take one are answered
// here too: /api/auth/firebase, /api/auth/password-login and /api/auth/forgot. Each successful sign-in
// is turned into a real session through the development login (/api/auth/dev), so everything after it
// (the You screen, username claims, sign-out) runs on the real local Worker and D1.

export const OTP = "123456";
const PROJECT = "chargeone-512418";

export interface FakeUser {
  uid: string;
  email?: string;
  password?: string;
  emailVerified: boolean;
  displayName?: string;
  phone?: string;
  /** Learnt from a real username claim on the Worker. */
  username?: string;
}

const b64url = (v: unknown) =>
  Buffer.from(JSON.stringify(v)).toString("base64url");

/** A JWT-shaped token the SDK can parse (it reads exp and iat); the signature is a placeholder. */
function idToken(u: FakeUser): string {
  const now = Math.floor(Date.now() / 1000);
  const claims: Record<string, unknown> = {
    iss: `https://securetoken.google.com/${PROJECT}`,
    aud: PROJECT,
    auth_time: now,
    user_id: u.uid,
    sub: u.uid,
    iat: now,
    exp: now + 3600,
    firebase: {
      sign_in_provider: u.phone ? "phone" : "password",
      identities: {},
    },
  };
  if (u.email)
    Object.assign(claims, { email: u.email, email_verified: u.emailVerified });
  if (u.phone) claims.phone_number = u.phone;
  if (u.displayName) claims.name = u.displayName;
  return `${b64url({ alg: "RS256", kid: "e2e", typ: "JWT" })}.${b64url(claims)}.c2ln`;
}

function claimsOf(token: string): Record<string, unknown> | null {
  try {
    return JSON.parse(
      Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"),
    ) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const toolkitError = (route: Route, message: string, status = 400) =>
  route.fulfill({
    status,
    json: {
      error: {
        code: status,
        message,
        errors: [{ message, domain: "global", reason: "invalid" }],
      },
    },
  });

const maskEmail = (e: string) => {
  const [local, domain] = e.split("@");
  return `${local.slice(0, 1)}${"•".repeat(Math.max(1, local.length - 1))}@${domain}`;
};
const maskPhone = (p: string) =>
  `${p.slice(0, 3)}${"•".repeat(Math.max(0, p.length - 6))}${p.slice(-3)}`;

/** The development login only takes lower-case "name@local.test" addresses. */
const devEmail = (u: FakeUser) =>
  u.email?.endsWith("@local.test")
    ? u.email
    : `fb-${u.uid.toLowerCase()}@local.test`;

export class FakeFirebase {
  readonly users = new Map<string, FakeUser>();
  /** Every Identity Toolkit method called, in order, e.g. "signUp", "sendOobCode:VERIFY_EMAIL". */
  readonly calls: string[] = [];
  /** Phone numbers a code was "texted" to. */
  readonly texts: string[] = [];
  /** Requests that went to Google for real; the tests assert this stays empty. */
  readonly leaks: string[] = [];
  private seq = 0;
  /** What /api/me should say about the user the fake signed in (the dev account knows only an email). */
  private me: {
    email: string | null;
    phone: string | null;
    methods: string[];
    name: string | null;
  } | null = null;

  private readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  addUser(u: Omit<FakeUser, "uid"> & { uid?: string }): FakeUser {
    const user = {
      uid: u.uid ?? `UID${++this.seq}${Date.now().toString(36).toUpperCase()}`,
      ...u,
    };
    this.users.set(user.uid, user);
    return user;
  }

  byEmail = (email: string) =>
    [...this.users.values()].find((u) => u.email === email.toLowerCase());
  private byToken = (token: unknown) => {
    const c = typeof token === "string" ? claimsOf(token) : null;
    return c ? this.users.get(String(c.sub)) : undefined;
  };

  /** Marks the email verified, as opening the link in the email would. */
  verify(email: string): void {
    const u = this.byEmail(email);
    if (!u) throw new Error(`no fake user ${email}`);
    u.emailVerified = true;
  }

  async install(): Promise<void> {
    const page = this.page;
    // Anything else of Google's that the sign-in might reach is recorded and refused.
    await page.route(
      /^https:\/\/(www\.google\.com\/recaptcha|www\.gstatic\.com\/recaptcha|apis\.google\.com|[a-z0-9-]+\.firebaseapp\.com)\//,
      (route) => {
        this.leaks.push(route.request().url());
        return route.abort();
      },
    );
    await page.route("https://identitytoolkit.googleapis.com/**", (route) =>
      this.toolkit(route),
    );
    await page.route("https://securetoken.googleapis.com/**", (route) =>
      this.refresh(route),
    );
    await page.route("https://accounts.google.com/gsi/client", (route) =>
      route.fulfill({ contentType: "text/javascript", body: GSI_STUB }),
    );
    await page.route("**/api/auth/firebase", (route) =>
      this.workerFirebase(route),
    );
    // The fake GSI hands back "gsi:<email>" as its credential.
    await page.route("**/api/auth/google", (route) => {
      const credential = String(
        (route.request().postDataJSON() as { credential?: string } | null)
          ?.credential ?? "",
      );
      const email = credential.replace(/^gsi:/, "");
      const u =
        this.byEmail(email) ??
        this.addUser({
          email,
          emailVerified: true,
          displayName: "Google Driver",
        });
      this.calls.push("worker:google");
      return this.session(route, u, {}, "google");
    });
    await page.route("**/api/auth/password-login", (route) =>
      this.workerPasswordLogin(route),
    );
    await page.route("**/api/auth/forgot", (route) => {
      this.calls.push("worker:forgot");
      return route.fulfill({
        json: {
          ok: true,
          message:
            "If an account exists for that email or username, we've emailed it a link to reset the password.",
        },
      });
    });
    // Usernames are claimed on the real Worker; remember them for the username sign-in.
    await page.route("**/api/auth/username", async (route) => {
      const res = await route.fetch();
      if (res.ok()) {
        const { username } = (await res.json()) as { username: string };
        const u = this.current && this.users.get(this.current);
        if (u) u.username = username;
      }
      return route.fulfill({ response: res });
    });
    await page.route("**/api/me", async (route) => {
      if (route.request().method() !== "GET" || !this.me)
        return route.fallback();
      const res = await route.fetch();
      const body = (await res.json()) as {
        user: Record<string, unknown> | null;
      };
      return route.fulfill({
        response: res,
        json: body.user
          ? { ...body, user: { ...body.user, ...this.me } }
          : body,
      });
    });
  }

  /** The fake user the last sign-in was for. */
  current: string | null = null;

  private async toolkit(route: Route): Promise<void> {
    const req = route.request();
    const url = new URL(req.url());
    const method = url.pathname.split(":").pop() ?? url.pathname;
    const body = (req.postDataJSON() ?? {}) as Record<string, unknown>;
    if (req.method() === "GET") {
      this.calls.push(`GET ${url.pathname}`);
      // reCAPTCHA Enterprise config, project config: nothing switched on.
      if (url.pathname.endsWith("/recaptchaConfig")) {
        return route.fulfill({
          json: {
            recaptchaKey: "projects/e2e/keys/e2e",
            recaptchaEnforcementState: [
              { provider: "EMAIL_PASSWORD_PROVIDER", enforcementState: "OFF" },
              { provider: "PHONE_PROVIDER", enforcementState: "OFF" },
            ],
          },
        });
      }
      if (url.pathname.endsWith("/recaptchaParams"))
        return route.fulfill({ json: { recaptchaSiteKey: "e2e-site-key" } });
      return route.fulfill({
        json: { authorizedDomains: ["localhost", "127.0.0.1"] },
      });
    }
    const tag =
      method === "sendOobCode"
        ? `sendOobCode:${String(body.requestType)}`
        : method;
    this.calls.push(tag);
    switch (method) {
      case "signUp": {
        const email = String(body.email ?? "").toLowerCase();
        if (this.byEmail(email)) return toolkitError(route, "EMAIL_EXISTS");
        if (String(body.password ?? "").length < 6)
          return toolkitError(
            route,
            "WEAK_PASSWORD : Password should be at least 6 characters",
          );
        const u = this.addUser({
          email,
          password: String(body.password),
          emailVerified: false,
        });
        return route.fulfill({
          json: {
            kind: "identitytoolkit#SignupNewUserResponse",
            idToken: idToken(u),
            refreshToken: `rt-${u.uid}`,
            expiresIn: "3600",
            localId: u.uid,
            email,
          },
        });
      }
      case "signInWithPassword": {
        const u = this.byEmail(String(body.email ?? ""));
        if (!u || u.password !== body.password)
          return toolkitError(route, "INVALID_LOGIN_CREDENTIALS");
        return route.fulfill({
          json: {
            idToken: idToken(u),
            refreshToken: `rt-${u.uid}`,
            expiresIn: "3600",
            localId: u.uid,
            email: u.email,
            registered: true,
          },
        });
      }
      case "update": {
        const u = this.byToken(body.idToken);
        if (!u) return toolkitError(route, "INVALID_ID_TOKEN");
        if (typeof body.displayName === "string")
          u.displayName = body.displayName;
        return route.fulfill({
          json: { localId: u.uid, email: u.email, displayName: u.displayName },
        });
      }
      case "sendOobCode": {
        if (body.requestType === "VERIFY_EMAIL" && !this.byToken(body.idToken))
          return toolkitError(route, "INVALID_ID_TOKEN");
        return route.fulfill({
          json: { email: body.email ?? this.byToken(body.idToken)?.email },
        });
      }
      case "lookup": {
        const u = this.byToken(body.idToken);
        if (!u) return toolkitError(route, "INVALID_ID_TOKEN");
        return route.fulfill({
          json: {
            users: [
              {
                localId: u.uid,
                email: u.email,
                emailVerified: u.emailVerified,
                phoneNumber: u.phone,
                displayName: u.displayName,
                providerUserInfo: u.phone
                  ? [
                      {
                        providerId: "phone",
                        phoneNumber: u.phone,
                        rawId: u.phone,
                      },
                    ]
                  : [
                      {
                        providerId: "password",
                        email: u.email,
                        rawId: u.email,
                      },
                    ],
                lastLoginAt: String(Date.now()),
                createdAt: String(Date.now()),
              },
            ],
          },
        });
      }
      case "delete":
        return route.fulfill({ json: {} });
      case "sendVerificationCode": {
        const phone = String(body.phoneNumber ?? "");
        if (!/^\+\d{8,15}$/.test(phone))
          return toolkitError(route, "INVALID_PHONE_NUMBER");
        this.texts.push(phone);
        return route.fulfill({ json: { sessionInfo: `sess-${phone}` } });
      }
      case "signInWithPhoneNumber": {
        const phone = String(body.sessionInfo ?? "").replace(/^sess-/, "");
        if (!phone) return toolkitError(route, "INVALID_SESSION_INFO");
        if (body.code !== OTP) return toolkitError(route, "INVALID_CODE");
        const u =
          [...this.users.values()].find((x) => x.phone === phone) ??
          this.addUser({ phone, emailVerified: false });
        return route.fulfill({
          json: {
            idToken: idToken(u),
            refreshToken: `rt-${u.uid}`,
            expiresIn: "3600",
            localId: u.uid,
            phoneNumber: phone,
            isNewUser: false,
          },
        });
      }
      default:
        return toolkitError(route, "OPERATION_NOT_ALLOWED");
    }
  }

  private async refresh(route: Route): Promise<void> {
    this.calls.push("refresh");
    const form = new URLSearchParams(route.request().postData() ?? "");
    const u = this.users.get(
      (form.get("refresh_token") ?? "").replace(/^rt-/, ""),
    );
    if (!u) return toolkitError(route, "INVALID_REFRESH_TOKEN");
    return route.fulfill({
      json: {
        id_token: idToken(u),
        refresh_token: `rt-${u.uid}`,
        user_id: u.uid,
        expires_in: "3600",
        token_type: "Bearer",
      },
    });
  }

  /** Signs the browser in for real (development login) as this fake user and answers with its /api/me. */
  private async session(
    route: Route,
    u: FakeUser,
    extra: Record<string, unknown> = {},
    method?: string,
  ): Promise<void> {
    const kind = method ?? (u.phone ? "phone" : "password");
    const res = await route.fetch({
      url: new URL("/api/auth/dev", route.request().url()).toString(),
      method: "POST",
      // The Worker learns how this account signs in (a username needs a password).
      postData: JSON.stringify({
        email: devEmail(u),
        ...(kind === "google" ? {} : { method: kind }),
      }),
      headers: {
        ...route.request().headers(),
        "content-type": "application/json",
      },
    });
    const body = (await res.json()) as { user: Record<string, unknown> };
    this.current = u.uid;
    this.me = {
      email: u.email ?? null,
      phone: u.phone ? maskPhone(u.phone) : null,
      methods: [kind],
      name: u.displayName ?? (u.phone ? null : String(body.user.name ?? "")),
    };
    return route.fulfill({
      response: res,
      json: { ...body, user: { ...body.user, ...this.me }, ...extra },
    });
  }

  private async workerFirebase(route: Route): Promise<void> {
    const body = (route.request().postDataJSON() ?? {}) as {
      idToken?: string;
      name?: string;
    };
    const u = this.byToken(body.idToken);
    if (!u)
      return route.fulfill({
        status: 401,
        json: {
          error: "bad_firebase_token",
          message: "Sign-in failed. Please try again.",
        },
      });
    if (body.name && !u.displayName) u.displayName = body.name;
    if (!u.phone && !u.emailVerified) {
      const email = maskEmail(u.email ?? "");
      return route.fulfill({
        status: 403,
        json: {
          error: "email_unverified",
          message: `Verify your email first: open the link we sent to ${email}.`,
          email,
        },
      });
    }
    return this.session(route, u);
  }

  private async workerPasswordLogin(route: Route): Promise<void> {
    const body = (route.request().postDataJSON() ?? {}) as {
      username?: string;
      password?: string;
    };
    const u = [...this.users.values()].find(
      (x) => x.username && x.username === body.username,
    );
    if (!u || u.password !== body.password) {
      return route.fulfill({
        status: 401,
        json: {
          error: "invalid_credentials",
          message: "That username or password isn't right.",
        },
      });
    }
    if (!u.emailVerified) {
      const email = maskEmail(u.email ?? "");
      return route.fulfill({
        status: 403,
        json: {
          error: "email_unverified",
          message: `Verify your email first: open the link we sent to ${email}.`,
          email,
          idToken: idToken(u),
        },
      });
    }
    return this.session(route, u, { firebaseIdToken: idToken(u) });
  }
}

/** Google's GSI client, enough to draw a button in an iframe and hand back a credential. */
const GSI_STUB = `
window.google = { accounts: { id: {
  initialize: function (o) { window.__gsi = o; },
  renderButton: function (el, o) {
    var f = document.createElement('iframe');
    f.title = 'Sign in with Google Button';
    f.setAttribute('data-theme', o.theme);
    f.style.width = (o.width || 300) + 'px';
    f.style.height = '44px';
    f.style.border = '0';
    f.style.borderRadius = '22px';
    f.style.background = o.theme === 'filled_black' ? '#131314' : '#ffffff';
    f.style.boxShadow = o.theme === 'filled_black' ? 'none' : 'inset 0 0 0 1px #747775';
    f.srcdoc = '<body style="margin:0;display:flex;align-items:center;justify-content:center;height:44px;font:500 14px system-ui;color:' + (o.theme === 'filled_black' ? '#e3e3e3' : '#1f1f1f') + ';background:transparent">Continue with Google</body>';
    el.appendChild(f);
  },
  prompt: function () {},
  disableAutoSelect: function () {}
} } };
`;
