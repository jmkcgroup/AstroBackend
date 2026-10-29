import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expireUnpaidBookings } from "../src/modules/consultations/bookings.service.js";
import { setPaymentGateway } from "../src/payments/razorpay.js";
import { seedCatalogue } from "../src/seed/catalogue.js";
import { FakeGateway, signWebhook } from "./fake-gateway.js";
import { PUNE_PROFILE, app, prisma, registerAgent, resetDatabase } from "./helpers.js";

type Agent = Awaited<ReturnType<typeof registerAgent>>;
const fake = new FakeGateway();
let admin: Agent;
let productId: string;
let priceMinor: number;

const futureDate = (daysAhead: number) => new Date(Date.now() + daysAhead * 86_400_000).toISOString().slice(0, 10);

function webhook(body: object, eventId = `evt_${Math.random().toString(36).slice(2)}`) {
  const raw = JSON.stringify(body);
  return request(app)
    .post("/api/payments/webhook/razorpay")
    .set("Content-Type", "application/json")
    .set("X-Razorpay-Signature", signWebhook(raw))
    .set("X-Razorpay-Event-Id", eventId)
    .send(raw);
}

async function buyReport(customer: Agent) {
  const order = await customer.agent.post("/api/payments/orders").send({ purpose: "REPORT", productId });
  expect(order.status).toBe(201);
  return order.body.checkout as { orderId: string; razorpayOrderId: string; amountMinor: number };
}

beforeAll(async () => {
  setPaymentGateway(fake);
  await resetDatabase();
  await seedCatalogue(prisma);
  admin = await registerAgent({ name: "Admin" });
  await prisma.user.update({ where: { id: admin.user.id }, data: { role: "ADMIN" } });
  const product = await prisma.reportProduct.findFirstOrThrow({ where: { slug: "career-education" } });
  productId = product.id;
  priceMinor = product.indicativePriceMinor!;
});

afterAll(async () => {
  setPaymentGateway(null);
  await prisma.$disconnect();
});

describe("report purchase", () => {
  it("exposes the public checkout configuration", async () => {
    const res = await request(app).get("/api/payments/config");
    expect(res.body).toEqual({ enabled: true, keyId: "rzp_test_localonly" });
  });

  it("requires sign-in and takes the price from the catalogue, never from the client", async () => {
    expect((await request(app).post("/api/payments/orders").send({ purpose: "REPORT", productId })).status).toBe(401);
    const customer = await registerAgent();
    const res = await customer.agent.post("/api/payments/orders").send({ purpose: "REPORT", productId, amountMinor: 100 });
    expect(res.status).toBe(201);
    expect(res.body.checkout.amountMinor).toBe(priceMinor);
    expect(fake.orders.get(res.body.checkout.razorpayOrderId)?.amount).toBe(priceMinor);
  });

  it("rejects a forged signature and grants nothing", async () => {
    const customer = await registerAgent();
    const checkout = await buyReport(customer);
    const { callback } = fake.pay(checkout.razorpayOrderId);
    const res = await customer.agent.post("/api/payments/verify").send({ ...callback, razorpay_signature: "0".repeat(64) });
    expect(res.status).toBe(400);
    expect(await prisma.reportAccessGrant.count({ where: { userId: customer.user.id } })).toBe(0);
  });

  it("unlocks exactly one report after a verified payment, idempotently", async () => {
    const customer = await registerAgent();
    const profile = (await customer.agent.post("/api/birth-profiles").send(PUNE_PROFILE)).body.profile;
    expect((await customer.agent.post("/api/reports").send({ productId, birthProfileId: profile.id })).status).toBe(403);

    const checkout = await buyReport(customer);
    const { callback, payment } = fake.pay(checkout.razorpayOrderId);
    const verified = await customer.agent.post("/api/payments/verify").send(callback);
    expect(verified.status).toBe(200);
    expect(verified.body.order.status).toBe("PAID");

    // Replays of the callback and the webhook for the same payment change nothing.
    expect((await customer.agent.post("/api/payments/verify").send(callback)).status).toBe(200);
    expect((await webhook({ event: "payment.captured", payload: { payment: { entity: payment } } })).status).toBe(200);
    expect(await prisma.reportAccessGrant.count({ where: { userId: customer.user.id } })).toBe(1);
    expect(await prisma.payment.count({ where: { razorpayPaymentId: payment.id } })).toBe(1);

    expect((await customer.agent.post("/api/reports").send({ productId, birthProfileId: profile.id })).status).toBe(201);
    // The single use is spent
    expect((await customer.agent.post("/api/reports").send({ productId, birthProfileId: profile.id })).status).toBe(403);

    const history = await customer.agent.get("/api/payments");
    expect(history.body.items).toHaveLength(1);
    expect(history.body.items[0].payments[0].status).toBe("CAPTURED");
  });

  it("refuses a payment whose amount does not match the order", async () => {
    const customer = await registerAgent();
    const checkout = await buyReport(customer);
    const { callback } = fake.pay(checkout.razorpayOrderId, { amount: 100 });
    expect((await customer.agent.post("/api/payments/verify").send(callback)).status).toBe(400);
    expect(await prisma.reportAccessGrant.count({ where: { userId: customer.user.id } })).toBe(0);
  });

  it("does not let another user verify someone else's order", async () => {
    const owner = await registerAgent();
    const intruder = await registerAgent();
    const checkout = await buyReport(owner);
    const { callback } = fake.pay(checkout.razorpayOrderId);
    expect((await intruder.agent.post("/api/payments/verify").send(callback)).status).toBe(404);
  });
});

