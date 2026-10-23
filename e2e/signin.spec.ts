import type { Page } from "@playwright/test";
import { FakeFirebase, OTP } from "./firebase-mock.ts";
import { expect, test } from "./fixtures.ts";
import { animationsSettled, openApp, watchErrors } from "./helpers.ts";

// Sign-in with Google, email or username and password, and a phone number with a one-time code.
// Firebase and Google are faked (e2e/firebase-mock.ts): nothing leaves the machine.

const BAD_LOGIN = "That email, username or password isn't right.";
const FORGOT =
  "If an account exists for that email or username, we've emailed it a link to reset the password.";
const PASSWORD = "charge4ward";

const unique = () =>
  `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const freshEmail = () => `e2e.${unique()}@local.test`;
const freshUsername = () => `e2e_${unique()}`.slice(0, 20);

async function setup(page: Page, opts: { phone?: boolean } = {}) {
  const fb = new FakeFirebase(page);
  await fb.install();
  // Phone sign-in runs the real Firebase SDK with reCAPTCHA off; only allowed on a dev server on localhost.
  if (opts.phone)
    await page.addInitScript(() =>
      Object.assign(window, { __CHARGEONE_E2E_PHONE__: true }),
    );
  const errors = watchErrors(page);
  await openApp(page);
  return { fb, errors };
}

async function openSignIn(page: Page) {
  await page.getByTestId("tab-you").click();
  await page.getByTestId("you-signin").click();
  await expect(page.getByTestId("signin-sheet")).toBeVisible();
}

/** Signed in: the You screen shows the account and no sign-in button. */
async function expectSignedIn(page: Page, text: string | RegExp) {
  await expect(page.getByTestId("signin-sheet")).toBeHidden();
  await expect(page.getByTestId("you-signin")).toHaveCount(0);
  await expect(page.getByTestId("screen-you")).toContainText(text);
}

test.describe("sign-in sheet", () => {
  test("offers Google, then email or phone, when both are configured", async ({
    page,
  }) => {
    const { fb, errors } = await setup(page);
    await openSignIn(page);
    const sheet = page.getByTestId("signin-sheet");
    await expect(
      sheet.getByTestId("signin-google").locator("iframe"),
    ).toBeVisible();
    await expect(sheet.getByRole("separator")).toHaveText("or");
    await expect(sheet.getByRole("tab", { name: "Email" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(sheet.getByLabel("Email or username")).toHaveAttribute(
      "autocomplete",
      "username",
    );
    await expect(sheet.getByLabel("Password", { exact: true })).toHaveAttribute(
      "autocomplete",
      "current-password",
    );
    // Arrow keys move between the tabs.
    await sheet.getByRole("tab", { name: "Email" }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(sheet.getByRole("tab", { name: "Phone" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(sheet.getByLabel("Mobile number")).toHaveAttribute(
      "autocomplete",
      "tel",
    );

    // Google's callback signs in through the Worker.
    await page.evaluate(() =>
      (
        window as unknown as {
          __gsi: { callback: (r: { credential: string }) => void };
        }
      ).__gsi.callback({ credential: "gsi:g.driver@local.test" }),
    );
    // Usernames are for password sign-in, so a Google account is not offered one.
    await expectSignedIn(page, "Google Driver");
    await expect(page.getByTestId("signin-username")).toHaveCount(0);
    await expect(page.getByTestId("you-set-username")).toHaveCount(0);
    expect(fb.calls).toContain("worker:google");
    expect(fb.leaks).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("registers, waits for the email to be verified, then signs in with the chosen username", async ({
    page,
  }) => {
    const { fb, errors } = await setup(page);
    const email = freshEmail();
    const username = freshUsername();
    await openSignIn(page);
    await page.getByTestId("signin-register").click();
    await expect(
      page.getByRole("dialog", { name: "Create account" }),
    ).toBeVisible();

    // Nothing filled in: every problem shows at once, nothing is sent.
    await page.getByTestId("register-submit").click();
    await expect(page.getByTestId("signin-register-form")).toContainText(
      "Enter your name.",
    );
    await expect(page.getByTestId("signin-register-form")).toContainText(
      "Agree to the terms",
    );
    expect(fb.calls).not.toContain("signUp");

    await page.getByTestId("register-name").fill("Asha Rao");
    await page.getByTestId("register-email").fill(email);
    await page.getByTestId("register-username").fill(username);
    await expect(page.getByTestId("register-username-ok")).toContainText(
      `@${username} is available`,
    );
    await page.getByTestId("register-password").fill("short1");
    await expect(page.getByTestId("password-rules").first()).toContainText(
      "Weak",
    );
    await page.getByTestId("register-password").fill(PASSWORD);
    await expect(page.getByTestId("register-password")).toHaveAttribute(
      "autocomplete",
      "new-password",
    );
    await page.getByTestId("register-terms").check();
    await page.getByTestId("register-password").press("Enter");

    const verify = page.getByTestId("signin-verify");
    await expect(verify).toBeVisible();
    await expect(page.getByTestId("signin-verify-email")).toHaveText(email);
    await expect(page.getByTestId("signin-verify-resend")).toBeDisabled();
    expect(fb.calls).toEqual(
      expect.arrayContaining(["signUp", "update", "sendOobCode:VERIFY_EMAIL"]),
    );

    // Not verified yet: still blocked, with a clear message.
    await page.getByTestId("signin-verify-continue").click();
    await expect(page.getByTestId("signin-verify-error")).toContainText(
      "isn't verified yet",
    );
    await expect(page.getByTestId("you-signin")).toBeAttached();

    fb.verify(email);
    await page.getByTestId("signin-verify-continue").click();
    // The username typed at registration is claimed on the real Worker; no prompt.
    await expectSignedIn(page, "Asha Rao");
    await expect(page.getByTestId("you-handle")).toContainText(`@${username}`);
    await expect(page.getByTestId("you-handle")).toContainText(email);

    // Sign out, then back in with the username instead of the email.
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page.getByTestId("you-signin")).toBeVisible();
    await page.getByTestId("you-signin").click();
    await page.getByTestId("signin-identifier").fill(`@${username.toUpperCase()}`);
    await page.getByTestId("signin-password").fill(PASSWORD);
    await page.getByTestId("signin-submit").click();
    await expectSignedIn(page, "Asha Rao");
    expect(fb.leaks).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("an unverified email cannot sign in", async ({ page }) => {
    const { fb } = await setup(page);
    const email = freshEmail();
    fb.addUser({
      email,
      password: PASSWORD,
      emailVerified: false,
      displayName: "Unverified",
    });
    await openSignIn(page);
    await page.getByTestId("signin-identifier").fill(email);
    await page.getByTestId("signin-password").fill(PASSWORD);
    await page.getByTestId("signin-password").press("Enter");
    await expect(page.getByTestId("signin-verify")).toBeVisible();
    await expect(
      page.getByRole("dialog", { name: "Verify your email" }),
    ).toBeVisible();
    await expect(page.getByTestId("signin-verify-email")).toHaveText(email);

    // Resend works once (no cooldown on this path yet), then waits.
    await page.getByTestId("signin-verify-resend").click();
    await expect(page.getByTestId("signin-verify-info")).toContainText(
      "Sent again",
    );
    await expect(page.getByTestId("signin-verify-resend")).toContainText(
      /Resend email in \d:\d\d/,
    );
    await page.getByTestId("signin-verify-continue").click();
    await expect(page.getByTestId("signin-verify-error")).toContainText(
      "isn't verified yet",
    );

    await page.getByTestId("signin-back").click();
    await expect(page.getByTestId("signin-email-form")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("signin-sheet")).toBeHidden();
    await expect(page.getByTestId("you-signin")).toBeVisible();
  });

  test("signs in with email and password, and offers a username once", async ({
    page,
  }) => {
    const { fb, errors } = await setup(page);
    const email = freshEmail();
    fb.addUser({
      email,
      password: PASSWORD,
      emailVerified: true,
      displayName: "Ravi Kumar",
    });
    await openSignIn(page);
    await page.getByTestId("signin-identifier").fill(email.toUpperCase());
    await page.getByTestId("signin-password").fill(PASSWORD);
    await page.getByTestId("signin-password-toggle").click();
    await expect(page.getByTestId("signin-password")).toHaveAttribute(
      "type",
      "text",
    );
    await page.getByTestId("signin-submit").click();

    await expect(
      page.getByRole("dialog", { name: "Choose a username" }),
    ).toBeVisible();
    await page.getByTestId("claim-username").fill("ad");
    await expect(page.getByTestId("signin-username")).toContainText(
      /at least 3|3 to 20|too short/i,
    );
    await page.getByTestId("claim-skip").click();
    await expectSignedIn(page, "Ravi Kumar");
    await expect(page.getByTestId("you-handle")).toContainText(email);

    // Later, from the You screen.
    const username = freshUsername();
    await page.getByTestId("you-set-username").click();
    await page.getByTestId("claim-username").fill(username);
    await expect(page.getByTestId("claim-username-ok")).toBeVisible();
    await page.getByTestId("claim-username").press("Enter");
    await expect(page.getByTestId("signin-sheet")).toBeHidden();
    await expect(page.getByTestId("you-handle")).toContainText(`@${username}`);
    await expect(page.getByTestId("you-set-username")).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("a username typed in an abandoned registration is not given to another account", async ({
    page,
  }) => {
    const { fb, errors } = await setup(page);
    const other = freshEmail();
    fb.addUser({
      email: other,
      password: PASSWORD,
      emailVerified: true,
      displayName: "Meera Iyer",
    });
    await openSignIn(page);
    await page.getByTestId("signin-register").click();
    await page.getByTestId("register-name").fill("Asha Rao");
    await page.getByTestId("register-email").fill(freshEmail());
    await page.getByTestId("register-username").fill(freshUsername());
    await page.getByTestId("register-password").fill(PASSWORD);
    await page.getByTestId("register-terms").check();
    await page.getByTestId("register-submit").click();
    await expect(page.getByTestId("signin-verify")).toBeVisible();
    await page.getByTestId("signin-back").click();

    await page.getByTestId("signin-identifier").fill(other);
    await page.getByTestId("signin-password").fill(PASSWORD);
    await page.getByTestId("signin-submit").click();
    // Offered a username of its own, nothing claimed silently.
    await expect(page.getByTestId("signin-username")).toBeVisible();
    await expect(page.getByTestId("claim-username")).toHaveValue("");
    await page.getByTestId("claim-skip").click();
    await expectSignedIn(page, "Meera Iyer");
    await expect(page.getByTestId("you-set-username")).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("a wrong password gets the same message for email and username", async ({
    page,
  }) => {
    const { fb } = await setup(page);
    const email = freshEmail();
    fb.addUser({
      email,
      password: PASSWORD,
      emailVerified: true,
      username: "known_driver",
    });
    await openSignIn(page);
    // Empty: field errors, nothing sent.
    await page.getByTestId("signin-submit").click();
    await expect(page.getByTestId("signin-email-form")).toContainText(
      "Enter your email or username.",
    );
    await expect(page.getByTestId("signin-email-form")).toContainText(
      "Enter your password.",
    );

    for (const id of [
      email,
      "known_driver",
      "nobody@local.test",
      "no_such_user",
    ]) {
      await page.getByTestId("signin-identifier").fill(id);
      await page.getByTestId("signin-password").fill("wrong-pass-1");
      await page.getByTestId("signin-submit").click();
      await expect(page.getByTestId("signin-error")).toHaveText(BAD_LOGIN);
    }
    await expect(page.getByTestId("you-signin")).toBeAttached();
  });

  test("forgot password always answers the same way", async ({ page }) => {
    const { fb } = await setup(page);
    await openSignIn(page);
    await page.getByTestId("signin-identifier").fill("someone@local.test");
    await page.getByTestId("signin-forgot").click();
    await expect(
      page.getByRole("dialog", { name: "Reset password" }),
    ).toBeVisible();
    await expect(page.getByTestId("forgot-identifier")).toHaveValue(
      "someone@local.test",
    );
    await page.getByTestId("forgot-submit").click();
    await expect(page.getByTestId("signin-forgot-message")).toHaveText(FORGOT);
    expect(fb.calls).toContain("sendOobCode:PASSWORD_RESET");

    await page.getByTestId("signin-forgot-back").click();
    await page.getByTestId("signin-forgot").click();
    await page.getByTestId("forgot-identifier").fill("some_username");
    await page.getByTestId("forgot-identifier").press("Enter");
    await expect(page.getByTestId("signin-forgot-message")).toHaveText(FORGOT);
    expect(fb.calls).toContain("worker:forgot");
  });

  test("signs in with a phone number and a one-time code", async ({ page }) => {
    const { fb, errors } = await setup(page, { phone: true });
    // A fresh number each run so the dev account starts without a username.
    const digits = `9${String(Date.now()).slice(-9)}`;
    await openSignIn(page);
    await page.getByTestId("signin-tab-phone").click();
    await page.getByTestId("signin-phone-send").click();
    await expect(page.getByTestId("signin-phone")).toContainText(
      "Enter a valid mobile number",
    );

    await page.getByTestId("signin-phone-input").fill(digits);
    await page.getByTestId("signin-phone-input").press("Enter");
    await expect(page.getByTestId("signin-otp-sent")).toContainText(
      `+91 ${digits.slice(0, 5)} ${digits.slice(5)}`,
    );
    expect(fb.texts).toEqual([`+91${digits}`]);
    await expect(page.getByTestId("signin-otp-wait")).toContainText(
      /Resend code in 0:\d\d/,
    );
    await expect(page.getByTestId("signin-otp-input")).toHaveAttribute(
      "autocomplete",
      "one-time-code",
    );

    // Wrong code: a clear error, the boxes empty for another try.
    await page.getByTestId("signin-otp-input").fill("000000");
    await expect(page.getByTestId("signin-otp-error")).toContainText(
      "That code isn't right",
    );
    await expect(page.getByTestId("signin-otp-input")).toHaveValue("");
    await expect(page.getByTestId("you-signin")).toBeAttached();

    await page.getByTestId("signin-otp-input").fill(OTP);
    // Usernames are for password sign-in, so a phone account is not offered one.
    await expectSignedIn(page, `+91•••••••${digits.slice(-3)}`);
    await expect(page.getByTestId("signin-username")).toHaveCount(0);
    expect(fb.leaks).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("Google's button reads on the sheet and the text links are big enough to tap", async ({
    page,
  }) => {
    await setup(page);
    await openSignIn(page);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    // The white outline button in both themes ("filled_black" would vanish on the dark sheet).
    await expect(
      page.getByTestId("signin-google").locator("iframe"),
    ).toHaveAttribute("data-theme", "outline");
    // Measure once the sheet has finished its entrance: mid-animation its boxes are still transformed.
    await animationsSettled(page);
    for (const id of ["signin-forgot", "signin-register"]) {
      const box = (await page.getByTestId(id).boundingBox())!;
      expect(box.height, id).toBeGreaterThanOrEqual(24);
    }
  });

  test("a guest can close the sheet and keep using Basic", async ({ page }) => {
    const { errors } = await setup(page);
    await openSignIn(page);
    await page.getByRole("button", { name: "Close" }).click();
    await expect(page.getByTestId("signin-sheet")).toBeHidden();
    await expect(page.getByTestId("screen-you")).toContainText(
      "Using ChargeOne Basic",
    );
    await page.getByTestId("tab-explore").click();
    await expect(page.getByTestId("app-ready")).toBeAttached();
    expect(errors).toEqual([]);
  });

  test("fits a 360 px phone without sideways scrolling", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await setup(page);
    await openSignIn(page);
    const fits = async () =>
      page.evaluate(() => {
        const sheet = document.querySelector<HTMLElement>(".sheet__body")!;
        const out = [...sheet.querySelectorAll<HTMLElement>(".auth *")].filter(
          (el) => {
            const r = el.getBoundingClientRect();
            return (
              r.width > 0 &&
              (r.left < -0.5 || r.right > window.innerWidth + 0.5)
            );
          },
        );
        return {
          overflow: sheet.scrollWidth - sheet.clientWidth,
          outside: out.map((el) => el.className || el.tagName).slice(0, 5),
        };
      });
    expect(await fits()).toEqual({ overflow: 0, outside: [] });
    await page.getByTestId("signin-tab-phone").click();
    expect(await fits()).toEqual({ overflow: 0, outside: [] });
    await page.getByTestId("signin-tab-email").click();
    await page.getByTestId("signin-register").click();
    await page.getByTestId("register-password").fill("abc");
    expect(await fits()).toEqual({ overflow: 0, outside: [] });
  });
});
