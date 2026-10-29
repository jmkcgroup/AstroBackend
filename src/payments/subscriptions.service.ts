// Membership subscriptions on Razorpay Subscriptions. Each active billing period grants the plan's
// report credits once (unique per subscription + period), valid for any report until the period ends.
import type { SubscriptionStatus } from "../generated/prisma/enums.js";
import type { Subscription, SubscriptionPlan } from "../generated/prisma/client.js";
import { env } from "../config/env.js";
import { audit } from "../lib/audit.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";
import { notify } from "../modules/notifications/notifications.service.js";
import { gateway, verifySubscriptionSignature, type RemotePayment, type RemoteSubscription } from "./razorpay.js";

export const LIVE_STATUSES: SubscriptionStatus[] = ["AUTHENTICATED", "ACTIVE", "PENDING", "HALTED"];

const STATUS_MAP: Record<RemoteSubscription["status"], SubscriptionStatus> = {
  created: "CREATED",
  authenticated: "AUTHENTICATED",
  active: "ACTIVE",
  pending: "PENDING",
  halted: "HALTED",
  paused: "HALTED",
  cancelled: "CANCELLED",
  completed: "COMPLETED",
  expired: "EXPIRED",
};

const isUniqueViolation = (err: unknown) => (err as { code?: string }).code === "P2002";
const fromUnix = (s: number | null | undefined) => (s ? new Date(s * 1000) : null);

// ── Plans ─────────────────────────────────────────────────────

export const planSelect = {
  id: true,
  slug: true,
  name: true,
  description: true,
  features: true,
  amountMinor: true,
  currency: true,
  interval: true,
  reportCredits: true,
} as const;

export const listActivePlans = () =>
  prisma.subscriptionPlan.findMany({ where: { isActive: true, razorpayPlanId: { not: null } }, orderBy: [{ sortOrder: "asc" }, { amountMinor: "asc" }], select: planSelect });

export async function createPlan(
  actorId: string,
  input: { slug: string; name: string; description: string; features: string[]; amountMinor: number; interval: "MONTHLY" | "YEARLY"; reportCredits: number; sortOrder: number },
) {
  if (await prisma.subscriptionPlan.findUnique({ where: { slug: input.slug } })) throw conflict("A plan with this slug already exists");
  // Razorpay plans are immutable: the price and interval are fixed once created.
  const remote = await gateway().createPlan({
    period: input.interval === "MONTHLY" ? "monthly" : "yearly",
    interval: 1,
    item: { name: input.name, amount: input.amountMinor, currency: "INR", description: input.description.slice(0, 200) },
  });
  const plan = await prisma.subscriptionPlan.create({ data: { ...input, currency: "INR", razorpayPlanId: remote.id } });
  await audit({ actorId, action: "admin.plan_created", entityType: "SubscriptionPlan", entityId: plan.id, metadata: { amountMinor: plan.amountMinor, interval: plan.interval } });
  return plan;
}

// ── Checkout ──────────────────────────────────────────────────

export async function startSubscription(userId: string, planId: string) {
  const plan = await prisma.subscriptionPlan.findFirst({ where: { id: planId, isActive: true, razorpayPlanId: { not: null } } });
  if (!plan) throw notFound("Plan not found");
  if (await prisma.subscription.findFirst({ where: { userId, status: { in: LIVE_STATUSES } } })) {
    throw conflict("You already have a membership. Cancel it before choosing another plan.");
  }
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { name: true, email: true } });
  const payload = (sub: { id: string; razorpaySubscriptionId: string }) => ({
    subscriptionId: sub.id,
    razorpaySubscriptionId: sub.razorpaySubscriptionId,
    keyId: env.RAZORPAY_KEY_ID ?? "",
    description: plan.name,
    prefill: user,
  });

  // Reuse an unpaid checkout for the same plan from the last day.
  const pending = await prisma.subscription.findFirst({
    where: { userId, planId, status: "CREATED", razorpaySubscriptionId: { not: null }, createdAt: { gt: new Date(Date.now() - 86_400_000) } },
  });
  if (pending) return payload({ id: pending.id, razorpaySubscriptionId: pending.razorpaySubscriptionId! });

  const g = gateway();
  const row = await prisma.subscription.create({ data: { userId, planId, status: "CREATED" } });
  const remote = await g.createSubscription({
    plan_id: plan.razorpayPlanId!,
    // Razorpay needs a finite cycle count: ten years either way.
    total_count: plan.interval === "MONTHLY" ? 120 : 10,
    customer_notify: 1,
    notes: { subscriptionId: row.id },
  });
  await prisma.subscription.update({ where: { id: row.id }, data: { razorpaySubscriptionId: remote.id } });
  return payload({ id: row.id, razorpaySubscriptionId: remote.id });
}

export async function verifySubscriptionCheckout(
  userId: string,
  input: { razorpay_payment_id: string; razorpay_subscription_id: string; razorpay_signature: string },
) {
  const sub = await prisma.subscription.findFirst({ where: { razorpaySubscriptionId: input.razorpay_subscription_id, userId }, include: { plan: true } });
  if (!sub) throw notFound("Subscription not found");
  if (!verifySubscriptionSignature(input.razorpay_payment_id, input.razorpay_subscription_id, input.razorpay_signature)) {
    logger.warn({ subscriptionId: sub.id }, "Rejected subscription checkout with an invalid signature");
    throw badRequest("Payment verification failed");
  }
  await syncSubscription(sub, await gateway().fetchSubscription(input.razorpay_subscription_id));
  return mySubscription(userId);
}

// ── State sync (checkout callback and webhooks) ───────────────

