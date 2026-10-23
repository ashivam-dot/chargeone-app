// Screenshots of every sign-in state, dark and light, on a 360 px phone and a desktop, with Firebase
// and Google faked (nothing leaves the machine). Needs a development server (`wrangler dev`).
// Usage: node scripts/signin-shots.ts <out-dir> [--base http://localhost:8787]
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, devices, type Browser, type Page } from "@playwright/test";
import { FakeFirebase } from "../e2e/firebase-mock.ts";

const args = process.argv.slice(2);
const out = args.find((a) => !a.startsWith("--")) ?? "signin-shots";
const base = args.includes("--base")
  ? args[args.indexOf("--base") + 1]
  : "http://localhost:8787";
mkdirSync(out, { recursive: true });

const NEXON = {
  modelId: "tata-nexon-ev-45",
  name: "Tata Nexon EV 45",
  batteryKwh: 45,
  realRangeKm: null,
  maxDcKw: 60,
  maxAcKw: 7.2,
  massKg: 1500,
  dcConnector: "CCS2",
};
const SIZES = {
  phone360: { ...devices["Galaxy S9+"], viewport: { width: 360, height: 740 } },
  desktop: {
    ...devices["Desktop Chrome"],
    viewport: { width: 1366, height: 900 },
  },
};

const browser: Browser = await chromium.launch({ args: ["--mute-audio"] });
const errors: string[] = [];

async function session(
  size: keyof typeof SIZES,
  dark: boolean,
): Promise<{
  page: Page;
  fb: FakeFirebase;
  shot: (name: string) => Promise<void>;
}> {
  const ctx = await browser.newContext({
    ...SIZES[size],
    colorScheme: dark ? "dark" : "light",
    locale: "en-IN",
    timezoneId: "Asia/Kolkata",
  });
  await ctx.addInitScript(
    ([vehicle, d]) => {
      if ("speechSynthesis" in window) window.speechSynthesis.speak = () => {};
      Object.assign(window, { __CHARGEONE_E2E_PHONE__: true });
      localStorage.setItem("chargeone:welcomed", "true");
      localStorage.setItem("chargeone:vehicle", JSON.stringify(vehicle));
      localStorage.setItem("chargeone:theme", JSON.stringify(d ? "dark" : "light"));
    },
    [NEXON, dark] as const,
  );
  const page = await ctx.newPage();
  page.on("pageerror", (e) =>
    errors.push(`${size} ${dark ? "dark" : "light"}: ${e.message}`),
  );
  const fb = new FakeFirebase(page);
  await fb.install();
  await page.goto(base);
  await page
    .getByTestId("app-ready")
    .waitFor({ state: "attached", timeout: 90_000 });
  await page.getByTestId("tab-you").click();
  await page.getByTestId("you-signin").click();
  await page.getByTestId("signin-sheet").waitFor();
  const tag = `${size}-${dark ? "dark" : "light"}`;
  const shot = async (name: string) => {
    await page.waitForTimeout(700);
    await page.screenshot({ path: join(out, `${tag}-${name}.png`) });
    console.log("saved", `${tag}-${name}`);
  };
  return { page, fb, shot };
}

for (const size of ["phone360", "desktop"] as const) {
  for (const dark of [true, false]) {
    const { page, fb, shot } = await session(size, dark);

    const dump = async () =>
      console.log(
        "SHEET:",
        await page
          .getByTestId("signin-sheet")
          .innerText()
          .catch(() => "no sheet"),
      );
    try {
      const email = `shots.${Date.now().toString(36)}@local.test`;
      fb.addUser({
        email,
        password: "charge4ward",
        emailVerified: true,
        displayName: "Asha Rao",
      });

      await shot("01-signin");
      await page.getByTestId("signin-identifier").fill(email);
      await page.getByTestId("signin-password").fill("wrong-pass-1");
      await page.getByTestId("signin-submit").click();
      await page.getByTestId("signin-error").waitFor();
      await shot("02-wrong-password");

      await page.getByTestId("signin-tab-phone").click();
      await page.getByTestId("signin-phone-input").fill("98765 43210");
      await shot("03-phone");
      await page.getByTestId("signin-phone-send").click();
      await page.getByTestId("signin-otp-sent").waitFor();
      await page.getByTestId("signin-otp-input").fill("123");
      await shot("04-phone-code");
      await page.getByTestId("signin-otp-input").fill("123450");
      await page.getByTestId("signin-otp-error").waitFor();
      await shot("05-phone-wrong-code");

      await page.getByTestId("signin-tab-email").click();
      await page.getByTestId("signin-register").click();
      await page.getByTestId("register-name").fill("Asha Rao");
      await page.getByTestId("register-email").fill(`new.${email}`);
      await page
        .getByTestId("register-username")
        .fill(`asha_${Date.now().toString(36).slice(-6)}`);
      await page.getByTestId("register-password").fill("charge4");
      await page.waitForTimeout(900);
      await shot("06-register");
      await page.getByTestId("register-submit").click();
      await shot("07-register-errors");
      await page.getByTestId("register-password").fill("charge4ward!2026");
      await page.getByTestId("register-terms").check();
      await page.getByTestId("register-submit").click();
      await page.getByTestId("signin-verify").waitFor();
      await shot("08-verify");
      await page.getByTestId("signin-verify-continue").click();
      await page.getByTestId("signin-verify-error").waitFor();
      await shot("09-verify-not-yet");

      await page.getByTestId("signin-back").click();
      await page.getByTestId("signin-forgot").click();
      await shot("10-forgot");
      await page.getByTestId("forgot-submit").click();
      await page.getByTestId("signin-forgot-message").waitFor();
      await shot("11-forgot-sent");

      await page.getByTestId("signin-forgot-back").click();
      await page.getByTestId("signin-identifier").fill(email);
      await page.getByTestId("signin-password").fill("charge4ward");
      await page.getByTestId("signin-submit").click();
      await page
        .getByTestId("signin-username")
        .waitFor({ timeout: 8000 })
        .catch(async (e: unknown) => {
          await page.screenshot({ path: join(out, "debug-failure.png") });
          console.log(
            await page
              .getByTestId("signin-sheet")
              .innerText()
              .catch(() => "no sheet"),
          );
          throw e;
        });
      await page
        .getByTestId("claim-username")
        .fill(`asha${Date.now().toString(36).slice(-5)}`);
      await page.getByTestId("claim-username-ok").waitFor();
      await shot("12-username");
    } catch (e) {
      await dump();
      throw e;
    }
    await page.context().close();
  }
}

await browser.close();
if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
