import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setPaymentGateway } from "../src/payments/razorpay.js";
import { seedCatalogue } from "../src/seed/catalogue.js";
import { FakeGateway } from "./fake-gateway.js";
import { PUNE_PROFILE, app, prisma, registerAgent, resetDatabase } from "./helpers.js";

type Agent = Awaited<ReturnType<typeof registerAgent>>;
let admin: Agent;
let astrologerUser: Agent;
let astrologerId: string;
const SLUG = "test-astrologer";

const futureDate = (daysAhead: number) => new Date(Date.now() + daysAhead * 86_400_000).toISOString().slice(0, 10);

async function openSlotIds() {
  const res = await request(app).get(`/api/astrologers/${SLUG}/slots?days=30`);
  return (res.body.items as { id: string }[]).map((s) => s.id);
}

const fake = new FakeGateway();

beforeAll(async () => {
  setPaymentGateway(fake);
  await resetDatabase();
  await seedCatalogue(prisma);
  admin = await registerAgent({ name: "Admin" });
  await prisma.user.update({ where: { id: admin.user.id }, data: { role: "ADMIN" } });
  astrologerUser = await registerAgent({ name: "Astro Person" });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("admin access control", () => {
  it("denies admin endpoints to normal users and anonymous callers", async () => {
    const user = await registerAgent();
    expect((await user.agent.get("/api/admin/metrics")).status).toBe(403);
    expect((await user.agent.get("/api/admin/users")).status).toBe(403);
    expect((await request(app).get("/api/admin/metrics")).status).toBe(401);
    expect((await admin.agent.get("/api/admin/metrics")).status).toBe(200);
  });

  it("never exposes password hashes in user listings", async () => {
    const res = await admin.agent.get("/api/admin/users?q=example.test");
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|\$2[aby]\$/);
  });

  it("prevents admins from demoting or suspending themselves", async () => {
    expect((await admin.agent.patch(`/api/admin/users/${admin.user.id}`).send({ role: "USER" })).status).toBe(400);
  });
});

describe("astrologer management", () => {
  it("creates an inactive astrologer, links the account and hides unverified credentials", async () => {
    const res = await admin.agent.post("/api/admin/astrologers").send({
      displayName: "Test Astrologer",
      slug: SLUG,
      bio: "Practising Vedic astrology with a focus on career and education guidance.",
      languages: ["EN", "HI"],
      qualifications: ["Jyotish Visharad"],
      experienceYears: 12,
      consultationMinutes: 30,
      feeMinor: 99_900,
      specializationSlugs: ["career", "vedic-astrology"],
      userEmail: astrologerUser.email,
    });
    expect(res.status).toBe(201);
    astrologerId = res.body.astrologer.id;
    expect((await prisma.user.findUniqueOrThrow({ where: { id: astrologerUser.user.id } })).role).toBe("ASTROLOGER");

    // Inactive astrologers are not public
    expect((await request(app).get(`/api/astrologers/${SLUG}`)).status).toBe(404);
    await admin.agent.post(`/api/admin/astrologers/${astrologerId}/status`).send({ isActive: true });

    const pub = await request(app).get(`/api/astrologers/${SLUG}`);
    expect(pub.status).toBe(200);
    expect(pub.body.astrologer.qualifications).toEqual([]);
    expect(pub.body.astrologer.experienceYears).toBeNull();
    expect(pub.body.astrologer.rating).toEqual({ average: null, count: 0 });

    await admin.agent.post(`/api/admin/astrologers/${astrologerId}/status`).send({ credentialsVerified: true });
    const verified = await request(app).get(`/api/astrologers/${SLUG}`);
    expect(verified.body.astrologer.qualifications).toEqual(["Jyotish Visharad"]);
    expect(verified.body.astrologer.credentialsVerified).toBe(true);
  });

  it("filters the directory by specialization, language and fee", async () => {
    expect((await request(app).get("/api/astrologers?specialization=career")).body.items).toHaveLength(1);
    expect((await request(app).get("/api/astrologers?specialization=vastu")).body.items).toHaveLength(0);
    expect((await request(app).get("/api/astrologers?maxFee=50000")).body.items).toHaveLength(0);
    expect((await request(app).get("/api/astrologers?q=career")).body.items).toHaveLength(1);
  });

  it("creates non-overlapping slots", async () => {
    const body = { dates: [futureDate(3), futureDate(4)], startTime: "10:00", endTime: "12:00", durationMinutes: 30, timezone: "Asia/Kolkata" };
    const first = await admin.agent.post(`/api/admin/astrologers/${astrologerId}/slots`).send(body);
    expect(first.status).toBe(201);
    expect(first.body.created).toBe(8);
    const again = await admin.agent.post(`/api/admin/astrologers/${astrologerId}/slots`).send(body);
    expect(again.body.created).toBe(0);
    expect(again.body.skippedOverlapping).toBe(8);
    expect(await openSlotIds()).toHaveLength(8);
    expect((await request(app).get("/api/astrologers?available=true")).body.items).toHaveLength(1);
  });
});

describe("booking workflow", () => {
  it("allows exactly one of several concurrent requests for the same slot", async () => {
    const [slotId] = await openSlotIds();
    const users = await Promise.all([1, 2, 3, 4, 5].map(() => registerAgent()));
    const results = await Promise.all(users.map((u) => u.agent.post("/api/bookings").send({ slotId })));
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(4);
    expect(await prisma.booking.count({ where: { slotId } })).toBe(1);
    expect(await openSlotIds()).not.toContain(slotId);
  });

  it("keeps bookings pending until confirmed, then supports completion and a genuine review", async () => {
    const customer = await registerAgent();
    const other = await registerAgent();
    const profile = (await customer.agent.post("/api/birth-profiles").send(PUNE_PROFILE)).body.profile;
    const [slotId] = await openSlotIds();

    const created = await customer.agent.post("/api/bookings").send({ slotId, notes: "Career question", birthProfileId: profile.id });
    expect(created.status).toBe(201);
    expect(created.body.booking.status).toBe("PENDING");
    const bookingId = created.body.booking.id as string;
    expect(await prisma.notification.count({ where: { userId: astrologerUser.user.id, type: "BOOKING_NEW" } })).toBeGreaterThan(0);

    // Privacy: other users cannot see it
    expect((await other.agent.get(`/api/bookings/${bookingId}`)).status).toBe(404);
    // A normal user cannot decide on bookings
    expect((await other.agent.patch(`/api/admin/bookings/${bookingId}`).send({ status: "CONFIRMED" })).status).toBe(403);

    // The linked astrologer sees the request with the attached birth profile
    const mine = await astrologerUser.agent.get("/api/astrologer/bookings");
    expect(mine.status).toBe(200);
    expect(mine.body.items.find((b: { id: string }) => b.id === bookingId).birthProfile.placeName).toBe(PUNE_PROFILE.placeName);

    // Paid consultation: payment comes before confirmation
    expect((await astrologerUser.agent.patch(`/api/astrologer/bookings/${bookingId}`).send({ status: "CONFIRMED" })).status).toBe(409);
    const order = await customer.agent.post("/api/payments/orders").send({ purpose: "CONSULTATION", bookingId });
    await customer.agent.post("/api/payments/verify").send(fake.pay(order.body.checkout.razorpayOrderId).callback);

    const confirm = await astrologerUser.agent
      .patch(`/api/astrologer/bookings/${bookingId}`)
      .send({ status: "CONFIRMED", meetingLink: "https://meet.example.test/abc" });
    expect(confirm.status).toBe(200);
    expect((await customer.agent.get(`/api/bookings/${bookingId}`)).body.booking.status).toBe("CONFIRMED");
    expect(await prisma.notification.count({ where: { userId: customer.user.id, type: "BOOKING_CONFIRMED" } })).toBe(1);

    // Cannot complete before it starts, cannot review before completion
    expect((await admin.agent.patch(`/api/admin/bookings/${bookingId}`).send({ status: "COMPLETED" })).status).toBe(409);
    expect((await customer.agent.post(`/api/bookings/${bookingId}/review`).send({ rating: 5 })).status).toBe(409);

    // Move the consultation into the past and complete it
    await prisma.booking.update({ where: { id: bookingId }, data: { startsAt: new Date(Date.now() - 3_600_000), endsAt: new Date(Date.now() - 1_800_000) } });
    expect((await admin.agent.patch(`/api/admin/bookings/${bookingId}`).send({ status: "COMPLETED" })).status).toBe(200);

    expect((await customer.agent.post(`/api/bookings/${bookingId}/review`).send({ rating: 4, comment: "Clear and helpful" })).status).toBe(201);
    expect((await customer.agent.post(`/api/bookings/${bookingId}/review`).send({ rating: 5 })).status).toBe(409);

    const pub = await request(app).get(`/api/astrologers/${SLUG}`);
    expect(pub.body.astrologer.rating).toEqual({ average: 4, count: 1 });
    expect(pub.body.astrologer.reviews[0].reviewer).toBe("Test");
  });

  it("supports cancellation and rescheduling to another free slot", async () => {
    const customer = await registerAgent();
    const [a, b] = await openSlotIds();
    const created = await customer.agent.post("/api/bookings").send({ slotId: a });
    const bookingId = created.body.booking.id as string;

    expect((await customer.agent.post(`/api/bookings/${bookingId}/reschedule`).send({ slotId: b })).status).toBe(200);
    const moved = await customer.agent.get(`/api/bookings/${bookingId}`);
    expect(moved.body.booking.status).toBe("RESCHEDULE_REQUESTED");
    expect(await openSlotIds()).toContain(a); // old slot released
    expect(await openSlotIds()).not.toContain(b);

    expect((await customer.agent.post(`/api/bookings/${bookingId}/cancel`).send({ reason: "Plans changed" })).status).toBe(200);
    expect((await customer.agent.get(`/api/bookings/${bookingId}`)).body.booking.status).toBe("CANCELLED");
    expect(await openSlotIds()).toContain(b);
    expect((await customer.agent.post(`/api/bookings/${bookingId}/cancel`)).status).toBe(409);
  });

  it("rejects invalid status transitions", async () => {
    const customer = await registerAgent();
    const [slotId] = await openSlotIds();
    const bookingId = (await customer.agent.post("/api/bookings").send({ slotId })).body.booking.id as string;
    expect((await admin.agent.patch(`/api/admin/bookings/${bookingId}`).send({ status: "REJECTED" })).status).toBe(200);
    expect((await admin.agent.patch(`/api/admin/bookings/${bookingId}`).send({ status: "CONFIRMED" })).status).toBe(409);
  });
});

describe("admin operations", () => {
  it("reports metrics from real data", async () => {
    const res = await admin.agent.get("/api/admin/metrics");
    expect(res.body.astrologers.active).toBe(1);
    expect(res.body.bookings.completed).toBe(1);
    expect(res.body.users.total).toBe(await prisma.user.count());
  });

  it("grants report access and records it in the audit log", async () => {
    const customer = await registerAgent();
    const product = await prisma.reportProduct.findFirstOrThrow({ where: { slug: "career-education" } });
    const res = await admin.agent
      .post("/api/admin/grants")
      .send({ userEmail: customer.email, productId: product.id, usesRemaining: 1, reason: "Launch preview" });
    expect(res.status).toBe(201);
    expect((await customer.agent.get("/api/reports/entitlements")).body.items).toHaveLength(1);
    const logs = await admin.agent.get("/api/admin/audit-logs?action=admin.grant");
    expect(logs.body.items.length).toBeGreaterThan(0);
  });

  it("suspends a user, which ends their sessions immediately", async () => {
    const target = await registerAgent();
    expect((await admin.agent.patch(`/api/admin/users/${target.user.id}`).send({ status: "SUSPENDED" })).status).toBe(200);
    expect((await target.agent.get("/api/auth/me")).status).toBe(401);
  });

  it("deletes an account only after the user requested deletion", async () => {
    const target = await registerAgent();
    expect((await admin.agent.delete(`/api/admin/users/${target.user.id}`)).status).toBe(409);
    await target.agent.post("/api/users/me/deletion-request");
    expect((await admin.agent.delete(`/api/admin/users/${target.user.id}`)).status).toBe(204);
    expect(await prisma.user.findUnique({ where: { id: target.user.id } })).toBeNull();
  });

  it("publishes horoscope content that becomes publicly visible", async () => {
    const date = new Date().toISOString().slice(0, 10);
    const res = await admin.agent
      .put("/api/admin/horoscopes")
      .send({ sign: 5, period: "DAILY", date, language: "EN", content: "A steady day for focused work and honest conversations.", status: "PUBLISHED" });
    expect(res.status).toBe(200);
    const pub = await request(app).get(`/api/content/horoscopes?period=DAILY&sign=5&date=${date}`);
    expect(pub.body.items).toHaveLength(1);
  });
});