async function syncSubscription(sub: Subscription & { plan: SubscriptionPlan }, remote: RemoteSubscription) {
  const status = STATUS_MAP[remote.status] ?? sub.status;
  const start = fromUnix(remote.current_start) ?? sub.currentPeriodStart;
  const end = fromUnix(remote.current_end) ?? sub.currentPeriodEnd;

  try {
    await prisma.subscription.update({
      where: { id: sub.id },
      data: {
        status,
        currentPeriodStart: start,
        currentPeriodEnd: end,
        ...((status === "CANCELLED" || status === "COMPLETED" || status === "EXPIRED") && !sub.cancelledAt && { cancelledAt: new Date() }),
      },
    });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    // A second membership was paid from another tab while one is live: cancel the newcomer.
    logger.warn({ subscriptionId: sub.id }, "Second live subscription for a user, cancelling it");
    await gateway().cancelSubscription(remote.id, false).catch((e: unknown) => logger.error({ err: e }, "Could not cancel duplicate subscription"));
    await prisma.subscription.update({ where: { id: sub.id }, data: { status: "CANCELLED", cancelledAt: new Date() } });
    await notify(sub.userId, { type: "SUBSCRIPTION_DUPLICATE", title: "Duplicate membership cancelled", body: "You already have a membership, so the new one was cancelled. Any amount charged will be refunded.", link: "/dashboard/payments" }, { email: true });
    return;
  }

  if (status === "ACTIVE" && start && sub.plan.reportCredits > 0) {
    try {
      await prisma.reportAccessGrant.create({
        data: {
          userId: sub.userId,
          productId: null,
          source: "SUBSCRIPTION",
          subscriptionId: sub.id,
          periodStart: start,
          usesRemaining: sub.plan.reportCredits,
          expiresAt: end,
          reason: `${sub.plan.name} credits`,
        },
      });
      await notify(sub.userId, {
        type: "SUBSCRIPTION_CREDITS",
        title: "Report credits added",
        body: `${sub.plan.reportCredits} report credit(s) from ${sub.plan.name} are ready to use${end ? ` until ${end.toISOString().slice(0, 10)}` : ""}.`,
        link: "/reports",
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err; // credits for this period were already granted
    }
  }

  if (status !== sub.status) {
    const messages: Partial<Record<SubscriptionStatus, [string, string]>> = {
      ACTIVE: ["Membership active", `Your ${sub.plan.name} membership is active.`],
      HALTED: ["Membership paused", `We could not renew ${sub.plan.name}. Please update your payment method in the Razorpay link sent to your email.`],
      CANCELLED: ["Membership cancelled", `Your ${sub.plan.name} membership has ended.`],
    };
    const msg = messages[status];
    if (msg && !(status === "ACTIVE" && sub.status === "PENDING")) {
      await notify(sub.userId, { type: `SUBSCRIPTION_${status}`, title: msg[0], body: msg[1], link: "/dashboard/payments" }, { email: true });
    }
  }
}

export async function handleSubscriptionEvent(event: string, remote: RemoteSubscription, payment?: RemotePayment) {
  const sub = await prisma.subscription.findUnique({ where: { razorpaySubscriptionId: remote.id }, include: { plan: true } });
  if (!sub) {
    logger.warn({ razorpaySubscriptionId: remote.id, event }, "Webhook for an unknown subscription");
    return;
  }
  await syncSubscription(sub, remote);

  // Record each renewal charge as a paid order so revenue and history include it.
  if (event === "subscription.charged" && payment && payment.status === "captured") {
    if (await prisma.payment.findUnique({ where: { razorpayPaymentId: payment.id } })) return;
    try {
      await prisma.paymentOrder.create({
        data: {
          userId: sub.userId,
          purpose: "SUBSCRIPTION",
          amountMinor: payment.amount,
          currency: payment.currency,
          status: "PAID",
          receipt: `sub_${payment.id}`.slice(0, 40),
          razorpayOrderId: payment.order_id,
          payments: { create: { razorpayPaymentId: payment.id, status: "CAPTURED", amountMinor: payment.amount, method: payment.method ?? null, capturedAt: new Date() } },
        },
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
  }
}

// ── Self-service ──────────────────────────────────────────────

export async function mySubscription(userId: string) {
  const sub = await prisma.subscription.findFirst({
    where: { userId, status: { not: "CREATED" } },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      status: true,
      currentPeriodStart: true,
      currentPeriodEnd: true,
      cancelAtPeriodEnd: true,
      cancelledAt: true,
      createdAt: true,
      plan: { select: planSelect },
    },
  });
  if (!sub) return null;
  const credits = await prisma.reportAccessGrant.aggregate({
    where: { subscriptionId: sub.id, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
    _sum: { usesRemaining: true },
  });
  return { ...sub, creditsRemaining: credits._sum.usesRemaining ?? 0 };
}

export async function cancelMySubscription(userId: string) {
  const sub = await prisma.subscription.findFirst({ where: { userId, status: { in: LIVE_STATUSES } } });
  if (!sub || !sub.razorpaySubscriptionId) throw notFound("You have no membership to cancel");
  if (sub.cancelAtPeriodEnd) throw conflict("This membership is already set to end");
  // An active membership runs until the paid period ends; anything else stops now.
  const atCycleEnd = sub.status === "ACTIVE";
  await gateway().cancelSubscription(sub.razorpaySubscriptionId, atCycleEnd);
  await prisma.subscription.update({
    where: { id: sub.id },
    data: atCycleEnd ? { cancelAtPeriodEnd: true } : { status: "CANCELLED", cancelledAt: new Date() },
  });
  await audit({ actorId: userId, action: "subscription.cancelled_by_user", entityType: "Subscription", entityId: sub.id });
  return mySubscription(userId);
}