describe("webhooks", () => {
  it("rejects an unsigned or tampered webhook", async () => {
    const raw = JSON.stringify({ event: "payment.captured", payload: {} });
    const res = await request(app).post("/api/payments/webhook/razorpay").set("Content-Type", "application/json").set("X-Razorpay-Signature", "f".repeat(64)).send(raw);
    expect(res.status).toBe(400);
    expect((await request(app).post("/api/payments/webhook/razorpay").send(raw)).status).toBe(400);
  });

  it("fulfils from the webhook alone (browser closed) and processes each event once", async () => {
    const customer = await registerAgent();
    const checkout = await buyReport(customer);
    const { payment } = fake.pay(checkout.razorpayOrderId);
    const body = { event: "payment.captured", payload: { payment: { entity: payment } } };
    expect((await webhook(body, "evt_once_1")).status).toBe(200);
    expect((await webhook(body, "evt_once_1")).status).toBe(200);
    expect(await prisma.reportAccessGrant.count({ where: { userId: customer.user.id } })).toBe(1);
    expect(await prisma.webhookEvent.count({ where: { eventId: "evt_once_1" } })).toBe(1);
    // Stored payload keeps identifiers only
    const stored = await prisma.webhookEvent.findFirstOrThrow({ where: { eventId: "evt_once_1" } });
    expect(Object.keys(stored.payload as object).sort()).toEqual(["event", "orderId", "paymentId", "refundId", "subscriptionId"]);
  });

  it("records a failed payment without granting access", async () => {
    const customer = await registerAgent();
    const checkout = await buyReport(customer);
    const { payment } = fake.pay(checkout.razorpayOrderId, { status: "failed" });
    expect((await webhook({ event: "payment.failed", payload: { payment: { entity: payment } } })).status).toBe(200);
    const order = await prisma.paymentOrder.findUniqueOrThrow({ where: { id: checkout.orderId }, include: { payments: true } });
    expect(order.status).toBe("ATTEMPTED");
    expect(order.payments[0]?.status).toBe("FAILED");
    expect(await prisma.reportAccessGrant.count({ where: { userId: customer.user.id } })).toBe(0);
  });
});

describe("refunds", () => {
  it("lets admins refund in part and in full, never more than was paid", async () => {
    const customer = await registerAgent();
    const checkout = await buyReport(customer);
    const { callback } = fake.pay(checkout.razorpayOrderId);
    await customer.agent.post("/api/payments/verify").send(callback);
    const payment = await prisma.payment.findFirstOrThrow({ where: { orderId: checkout.orderId } });

    expect((await customer.agent.post(`/api/admin/payments/${payment.id}/refund`).send({ reason: "nope" })).status).toBe(403);
    const partial = await admin.agent.post(`/api/admin/payments/${payment.id}/refund`).send({ amountMinor: 10_000, reason: "Goodwill partial refund" });
    expect(partial.status).toBe(201);
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe("PARTIALLY_REFUNDED");

    expect((await admin.agent.post(`/api/admin/payments/${payment.id}/refund`).send({ amountMinor: priceMinor, reason: "Too much" })).status).toBe(400);
    expect((await admin.agent.post(`/api/admin/payments/${payment.id}/refund`).send({ reason: "Customer request" })).status).toBe(201);
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe("REFUNDED");
    // The unused purchase no longer unlocks a report
    expect((await customer.agent.get("/api/reports/entitlements")).body.items).toHaveLength(0);
    expect(fake.refunds.filter((r) => r.payment_id === payment.razorpayPaymentId).reduce((s, r) => s + r.amount, 0)).toBe(priceMinor);
  });
});

