<<<<<<< HEAD
# AstroVeda API (backend)

Express 5 + TypeScript + Prisma 7, with a Swiss Ephemeris astrology engine.
**SQLite locally** (a single file, nothing to install) and **PostgreSQL in production**.
The Next.js frontend lives in `../astroveda` and proxies `/api/*` to this server.

## Setup (local, SQLite)

```bash
npm install                   # also generates the Prisma client
cp .env.example .env          # DATABASE_URL="file:./dev.db"; fill JWT_ACCESS_SECRET / JWT_REFRESH_SECRET (48+ random chars)
npm run db:setup              # creates dev.db, applies migrations, seeds catalogue/FAQs/settings
npm run dev                   # API on http://localhost:4000
```

Create an admin: set `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD` in `.env` and run `npm run db:seed` again.
Browse the data with `npm run db:studio`.

| Script | Purpose |
|---|---|
| `npm run dev` | API with reload |
| `npm test` | 102 unit + integration tests (creates a throwaway `test.db`; set `TEST_DATABASE_URL` to test on PostgreSQL) |
| `npm run typecheck` | TypeScript |
| `npm run db:generate` / `db:migrate` / `db:seed` / `db:setup` | Prisma client, migrations, seed data |
| `npm run build && npm start` | production |

## Database: SQLite locally, PostgreSQL in production

`DATABASE_URL` decides everything (`prisma.config.ts`, `src/lib/prisma.ts`):

| | Local | Production |
|---|---|---|
| `DATABASE_URL` | `file:./dev.db` | `postgresql://user:pass@host:5432/astroveda?schema=public` |
| Schema | `prisma/sqlite/schema.prisma` (generated from `prisma/schema.prisma`, do not edit) | `prisma/schema.prisma` (source of truth) |
| Migrations | `prisma/sqlite/migrations` | `prisma/migrations` |

The code uses only features both databases share (list values are JSON columns, case-insensitive search via `containsText`,
row locks via `lockRow`). Partial unique indexes (no double booking, one primary profile, one live membership) exist in both
migration sets; PostgreSQL CHECK constraints are triggers on SQLite. **Deploying:** set the PostgreSQL `DATABASE_URL`, then run
`npm run db:generate && npm run db:migrate && npm run db:seed` and `npm run build && npm start`. When you change the schema,
add a migration to *both* folders (`npx prisma migrate diff`). Optional local PostgreSQL for checking: `npm run pg:local`.

## Astrology engine (`src/astrology`)

- Swiss Ephemeris 2.10 via `sweph`, data files in `./ephe` (1800–2399 CE). Missing files → HTTP 503, never a silent Moshier fallback.
- Sidereal zodiac, Lahiri default (Raman, KP selectable), whole-sign houses, true node, D9 Navamsha, Vimshottari dasha (365.25-day year).
- IANA time zones with historical offsets; DST gaps/folds are flagged.
- Tested against Makar Sankranti 2024, the 8 Apr 2024 eclipse, Guru Purnima 2024 tithi end and Delhi sunrise.
- Licensing: Swiss Ephemeris is AGPL-3.0 or commercial. **Obtain a commercial licence from Astrodienst before a closed-source commercial launch.**

## API overview (all under `/api`)

