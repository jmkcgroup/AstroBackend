// One-time payments (reports and consultations), refunds and Razorpay webhooks.
// Rules: the amount always comes from our database, access is granted only after a verified
// signature or a verified webhook, and fulfilment is idempotent (both paths may arrive).
import type { PaymentOrder } from "../generated/prisma/client.js";
import { audit } from "../lib/audit.js";
import { sha256 } from "../lib/crypto.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { lockRow } from "../lib/db-lock.js";
import { prisma } from "../lib/prisma.js";
import { getNumberSetting } from "../lib/settings.js";
import { ACTIVE_STATUSES } from "../modules/consultations/booking-status.js";
import { notify } from "../modules/notifications/notifications.service.js";
import { env } from "../config/env.js";
import { gateway, verifyPaymentSignature, verifyWebhookSignature, type RemotePayment } from "./razorpay.js";
import { handleSubscriptionEvent } from "./subscriptions.service.js";

const isUniqueViolation = (err: unknown) => (err as { code?: string }).code === "P2002";
const rupees = (minor: number) => `₹${(minor / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

// ── Checkout ──────────────────────────────────────────────────

export type CheckoutPayload = {
  orderId: string;
  razorpayOrderId: string;
  amountMinor: number;
  currency: string;
  keyId: string;
  description: string;
  prefill: { name: string; email: string };
};

async function openRazorpayOrder(order: PaymentOrder, description: string): Promise<CheckoutPayload> {
  let razorpayOrderId = order.razorpayOrderId;
  if (!razorpayOrderId) {
    try {
      const remote = await gateway().createOrder({
        amount: order.amountMinor,
        currency: order.currency,
        receipt: order.receipt,
        notes: { orderId: order.id, purpose: order.purpose },
      });
      razorpayOrderId = remote.id;
      await prisma.paymentOrder.update({ where: { id: order.id }, data: { razorpayOrderId } });
    } catch (err) {
      await prisma.paymentOrder.update({ where: { id: order.id }, data: { status: "FAILED" } });
      throw err;
    }
  }
  const user = await prisma.user.findUniqueOrThrow({ where: { id: order.userId }, select: { name: true, email: true } });
  return {
    orderId: order.id,
    razorpayOrderId,
    amountMinor: order.amountMinor,
    currency: order.currency,
    keyId: env.RAZORPAY_KEY_ID ?? "",
    description,
    prefill: user,
  };
}

export async function createReportOrder(userId: string, productId: string) {
  const product = await prisma.reportProduct.findFirst({ where: { id: productId, isActive: true } });
  if (!product) throw notFound("Report not found");
  if (!product.indicativePriceMinor) throw conflict("This report is not sold online");
  gateway(); // fail fast when payments are not configured

  const order = await prisma.paymentOrder.create({
    data: {
      userId,
      purpose: "REPORT",
      amountMinor: product.indicativePriceMinor,
      currency: product.currency,
      reportProductId: product.id,
      receipt: `rpt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
    },
  });
  return openRazorpayOrder(order, product.title);
}