describe("paid consultations", () => {
  const SLUG = "paid-astrologer";
  let astrologerId: string;
  let astrologerUser: Agent;

  async function openSlotIds() {
    const res = await request(app).get(`/api/astrologers/${SLUG}/slots?days=30`);
    return (res.body.items as { id: string }[]).map((s) => s.id);
  }

  async function bookAndPay(customer: Agent) {
    const [slotId] = await openSlotIds();
    const bookingId = (await customer.agent.post("/api/bookings").send({ slotId })).body.booking.id as string;
    const order = await customer.agent.post("/api/payments/orders").send({ purpose: "CONSULTATION", bookingId });
    expect(order.status).toBe(201);
    const { callback } = fake.pay(order.body.checkout.razorpayOrderId);
    expect((await customer.agent.post("/api/payments/verify").send(callback)).status).toBe(200);
    return bookingId;
  }

  beforeAll(async () => {
    astrologerUser = await registerAgent({ name: "Paid Astro" });
    const res = await admin.agent.post("/api/admin/astrologers").send({
      displayName: "Paid Astrologer",
      slug: SLUG,
      bio: "Practising Vedic astrology with a focus on career and education guidance.",
      languages: ["EN"],
      feeMinor: 99_900,
      userEmail: astrologerUser.email,
    });
    astrologerId = res.body.astrologer.id;
    await admin.agent.post(`/api/admin/astrologers/${astrologerId}/status`).send({ isActive: true });
    await admin.agent
      .post(`/api/admin/astrologers/${astrologerId}/slots`)
      .send({ dates: [futureDate(3), futureDate(4)], startTime: "10:00", endTime: "13:00", durationMinutes: 30, timezone: "Asia/Kolkata" });
  });

  it("cannot be confirmed before payment, then records the commission on completion", async () => {
    const customer = await registerAgent();
    const [slotId] = await openSlotIds();
    const bookingId = (await customer.agent.post("/api/bookings").send({ slotId })).body.booking.id as string;
    expect((await astrologerUser.agent.patch(`/api/astrologer/bookings/${bookingId}`).send({ status: "CONFIRMED" })).status).toBe(409);

    const order = await customer.agent.post("/api/payments/orders").send({ purpose: "CONSULTATION", bookingId });
    expect(order.body.checkout.amountMinor).toBe(99_900);
    const { callback } = fake.pay(order.body.checkout.razorpayOrderId);
    await customer.agent.post("/api/payments/verify").send(callback);
    expect((await customer.agent.get(`/api/bookings/${bookingId}`)).body.booking.paymentOrder.status).toBe("PAID");
    expect((await customer.agent.post("/api/payments/orders").send({ purpose: "CONSULTATION", bookingId })).status).toBe(409);

    expect((await astrologerUser.agent.patch(`/api/astrologer/bookings/${bookingId}`).send({ status: "CONFIRMED" })).status).toBe(200);
    await prisma.booking.update({ where: { id: bookingId }, data: { startsAt: new Date(Date.now() - 3_600_000), endsAt: new Date(Date.now() - 1_800_000) } });
    expect((await admin.agent.patch(`/api/admin/bookings/${bookingId}`).send({ status: "COMPLETED" })).status).toBe(200);

    const earning = await prisma.astrologerEarning.findUniqueOrThrow({ where: { bookingId } });
    expect(earning).toMatchObject({ grossMinor: 99_900, commissionRateBps: 2000, commissionMinor: 19_980, netMinor: 79_920, payoutStatus: "PENDING" });
    const payout = await admin.agent.post(`/api/admin/earnings/${earning.id}/payout`).send({ payoutStatus: "PAID" });
    expect(payout.body.earning.payoutStatus).toBe("PAID");
  });

  it("refunds in full when the astrologer declines a paid request", async () => {
    const customer = await registerAgent();
    const bookingId = await bookAndPay(customer);
    const before = fake.refunds.length;
    expect((await astrologerUser.agent.patch(`/api/astrologer/bookings/${bookingId}`).send({ status: "REJECTED" })).status).toBe(200);
    expect(fake.refunds.length).toBe(before + 1);
    expect(fake.refunds.at(-1)!.amount).toBe(99_900);
    const payment = await prisma.payment.findFirstOrThrow({ where: { order: { bookingId } } });
    expect(payment.status).toBe("REFUNDED");
  });

  it("refunds a user cancellation made before the cut-off", async () => {
    const customer = await registerAgent();
    const bookingId = await bookAndPay(customer);
    const res = await customer.agent.post(`/api/bookings/${bookingId}/cancel`).send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ refunded: true, paid: true, refundCutoffHours: 24 });
  });

  it("releases unpaid requests after the hold time and refunds a payment that arrives late", async () => {
    const customer = await registerAgent();
    const [slotId] = await openSlotIds();
    const bookingId = (await customer.agent.post("/api/bookings").send({ slotId })).body.booking.id as string;
    const order = await customer.agent.post("/api/payments/orders").send({ purpose: "CONSULTATION", bookingId });

    await prisma.booking.update({ where: { id: bookingId }, data: { createdAt: new Date(Date.now() - 31 * 60_000) } });
    expect(await expireUnpaidBookings()).toBeGreaterThanOrEqual(1);
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } })).status).toBe("CANCELLED");
    expect(await openSlotIds()).toContain(slotId);

    const before = fake.refunds.length;
    const { callback } = fake.pay(order.body.checkout.razorpayOrderId);
    expect((await customer.agent.post("/api/payments/verify").send(callback)).status).toBe(200);
    expect(fake.refunds.length).toBe(before + 1);
  });
});