| Area | Endpoints |
|---|---|
| Health | `GET /health` |
| Auth | `POST /auth/register`, `/auth/login`, `/auth/logout`, `/auth/refresh`, `/auth/verify-email`, `/auth/resend-verification`, `/auth/forgot-password`, `/auth/reset-password`, `/auth/change-password`; `GET /auth/me`, `/auth/providers`, `/auth/google`, `/auth/google/callback` |
| Account | `GET/PATCH /users/me`, `GET /users/me/dashboard`, `/users/me/notifications` (+ `/:id/read`, `/read-all`), `/users/me/sessions` (+ `DELETE /:id`), `GET /users/me/export`, `POST/DELETE /users/me/deletion-request` |
| Birth profiles | `GET/POST /birth-profiles`, `GET/PUT/DELETE /birth-profiles/:id`, `POST /birth-profiles/:id/primary` |
| Charts | `GET /charts`, `POST /charts/calculate`, `GET /charts/:id`, `/:id/planets`, `/:id/houses`, `/:id/dashas`, `/:id/divisional/:D1\|D9`, `/:id/transits`, `/:id/interpretations?lang=EN\|HI`, `POST /:id/save` |
| Free tools | `POST /tools/kundli`, `/tools/matching`, `/tools/numerology`, `/tools/nakshatra`, `/tools/rashi`; `GET /tools/panchang`, `/tools/transits`, `/tools/sky`, `/tools/sky/events` (sign changes and stations, next 45 days), `/tools/geocode`, `/tools/timezone` |
| Content | `GET /content/horoscopes`, `/content/faqs`, `/content/banners`, `/content/articles`, `/content/articles/:slug`, `/content/seo` |
| Contact | `POST /contact`, `POST /newsletter` |
| Reports | `GET /reports/catalogue`, `/catalogue/:slug`, `/catalogue/:slug/sample`; `GET/POST /reports`, `GET /reports/entitlements`, `/reports/:id`, `/reports/:id/download` |
| Consultations | `GET /astrologers`, `/astrologers/specializations`, `/astrologers/:slug`, `/astrologers/:slug/slots`; `GET/POST /bookings`, `GET /bookings/:id`, `POST /bookings/:id/cancel`, `/reschedule`, `/review` |
| Astrologer desk | `GET /astrologer/bookings`, `PATCH /astrologer/bookings/:id`, `GET/POST /astrologer/slots` |
| Admin (ADMIN role) | `GET /admin/metrics`; users (`GET/PATCH/DELETE /admin/users[/:id]`); astrologers (`GET/POST/PUT /admin/astrologers`, `POST /:id/status`, `POST /:id/slots`, `DELETE /admin/slots/:id`); reports (`/admin/report-products`, `/admin/reports`, `POST /admin/reports/:id/retry`, `/admin/grants`, `POST /admin/grants/:id/revoke`); `/admin/bookings`; content (`/admin/horoscopes`, `/admin/faqs`, `/admin/banners`, `/admin/articles`, `/admin/seo`); `/admin/contacts`; `/admin/audit-logs` |

Errors use `{ "error": { "code", "message", "details?" } }` with 400/401/403/404/409/429/503.

## Security

bcrypt (cost 12) · access JWT 15 min + rotating refresh token (reuse revokes all sessions) in httpOnly SameSite=Lax cookies ·
Origin check on state-changing requests · helmet headers · rate limits · Zod validation on every input · ownership checks on all
private data · partial unique index preventing double booking · audit log for admin and account actions · birth data redacted from logs.

## External services

| Service | Needed for | Without it |
|---|---|---|
| Database (SQLite file locally, PostgreSQL in production) | everything | API reports `database: down` |
| SMTP (`SMTP_*`) | verification, reset, notification emails | emails are written to the server log |
| Google OAuth (`GOOGLE_*`) | "Continue with Google" | button hidden |
| OpenStreetMap Nominatim | birthplace search | users enter coordinates manually |
| Razorpay (`RAZORPAY_*`) | report purchases, paid consultations, memberships, refunds | checkout returns 503; report access via admin grants |

## Payments (Razorpay)

- **Flow:** the server creates the order (amount from the database, never the client) → Razorpay Checkout in the browser → `POST /payments/verify` checks the HMAC signature *and* fetches the payment from Razorpay (amount, currency, order id, captured) → access is granted. The webhook (`POST /api/payments/webhook/razorpay`, raw body, own signature) fulfils the same order if the browser closes; fulfilment is idempotent.
- **Reports:** a paid order creates a single-use grant. **Memberships:** each active billing period grants the plan's credits once (valid for any report until the period ends).
- **Consultations:** a booking for a paid astrologer must be paid within `consultation.unpaidHoldMinutes` (default 30) or the slot is released; it can be confirmed only after payment. Declined/cancelled by the astrologer or admin → automatic full refund; user cancellation ≥ `consultation.refundCutoffHours` (24) before start → full refund. Completion records the commission split (`consultation.defaultCommissionBps`, default 20%) in `AstrologerEarning`.
- **Setup:** put Test Mode keys in `.env` (`RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`). In the Razorpay dashboard add a webhook to `https://<api-domain>/api/payments/webhook/razorpay` with a secret (`RAZORPAY_WEBHOOK_SECRET`) and events `payment.captured`, `payment.failed`, `order.paid`, `refund.processed`, `refund.failed`, `subscription.*`. Enable Subscriptions on the account before creating plans in Admin → Memberships.
- Endpoints: `GET /payments/config`, `/payments/plans`, `/payments` (history), `POST /payments/orders`, `/payments/verify`, `GET/POST /payments/subscription`, `POST /payments/subscription/verify`, `/payments/subscription/cancel`; admin `GET /admin/payments`, `POST /admin/payments/:id/refund`, `/admin/earnings` (+ `/:id/payout`), `/admin/plans`, `/admin/subscriptions`, `/admin/settings`, `/admin/webhooks`.
- Tests use an in-memory gateway (`tests/fake-gateway.ts`) with real signature verification; no network calls.
=======
# AstroBackend
>>>>>>> df13eb02e3211606cbc7d97e996f38e946550335