export async function createBookingOrder(userId: string, bookingId: string) {
  const booking = await prisma.booking.findFirst({ where: { id: bookingId, userId }, include: { astrologer: true, paymentOrder: true } });
  if (!booking) throw notFound("Booking not found");
  if (!["PENDING", "RESCHEDULE_REQUESTED"].includes(booking.status)) throw conflict("This booking can no longer be paid for");
  const fee = booking.astrologer.feeMinor ?? 0;
  if (fee <= 0) throw conflict("This consultation does not need a payment");
  gateway();

  const description = `Consultation with ${booking.astrologer.displayName}`;
  const existing = booking.paymentOrder;
  if (existing?.status === "PAID") throw conflict("This consultation is already paid");
  // A Razorpay order accepts repeated attempts until one succeeds, so the first order is reused
  // (an order is never replaced: a checkout still open on it must find it when it completes).
  if (existing) return openRazorpayOrder(existing.status === "FAILED" ? await prisma.paymentOrder.update({ where: { id: existing.id }, data: { status: "CREATED" } }) : existing, description);

  const order = await prisma.paymentOrder.create({
    data: {
      userId,
      purpose: "CONSULTATION",
      bookingId,
      amountMinor: fee,
      currency: booking.astrologer.currency,
      receipt: `bkg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
    },
  });
  return openRazorpayOrder(order, description);
}

/** Called by the browser after Razorpay Checkout succeeds. */
export async function verifyCheckout(userId: string, input: { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string }) {
  const order = await prisma.paymentOrder.findFirst({ where: { razorpayOrderId: input.razorpay_order_id, userId } });
  if (!order) throw notFound("Order not found");
  if (!verifyPaymentSignature(input.razorpay_order_id, input.razorpay_payment_id, input.razorpay_signature)) {
    logger.warn({ orderId: order.id }, "Rejected checkout with an invalid signature");
    throw badRequest("Payment verification failed");
  }
  // The signature proves the ids; the API tells us the real amount and state.
  const remote = await gateway().fetchPayment(input.razorpay_payment_id);
  await fulfilOrder(order, remote);
  return prisma.paymentOrder.findUniqueOrThrow({ where: { id: order.id }, select: { id: true, status: true, purpose: true, reportProductId: true, bookingId: true } });
}

// ── Fulfilment ────────────────────────────────────────────────

async function fulfilOrder(order: PaymentOrder, remote: RemotePayment) {
  if (remote.order_id !== order.razorpayOrderId) throw badRequest("This payment does not belong to the order");
  if (remote.amount !== order.amountMinor || remote.currency !== order.currency) throw badRequest("Payment amount does not match the order");

  let payment = remote;
  // Accounts without automatic capture leave payments authorized; capture the exact order amount.
  if (payment.status === "authorized") payment = await gateway().capturePayment(payment.id, order.amountMinor, order.currency);
  if (payment.status === "failed") {
    await recordFailedPayment(order, payment);
    throw conflict(payment.error_description ?? "The payment failed");
  }
  if (payment.status !== "captured") throw conflict("The payment has not completed yet");

  const outcome = await prisma.$transaction(async (tx) => {
    const existing = await tx.payment.findUnique({ where: { razorpayPaymentId: payment.id } });
    let paymentRowId: string;
    if (!existing) {
      paymentRowId = (
        await tx.payment.create({
          data: { orderId: order.id, razorpayPaymentId: payment.id, status: "CAPTURED", amountMinor: payment.amount, method: payment.method ?? null, capturedAt: new Date() },
        })
      ).id;
    } else {
      paymentRowId = existing.id;
      // Never move a refunded payment back to captured.
      await tx.payment.updateMany({
        where: { id: existing.id, status: { in: ["AUTHORIZED", "FAILED"] } },
        data: { status: "CAPTURED", capturedAt: new Date(), method: payment.method ?? existing.method },
      });
    }
    const paidNow = await tx.paymentOrder.updateMany({ where: { id: order.id, status: { not: "PAID" } }, data: { status: "PAID" } });
    if (paidNow.count === 0) return { fulfilled: false, duplicatePayment: !existing, paymentRowId };

    if (order.purpose === "REPORT") {
      await tx.reportAccessGrant.create({
        data: { userId: order.userId, productId: order.reportProductId, source: "PURCHASE", orderId: order.id, usesRemaining: 1, reason: `Purchase ${order.receipt}` },
      });
    }
    return { fulfilled: true, duplicatePayment: false, paymentRowId };
  }).catch((err: unknown) => {
    // The browser callback and the webhook raced on the same payment; the other one fulfilled it.
    if (isUniqueViolation(err)) return null;
    throw err;
  });

  if (!outcome) return;
  if (outcome.duplicatePayment) {
    // A second successful payment for an order that was already paid: give it back.
    logger.warn({ orderId: order.id }, "Duplicate payment for a paid order, refunding");
    await refundPayment({ paymentId: outcome.paymentRowId, reason: "Duplicate payment for an order that was already paid", actorId: null });
    return;
  }
  if (!outcome.fulfilled) return;

  await audit({ actorId: order.userId, action: "payment.captured", entityType: "PaymentOrder", entityId: order.id, metadata: { amountMinor: order.amountMinor, purpose: order.purpose } });

  if (order.purpose === "REPORT") {
    const product = order.reportProductId ? await prisma.reportProduct.findUnique({ where: { id: order.reportProductId }, select: { title: true, slug: true } }) : null;
    await notify(
      order.userId,
      { type: "PAYMENT_RECEIVED", title: "Payment received", body: `${rupees(order.amountMinor)} received for ${product?.title ?? "your report"}. You can generate it now.`, link: product ? `/reports/${product.slug}` : "/dashboard/reports" },
      { email: true },
    );
  } else if (order.purpose === "CONSULTATION" && order.bookingId) {
    const booking = await prisma.booking.findUnique({ where: { id: order.bookingId }, include: { astrologer: true } });
    if (!booking || !ACTIVE_STATUSES.includes(booking.status)) {
      // The booking expired or was cancelled while the user was paying.
      await refundPayment({ paymentId: outcome.paymentRowId, reason: "Booking was no longer active when payment completed", actorId: null });
      return;
    }
    await notify(
      order.userId,
      { type: "PAYMENT_RECEIVED", title: "Payment received", body: `${rupees(order.amountMinor)} received for your consultation with ${booking.astrologer.displayName}. It now awaits confirmation.`, link: "/dashboard/bookings" },
      { email: true },
    );
    if (booking.astrologer.userId) {
      await notify(booking.astrologer.userId, { type: "BOOKING_PAID", title: "Consultation paid", body: `A paid request for ${booking.startsAt.toISOString()} is ready for your decision.`, link: "/astrologer" });
    }
  }
}

async function recordFailedPayment(order: PaymentOrder, payment: RemotePayment) {
  await prisma.paymentOrder.updateMany({ where: { id: order.id, status: "CREATED" }, data: { status: "ATTEMPTED" } });
  if (payment.amount > 0) {
    await prisma.payment.upsert({
      where: { razorpayPaymentId: payment.id },
      update: {},
      create: { orderId: order.id, razorpayPaymentId: payment.id, status: "FAILED", amountMinor: payment.amount, method: payment.method ?? null, failureReason: payment.error_description?.slice(0, 500) ?? null },
    });
  }
}

// ── Refunds ───────────────────────────────────────────────────

async function syncPaymentStatus(paymentId: string) {
  const payment = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId }, include: { refunds: true } });
  if (payment.status === "FAILED" || payment.status === "AUTHORIZED") return;
  const refunded = payment.refunds.filter((r) => r.status !== "FAILED").reduce((s, r) => s + r.amountMinor, 0);
  const status = refunded >= payment.amountMinor ? "REFUNDED" : refunded > 0 ? "PARTIALLY_REFUNDED" : "CAPTURED";
  await prisma.payment.update({ where: { id: paymentId }, data: { status } });
}

/** Refunds a captured payment in full (default) or in part. */
export async function refundPayment(input: { paymentId: string; amountMinor?: number; reason: string; actorId: string | null }) {
  const refund = await prisma.$transaction(async (tx) => {
    // Row lock: two concurrent refunds cannot both pass the remaining-amount check.
    if (!(await lockRow(tx, "Payment", input.paymentId))) throw notFound("Payment not found");
    const payment = await tx.payment.findUniqueOrThrow({ where: { id: input.paymentId }, include: { refunds: true } });
    if (payment.status !== "CAPTURED" && payment.status !== "PARTIALLY_REFUNDED") throw conflict("Only captured payments can be refunded");
    const remaining = payment.amountMinor - payment.refunds.filter((r) => r.status !== "FAILED").reduce((s, r) => s + r.amountMinor, 0);
    const amount = input.amountMinor ?? remaining;
    if (amount <= 0 || amount > remaining) throw badRequest(`Refund amount must be between 1 and ${remaining} paise`);
    return tx.refund.create({ data: { paymentId: payment.id, amountMinor: amount, reason: input.reason, initiatedById: input.actorId }, include: { payment: { include: { order: true } } } });
  });

  try {
    const remote = await gateway().createRefund(refund.payment.razorpayPaymentId, { amount: refund.amountMinor, notes: { refundId: refund.id, reason: input.reason.slice(0, 250) } });
    await prisma.refund.update({
      where: { id: refund.id },
      data: { razorpayRefundId: remote.id, status: remote.status === "processed" ? "PROCESSED" : remote.status === "failed" ? "FAILED" : "PENDING" },
    });
  } catch (err) {
    await prisma.refund.update({ where: { id: refund.id }, data: { status: "FAILED" } });
    throw err;
  }
  await syncPaymentStatus(refund.paymentId);

  const order = refund.payment.order;
  if (order.purpose === "REPORT") {
    // A refunded purchase no longer entitles a new report (already generated reports stay).
    await prisma.reportAccessGrant.updateMany({ where: { orderId: order.id, revokedAt: null }, data: { revokedAt: new Date() } });
  }
  await audit({ actorId: input.actorId, action: "payment.refund_initiated", entityType: "Payment", entityId: refund.paymentId, metadata: { amountMinor: refund.amountMinor, reason: input.reason } });
  await notify(order.userId, { type: "REFUND_INITIATED", title: "Refund initiated", body: `A refund of ${rupees(refund.amountMinor)} has been initiated. Banks usually take 5–7 working days.`, link: "/dashboard/payments" }, { email: true });
  return prisma.refund.findUniqueOrThrow({ where: { id: refund.id } });
}

/** Captured, not fully refunded payment for a booking, if any. */
export async function capturedBookingPayment(bookingId: string) {
  return prisma.payment.findFirst({
    where: { order: { bookingId, status: "PAID" }, status: { in: ["CAPTURED", "PARTIALLY_REFUNDED"] } },
    include: { refunds: true },
  });
}

export async function isBookingPaid(bookingId: string) {
  return (await prisma.paymentOrder.count({ where: { bookingId, status: "PAID" } })) > 0;
}

/** Records the commission split when a paid consultation completes. */
export async function recordEarning(bookingId: string) {
  const payment = await capturedBookingPayment(bookingId);
  if (!payment) return null;
  const booking = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId }, include: { astrologer: true } });
  const gross = payment.amountMinor - payment.refunds.filter((r) => r.status !== "FAILED").reduce((s, r) => s + r.amountMinor, 0);
  const rate = booking.astrologer.commissionRateBps ?? (await getNumberSetting("consultation.defaultCommissionBps"));
  const commission = Math.round((gross * rate) / 10_000);
  try {
    return await prisma.astrologerEarning.create({
      data: { bookingId, astrologerId: booking.astrologerId, grossMinor: gross, commissionRateBps: rate, commissionMinor: commission, netMinor: gross - commission },
    });
  } catch (err) {
    if (isUniqueViolation(err)) return null;
    throw err;
  }
}

// ── Webhooks ──────────────────────────────────────────────────

type WebhookEvent = {
  event: string;
  payload: {
    payment?: { entity: RemotePayment };
    refund?: { entity: { id: string; payment_id: string; amount: number; status: string } };
    subscription?: { entity: import("./razorpay.js").RemoteSubscription & { notes?: Record<string, string> } };
  };
};

/** Keeps only identifiers: webhook bodies carry customer contact and card details we do not need. */
const minimalPayload = (e: WebhookEvent) => ({
  event: e.event,
  paymentId: e.payload.payment?.entity.id ?? null,
  orderId: e.payload.payment?.entity.order_id ?? null,
  refundId: e.payload.refund?.entity.id ?? null,
  subscriptionId: e.payload.subscription?.entity.id ?? null,
});

export async function handleWebhook(raw: Buffer, signature: string | undefined, eventIdHeader: string | undefined) {
  if (!signature || !verifyWebhookSignature(raw, signature)) throw badRequest("Invalid webhook signature");
  let event: WebhookEvent;
  try {
    event = JSON.parse(raw.toString("utf8")) as WebhookEvent;
  } catch {
    throw badRequest("Invalid webhook body");
  }
  const eventId = eventIdHeader ?? sha256(raw.toString("utf8"));
  const key = { provider_eventId: { provider: "razorpay", eventId } };

  let row = await prisma.webhookEvent.findUnique({ where: key });
  if (row?.processedAt) return { duplicate: true };
  if (!row) {
    try {
      row = await prisma.webhookEvent.create({ data: { provider: "razorpay", eventId, eventType: event.event, payload: minimalPayload(event) } });
    } catch (err) {
      if (isUniqueViolation(err)) return { duplicate: true }; // a concurrent delivery is handling it
      throw err;
    }
  }

  try {
    await dispatch(event);
    await prisma.webhookEvent.update({ where: { id: row.id }, data: { processedAt: new Date(), error: null } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.webhookEvent.update({ where: { id: row.id }, data: { error: message.slice(0, 1000) } });
    throw err; // non-2xx makes Razorpay retry; the stored row is reprocessed then
  }
  return { duplicate: false };
}

async function dispatch(event: WebhookEvent) {
  const payment = event.payload.payment?.entity;
  switch (event.event) {
    case "payment.captured":
    case "order.paid": {
      if (!payment?.order_id) return;
      const order = await prisma.paymentOrder.findUnique({ where: { razorpayOrderId: payment.order_id } });
      if (!order) {
        // Subscription invoices have their own order ids and are recorded from subscription.charged.
        if (!payment.invoice_id) logger.error({ razorpayOrderId: payment.order_id, paymentId: payment.id }, "Captured payment for an unknown order");
        return;
      }
      if (order.purpose === "SUBSCRIPTION") return;
      await fulfilOrder(order, payment);
      return;
    }
    case "payment.failed": {
      if (!payment?.order_id) return;
      const order = await prisma.paymentOrder.findUnique({ where: { razorpayOrderId: payment.order_id } });
      if (order && order.status !== "PAID") await recordFailedPayment(order, payment);
      return;
    }
    case "refund.created":
    case "refund.processed":
    case "refund.failed": {
      const r = event.payload.refund?.entity;
      if (!r) return;
      const status = r.status === "processed" ? "PROCESSED" : r.status === "failed" ? "FAILED" : "PENDING";
      const existing = await prisma.refund.findUnique({ where: { razorpayRefundId: r.id } });
      if (existing) {
        await prisma.refund.update({ where: { id: existing.id }, data: { status } });
        await syncPaymentStatus(existing.paymentId);
        return;
      }
      // Refund issued from the Razorpay dashboard: record it so totals stay correct.
      const p = await prisma.payment.findUnique({ where: { razorpayPaymentId: r.payment_id } });
      if (!p) return;
      await prisma.refund.create({ data: { paymentId: p.id, razorpayRefundId: r.id, amountMinor: r.amount, status, reason: "Issued from the Razorpay dashboard" } });
      await syncPaymentStatus(p.id);
      return;
    }
    default:
      if (event.event.startsWith("subscription.") && event.payload.subscription) {
        await handleSubscriptionEvent(event.event, event.payload.subscription.entity, payment);
      }
  }
}

// ── History ───────────────────────────────────────────────────

export const orderSelect = {
  id: true,
  purpose: true,
  amountMinor: true,
  currency: true,
  status: true,
  receipt: true,
  createdAt: true,
  reportProduct: { select: { slug: true, title: true } },
  booking: { select: { id: true, startsAt: true, astrologer: { select: { displayName: true } } } },
  payments: {
    orderBy: { createdAt: "desc" as const },
    select: {
      id: true,
      status: true,
      amountMinor: true,
      method: true,
      failureReason: true,
      capturedAt: true,
      refunds: { select: { id: true, amountMinor: true, status: true, reason: true, createdAt: true } },
    },
  },
} as const;

export async function listMyPayments(userId: string, skip: number, take: number) {
  // Orders the user never attempted to pay are noise in a payment history.
  const where = { userId, status: { not: "CREATED" as const } };
  const [items, total] = await Promise.all([
    prisma.paymentOrder.findMany({ where, orderBy: { createdAt: "desc" }, skip, take, select: orderSelect }),
    prisma.paymentOrder.count({ where }),
  ]);
  return { items, total };
}