describe("memberships", () => {
  let planId: string;

  it("lets admins create plans that appear publicly", async () => {
    const res = await admin.agent.post("/api/admin/plans").send({
      slug: "seeker-monthly",
      name: "Seeker Monthly",
      description: "Two premium reports every month.",
      features: ["2 report credits per month"],
      amountMinor: 49_900,
      interval: "MONTHLY",
      reportCredits: 2,
    });
    expect(res.status).toBe(201);
    expect(res.body.plan.razorpayPlanId).toMatch(/^plan_/);
    planId = res.body.plan.id;
    const pub = await request(app).get("/api/payments/plans");
    expect(pub.body.items).toHaveLength(1);
    expect(pub.body.items[0]).not.toHaveProperty("razorpayPlanId");
  });

  it("activates after a verified checkout, grants credits once per period and spends them on any report", async () => {
    const customer = await registerAgent();
    const profile = (await customer.agent.post("/api/birth-profiles").send(PUNE_PROFILE)).body.profile;
    const start = await customer.agent.post("/api/payments/subscription").send({ planId });
    expect(start.status).toBe(201);
    const rzpSubId = start.body.checkout.razorpaySubscriptionId as string;

    const { callback, payment } = fake.activate(rzpSubId, 49_900);
    const verified = await customer.agent.post("/api/payments/subscription/verify").send(callback);
    expect(verified.status).toBe(200);
    expect(verified.body.subscription).toMatchObject({ status: "ACTIVE", creditsRemaining: 2 });

    // The renewal webhook for the same period adds no extra credits but records the charge.
    const entity = await fake.fetchSubscription(rzpSubId);
    const charged = { event: "subscription.charged", payload: { subscription: { entity }, payment: { entity: payment } } };
    expect((await webhook(charged)).status).toBe(200);
    expect((await customer.agent.get("/api/payments/subscription")).body.subscription.creditsRemaining).toBe(2);
    expect(await prisma.paymentOrder.count({ where: { userId: customer.user.id, purpose: "SUBSCRIPTION", status: "PAID" } })).toBe(1);

    // Credits work for any report
    const yearly = await prisma.reportProduct.findFirstOrThrow({ where: { slug: "yearly" } });
    expect((await customer.agent.post("/api/reports").send({ productId: yearly.id, birthProfileId: profile.id })).status).toBe(201);
    expect((await customer.agent.get("/api/payments/subscription")).body.subscription.creditsRemaining).toBe(1);

    // One membership at a time
    expect((await customer.agent.post("/api/payments/subscription").send({ planId })).status).toBe(409);

    const cancelled = await customer.agent.post("/api/payments/subscription/cancel");
    expect(cancelled.body.subscription).toMatchObject({ status: "ACTIVE", cancelAtPeriodEnd: true });
  });

  it("shows revenue in admin metrics from real payments only", async () => {
    const res = await admin.agent.get("/api/admin/metrics");
    expect(res.body.revenue.gross30dMinor).toBeGreaterThan(0);
    expect(res.body.revenue.byPurpose30dMinor.SUBSCRIPTION).toBe(49_900);
    expect(res.body.revenue.activeSubscriptions).toBe(1);
    const sum = await prisma.payment.aggregate({ where: { status: { in: ["CAPTURED", "PARTIALLY_REFUNDED", "REFUNDED"] } }, _sum: { amountMinor: true } });
    expect(res.body.revenue.gross30dMinor).toBe(sum._sum.amountMinor);
  });
});
