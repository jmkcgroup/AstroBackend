import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { env } from "../../config/env.js";
import { paged, paginationSchema, toSkipTake, type Pagination } from "../../lib/pagination.js";
import { currentUser, requireAuth } from "../../middleware/auth.js";
import { checkoutLimiter } from "../../middleware/rate-limit.js";
import { validate } from "../../middleware/validate.js";
import * as payments from "../../payments/payments.service.js";
import { paymentsEnabled } from "../../payments/razorpay.js";
import * as subs from "../../payments/subscriptions.service.js";

const id = z.string().min(1).max(40);
const rzpId = z.string().regex(/^[A-Za-z0-9_]{6,40}$/);
const signature = z.string().regex(/^[a-f0-9]{64}$/);

export const paymentsRouter = Router();

// Public
paymentsRouter.get("/config", (_req, res) => {
  res.json({ enabled: paymentsEnabled(), keyId: env.RAZORPAY_KEY_ID ?? null });
});

paymentsRouter.get("/plans", async (_req, res) => {
  res.json({ items: await subs.listActivePlans() });
});

// Authenticated
paymentsRouter.get("/", requireAuth, validate({ query: paginationSchema }), async (req, res) => {
  const p = res.locals.query as Pagination;
  const { skip, take } = toSkipTake(p);
  const { items, total } = await payments.listMyPayments(currentUser(req).userId, skip, take);
  res.json(paged(items, total, p));
});

paymentsRouter.post(
  "/orders",
  requireAuth,
  checkoutLimiter,
  validate({
    body: z.discriminatedUnion("purpose", [
      z.object({ purpose: z.literal("REPORT"), productId: id }),
      z.object({ purpose: z.literal("CONSULTATION"), bookingId: id }),
    ]),
  }),
  async (req, res) => {
    const userId = currentUser(req).userId;
    const checkout =
      req.body.purpose === "REPORT" ? await payments.createReportOrder(userId, req.body.productId) : await payments.createBookingOrder(userId, req.body.bookingId);
    res.status(201).json({ checkout });
  },
);

paymentsRouter.post(
  "/verify",
  requireAuth,
  validate({ body: z.object({ razorpay_order_id: rzpId, razorpay_payment_id: rzpId, razorpay_signature: signature }) }),
  async (req, res) => {
    res.json({ order: await payments.verifyCheckout(currentUser(req).userId, req.body) });
  },
);

paymentsRouter.get("/subscription", requireAuth, async (req, res) => {
  res.json({ subscription: await subs.mySubscription(currentUser(req).userId) });
});

paymentsRouter.post("/subscription", requireAuth, checkoutLimiter, validate({ body: z.object({ planId: id }) }), async (req, res) => {
  res.status(201).json({ checkout: await subs.startSubscription(currentUser(req).userId, req.body.planId) });
});

paymentsRouter.post(
  "/subscription/verify",
  requireAuth,
  validate({ body: z.object({ razorpay_payment_id: rzpId, razorpay_subscription_id: rzpId, razorpay_signature: signature }) }),
  async (req, res) => {
    res.json({ subscription: await subs.verifySubscriptionCheckout(currentUser(req).userId, req.body) });
  },
);

paymentsRouter.post("/subscription/cancel", requireAuth, async (req, res) => {
  res.json({ subscription: await subs.cancelMySubscription(currentUser(req).userId) });
});

/** Razorpay webhook. Mounted with a raw body parser, before CSRF and auth (it carries its own signature). */
export const razorpayWebhook: RequestHandler = async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  await payments.handleWebhook(raw, req.get("x-razorpay-signature"), req.get("x-razorpay-event-id"));
  res.json({ ok: true });
};
