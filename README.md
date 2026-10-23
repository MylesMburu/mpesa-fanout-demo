# Async by Design — RenderCon Kenya demo

A full-stack Next.js app that demonstrates the architecture from the talk:
a React app initiates an M-Pesa payment, Safaricom's Daraja API confirms it
asynchronously via webhook, that webhook fans out through AWS SNS to two
independent subscribers, and the frontend never sees any of that — it just
polls a clean BFF endpoint.

```
Browser -> POST /api/mpesa/stk-push
              |  insert PENDING row first (client idempotency key)
              v
           Daraja (STK Push), then store CheckoutRequestID
              |
              |  (seconds later, out of band)
              v
        Daraja -> POST /api/mpesa/callback/[secret]
                     |  update PENDING or TIMED_OUT only;
                     |  store the callback if the row has no id yet
                     v
              publish -> SNS topic
                     |         |
             /api/sns/notify   /api/sns/audit     <- independent subscribers
                     |         |
                     v         v
        Browser polls GET /api/payments/[id]/status  <- the BFF layer
           stops on paid | failed | timed_out
           (notify/audit may still light up; they do not gate the result)

        Still pending after 60s -> POST /api/payments/[id]/reconcile
           one STK Push Query, then timed_out if Safaricom has no result
```

## Before you touch any code

This needs **two real, publicly-reachable HTTPS endpoints** (Daraja's
callback and SNS's HTTPS subscription) — `localhost` cannot receive either.
Deploy to Vercel first, then configure the integrations against the real
URL. Trying to wire up Daraja/SNS against a local dev server is the single
most common source of "why isn't this working" — don't skip straight to
step 3.

## Setup

1. **Database.** Create a free Postgres on [Neon](https://neon.tech),
   copy the connection string into `DATABASE_URL` in `.env`. The Prisma
   CLI reads it from `prisma.config.ts`. The app connects with the `pg`
   driver adapter in `lib/prisma.ts` (Prisma 7 requires that).

2. **Deploy the shell first.** Push this repo to GitHub, import it on
   [Vercel](https://vercel.com/new), set `DATABASE_URL`, and deploy. Note
   the resulting URL — that's your `PUBLIC_BASE_URL`. Add it as an env var
   and redeploy (or set it before the first deploy if you already know your
   Vercel project's domain).

3. **Run the schema against your DB** (from your machine, not the sandbox
   this was built in — see note below):
   ```
   npx prisma db push
   ```
   If you already pushed an earlier copy of this schema, run it again.
   The current schema adds `idempotencyKey`, nullable Daraja ids,
   `TIMED_OUT`, and an `UnmatchedCallback` table.

4. **Daraja sandbox.** Register at
   [developer.safaricom.co.ke](https://developer.safaricom.co.ke), create
   an app, enable "Lipa Na M-Pesa Sandbox". Grab your Consumer Key/Secret
   from the app and the Passkey from the
   [Test Credentials](https://developer.safaricom.co.ke/test_credentials)
   page. Set `DARAJA_CONSUMER_KEY`, `DARAJA_CONSUMER_SECRET`,
   `DARAJA_PASSKEY`. Generate `MPESA_CALLBACK_SECRET` with
   `openssl rand -hex 24`.

5. **AWS SNS.** With the AWS CLI configured locally:
   ```
   PUBLIC_BASE_URL=https://your-app.vercel.app ./scripts/setup-sns.sh
   ```
   This creates the topic and subscribes both `/api/sns/notify` and
   `/api/sns/audit` over HTTPS — the app auto-confirms each subscription
   (see `lib/snsSubscriber.ts`), so there's no console click-through. Copy
   the printed ARN into `SNS_PAYMENT_TOPIC_ARN`, add `AWS_ACCESS_KEY_ID` /
   `AWS_SECRET_ACCESS_KEY` for a user with `sns:Publish` on that topic, and
   redeploy.

6. **Test end-to-end** with a Safaricom sandbox test phone number
   (`254708374149` is Safaricom's standard sandbox test MSISDN — it
   auto-completes without a real handset).

### A note on this repo as delivered

Everything here was written and type-checked (`eslint` and `next build`'s
TypeScript pass are both clean), but `npx prisma generate` couldn't run in
the sandbox this was built in — its build environment only allows npm's
registry, not Prisma's engine-binary CDN. That's a property of the build
sandbox, not your machine: run `npm install` normally and it'll generate
the client via the `postinstall` script exactly like it will on Vercel.
The one thing I could **not** verify directly is that the Prisma-dependent
routes compile against the real generated client — I checked every field
name in `app/api/**` against `prisma/schema.prisma` by hand and they line
up, but a first `npm install && npx prisma generate` locally is worth
doing before you assume it's airtight.

## Project layout

- `lib/daraja.ts` — OAuth, STK push, STK Push Query, callback payload parsing
- `lib/sns.ts` — publish helper
- `lib/resolvePayment.ts` — apply a result at most once; store callbacks that beat the row
- `lib/verifySnsMessage.ts`, `lib/snsSubscriber.ts` — inbound SNS signature
  verification + subscription-confirmation handshake
- `app/api/mpesa/stk-push` — step 1: pending row first, then the only synchronous call
- `app/api/mpesa/callback/[secret]` — step 2, idempotency + fan-out publish
- `app/api/sns/notify`, `app/api/sns/audit` — the two independent
  subscribers
- `app/api/payments/[id]/status` — the BFF endpoint the frontend polls
- `app/api/payments/[id]/reconcile` — one STK Push Query when the wait times out
- `components/PaymentDemo.tsx` — state machine (`idle` through `timed_out`) and the live step trace
