# ChargeOne

India's EV road-trip app: chargers with live driver-reported status, food and hotels around each charger, and a
range-anxiety-free planner for one-day or multi-day trips. Installable web app (PWA) on Cloudflare's free tier, with
plans paid through Razorpay.

- **Map:** every public charger in the open data, coloured by live status (working, busy, problem, no recent report). DC fast chargers get bigger pins. Filters for DC, CCS2/Type 2/Bharat DC, 24×7 and operator.
- **Live status:** drivers tap "Charged fine", "Charging now", "Not working" and so on at the charger. A report only counts when the phone is within 500 m of the charger. Each charger shows when it last worked, at what speed and on which car.
- **Trip planner:** real road route with elevation. Energy model per car (23 Indian EVs, or the driver's real range). Picks stops in the order fastest-and-verified, then DC, then AC. Charges only as much as needed. Each stop gets two backup chargers and a confidence level, and the planner says plainly when a trip isn't safe. It also suggests leaving with a full battery when that removes a stop, alerts you mid-trip when a planned stop gets a problem report, re-plans for free from where you are, and opens Google Maps navigation with the stops as waypoints.
- **Food while you charge:** every charger lists restaurants, cafés and dhabas within an 800 m walk, with cuisine, pure-veg badges, hours, call and directions. Food and Stays chips put them on the map too.
- **Stays with charging:** hotels, guest houses and resorts within 3 km of each charger, with the ones that have a charger on site first. "Check prices" opens a Booking.com search for that hotel. Each place has its own sheet listing the chargers within walking distance.
- **Multi-day trips:** set how long you want to drive per day. The planner ends each day at a charger with hotels nearby (an on-site charger first), charges you to 100% overnight, and shows the stays, dinner options and a separate Google Maps link for each day. It also suggests stays with charging at your destination.
- **Search-friendly pages:** every charger and city gets a static page with its connectors, nearby food and stays, structured data (schema.org), a sitemap and robots.txt, built from the same data at deploy time.
- **Plans:**

  | Plan | Price | What you get |
  |---|---|---|
  | Free | ₹0 | Map, live status, trips up to 100 km (3 a day) |
  | Trip Pass | ₹49 | 10 long trips within 7 days |
  | Plus | ₹149 a month | 30 long trips per rolling 30 days, live re-planning |
  | Plus Yearly | ₹999 a year | Same as Plus |

## Launch checklist (₹0 to start)

Create every account with your **personal Gmail**, never a work account.

1. **Fill in the legal pages.** In `public/privacy.html`, `terms.html`, `refund.html` and `contact.html`, replace `{{OWNER_NAME}}`, `{{CITY}}` and `{{SUPPORT_EMAIL}}`. Razorpay checks these pages before it activates your account.
2. **Cloudflare (free).** Sign up at dash.cloudflare.com, then:
   ```sh
   npx wrangler login
   npx wrangler d1 create chargeone   # paste the printed database_id into wrangler.jsonc
   ```
3. **Session secret.** Set it without ever seeing it:
   ```sh
   openssl rand -base64 48 | npx wrangler secret put SESSION_SECRET
   ```
4. **Google sign-in (free).**
   - In console.cloud.google.com, go to APIs & Services → OAuth consent screen and choose External.
   - Under Credentials, create an OAuth client ID of type Web application.
   - Add your site URL (for example `https://chargeone.<you>.workers.dev`) under Authorized JavaScript origins.
   - Put the client ID in `wrangler.jsonc` → `vars.GOOGLE_CLIENT_ID`. It's public, not a secret.
5. **Routing (free).** Get an API key at openrouteservice.org. The free plan allows 2,000 routes a day.
   ```sh
   npx wrangler secret put ORS_API_KEY
   ```
6. **Deploy.** `SITE_URL` is your public https address; canonical links and the sitemap use it.
   ```sh
   SITE_URL=https://chargeone.<you>.workers.dev npm run deploy
   ```
   The app is now live with the free plan. Paid buttons answer "Payments are not set up yet" until step 7.
   Submit `https://<your site>/sitemap.xml` in Google Search Console (free) so the charger and city pages get indexed.
7. **Razorpay (₹0 setup, about 2% per payment).**
   - Sign up with your PAN and bank account. Use the live site URL as your website.
   - Enable **Subscriptions**. Create two plans: ₹149 monthly and ₹999 yearly. Put their IDs in `vars.RAZORPAY_PLAN_MONTHLY` and `vars.RAZORPAY_PLAN_YEARLY`.
   - Put the API Key ID in `vars.RAZORPAY_KEY_ID`, then store the key secret:
     ```sh
     npx wrangler secret put RAZORPAY_KEY_SECRET
     ```
   - Add a webhook pointing to `https://<your site>/api/billing/razorpay/webhook`. Select the events `order.paid`, `payment.captured`, `subscription.activated`, `subscription.charged`, `subscription.resumed`, `subscription.cancelled`, `subscription.halted`, `subscription.completed` and `refund.processed`. Refunds you issue from the Razorpay dashboard then end the plan they paid for. Payments the app couldn't honour (for example a Trip Pass paid after upgrading to Plus) are marked `refund_due` in the `checkouts` table; refund those from the dashboard. Choose a webhook secret, then:
     ```sh
     npx wrangler secret put RAZORPAY_WEBHOOK_SECRET
     ```
   - Test with Razorpay **test mode** keys first, then switch to live keys and run `npm run deploy` again.
8. **More chargers (optional, free).** Get an Open Charge Map API key, then refresh the data monthly:
   ```sh
   OCM_API_KEY=... npm run import:data && npm run import:places && SITE_URL=... npm run deploy
   ```
   `import:places` asks the public Overpass API (OpenStreetMap) once for food and stays around every charger and
   writes `public/data/places.json`. Run it after each charger import; users never call Overpass themselves.
9. **Hotel commission (optional, free).** Join the Booking.com Affiliate Partner Programme with your personal Gmail.
   Build with your numeric affiliate ID and every "Check prices" link earns you a commission on bookings:
   ```sh
   VITE_BOOKING_AID=1234567 SITE_URL=... npm run deploy
   ```

Later, from earnings: Google Play ($25 once) and Apple App Store ($99 a year). Both stores require their own in-app billing for digital subscriptions sold inside the app. Plans bought on the website keep working in the store apps.

## Develop

```sh
npm install
npm run setup:dev      # creates .dev.vars (development mode, random local secret) and the local database
npm run build
npm run dev:api        # app + API on http://127.0.0.1:8787 with a test sign-in and free test plans
```

For front-end work with hot reload, run `npm run dev` alongside `npm run dev:api`; the dev server sends `/api` to port 8787. Development mode routes with the public OSRM demo server when there's no ORS key. Production never uses it.

## Tests

| Command | What it checks |
|---|---|
| `npm test` | 88 unit and integration tests: data import, filters, plans and quotas, the trip planner, sessions, Google token verification, Razorpay signatures, and the full payment flows on a real SQL database |
| `npm run smoke:api` | 28 checks against the running local server: sign-in, cross-site blocking, geofenced check-ins, live status, the 100 km free limit, quotas, re-plans, and account deletion |
| `npm run smoke:ui` | Headless phone-sized browser: map, deep link, sign-in, check-in, car choice, paywall, paid trip with stops, dark mode. Screenshots go to `screenshots/` |
| `npm run typecheck` | Strict TypeScript for the app and the Worker |

## Security

- Sign-in uses Google ID tokens verified on the server (signature against Google's keys, issuer, audience, expiry, verified email). Sessions are signed, HttpOnly, SameSite cookies that can be revoked on every device.
- Every state-changing request must come from the app's own origin and be JSON, which blocks cross-site request forgery. Inputs are size-limited and validated. All SQL uses bound parameters.
- Plans activate only after the Razorpay signature is checked and the payment or subscription is confirmed with Razorpay's API, and only for the user who started the checkout. Recording a payment and granting its plan is one database transaction, so each payment counts once even if the app and the webhook arrive together. A webhook is marked processed only after it succeeds, so failures are retried. Late or repeated events never shorten access or reopen a cancelled subscription. A user has at most one open subscription; extras are cancelled. A stale Trip Pass payment can never downgrade Plus. Deleting an account cancels its subscriptions immediately, and still completes if Razorpay is unreachable (the subscription is flagged `cancel_failed` to cancel by hand).
- Quotas are enforced on the server, in the same statement that records the trip, so parallel requests can't exceed them. A free re-plan must be the same journey (same destination, not longer). Check-ins are geofenced, rate-limited per user and per network, de-duplicated, and an account can file at most 5 problem reports a day. Rate-limit rows store a hash of the IP, never the address.
- A strict Content Security Policy, HSTS and `frame-ancestors 'none'` are set in `public/_headers`. Secrets live only in Wrangler secrets and the gitignored `.dev.vars`.
- Privacy: no coordinates are stored with reports, trip destinations are rounded to about 1 km, and car and trip settings stay on the device.

## Honest limits

- **Live status is community-reported.** Charging companies don't share live data with independent apps yet; that needs partnerships or the UBC/OCPI roaming networks. Until then, status is only as fresh as the last driver report.
- **Food and hotel data is OpenStreetMap's.** It's good in cities (most chargers have food and stays nearby) and patchy on highways, so some overnight stops show no hotel. Ratings, photos and room prices aren't shown in the app because no free source allows it; "Check prices" hands over to Booking.com. Places that are tagged as hotels but are really eateries or student hostels are filtered out by name.
- **The open data is thin.** It covers about 500 of India's 25,000+ public chargers, and many lack connector details. The app says so, labels unverified connectors, and links every charger to OpenStreetMap so drivers can fix or add them. Adding the Open Charge Map key and operator lists (with permission) is the biggest quality win.
