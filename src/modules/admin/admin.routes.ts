// Admin API. Every route requires the ADMIN role server-side; sensitive actions are audited.
import { Router } from "express";
import { z } from "zod";
import { audit } from "../../lib/audit.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { paged, paginationSchema, toSkipTake, type Pagination } from "../../lib/pagination.js";
import { containsText, prisma } from "../../lib/prisma.js";
import { currentUser, requireRole } from "../../middleware/auth.js";
import { validate } from "../../middleware/validate.js";
import { SETTINGS, listSettings, type SettingKey } from "../../lib/settings.js";
import { orderSelect, refundPayment } from "../../payments/payments.service.js";
import { LIVE_STATUSES, createPlan } from "../../payments/subscriptions.service.js";
import { retryReport } from "../../reports/reports.service.js";
import { decideBooking } from "../consultations/bookings.service.js";
import { createSlots, slotsInput } from "../consultations/slots.service.js";
import { periodStart } from "../content/content.routes.js";

export const adminRouter = Router();
adminRouter.use(requireRole("ADMIN"));

const id = z.string().min(1).max(40);
const idParams = z.object({ id });
const actor = (req: import("express").Request) => currentUser(req).userId;

// ── Metrics ───────────────────────────────────────────────────
adminRouter.get("/metrics", async (_req, res) => {
  const weekAgo = new Date(Date.now() - 7 * 86_400_000);
  const [
    totalUsers,
    newUsers,
    activeAstrologers,
    pendingReports,
    generatedReports,
    failedReports,
    pendingBookings,
    confirmedBookings,
    completedBookings,
    newContacts,
    deletionRequests,
    recentActivity,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { createdAt: { gte: weekAgo } } }),
    prisma.astrologer.count({ where: { isActive: true } }),
    prisma.report.count({ where: { status: { in: ["REQUESTED", "QUEUED", "GENERATING"] } } }),
    prisma.report.count({ where: { status: "READY" } }),
    prisma.report.count({ where: { status: "FAILED" } }),
    prisma.booking.count({ where: { status: { in: ["PENDING", "RESCHEDULE_REQUESTED"] } } }),
    prisma.booking.count({ where: { status: "CONFIRMED" } }),
    prisma.booking.count({ where: { status: "COMPLETED" } }),
    prisma.contactMessage.count({ where: { status: "NEW" } }),
    prisma.user.count({ where: { status: "DELETION_REQUESTED" } }),
    prisma.auditLog.findMany({
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { id: true, action: true, entityType: true, createdAt: true, actor: { select: { name: true } } },
    }),
  ]);

  // Daily series for the last 30 days, grouped in code so the query is the same on SQLite and PostgreSQL.
  const since = new Date(Date.now() - 30 * 86_400_000);
  const dayOf = (d: Date) => d.toISOString().slice(0, 10);
  const [signups, captured] = await Promise.all([
    prisma.user.findMany({ where: { createdAt: { gte: since } }, select: { createdAt: true } }),
    prisma.payment.findMany({
      where: { capturedAt: { gte: since }, status: { in: ["CAPTURED", "PARTIALLY_REFUNDED", "REFUNDED"] } },
      select: { capturedAt: true, amountMinor: true, order: { select: { purpose: true } } },
    }),
  ]);
  const signupsByDay = new Map<string, number>();
  for (const u of signups) signupsByDay.set(dayOf(u.createdAt), (signupsByDay.get(dayOf(u.createdAt)) ?? 0) + 1);
  const series = [...signupsByDay.entries()].sort(([x], [y]) => x.localeCompare(y)).map(([day, count]) => ({ day, count }));
  const revenueByKey = new Map<string, { day: string; purpose: string; grossMinor: number }>();
  for (const p of captured) {
    const key = `${dayOf(p.capturedAt!)}|${p.order.purpose}`;
    const row = revenueByKey.get(key) ?? { day: dayOf(p.capturedAt!), purpose: p.order.purpose, grossMinor: 0 };
    row.grossMinor += p.amountMinor;
    revenueByKey.set(key, row);
  }
  const revenueRows = [...revenueByKey.values()].sort((x, y) => x.day.localeCompare(y.day));
  const [refunds30d, commission30d, activeSubscriptions] = await Promise.all([
    prisma.refund.aggregate({ where: { createdAt: { gte: new Date(Date.now() - 30 * 86_400_000) }, status: { not: "FAILED" } }, _sum: { amountMinor: true } }),
    prisma.astrologerEarning.aggregate({ where: { createdAt: { gte: new Date(Date.now() - 30 * 86_400_000) } }, _sum: { commissionMinor: true } }),
    prisma.subscription.count({ where: { status: "ACTIVE" } }),
  ]);
  const byPurpose = { REPORT: 0, CONSULTATION: 0, SUBSCRIPTION: 0 } as Record<string, number>;
  for (const r of revenueRows) byPurpose[r.purpose] = (byPurpose[r.purpose] ?? 0) + r.grossMinor;
  const gross30d = Object.values(byPurpose).reduce((a, b) => a + b, 0);

  res.json({
    users: { total: totalUsers, newThisWeek: newUsers, deletionRequests },
    astrologers: { active: activeAstrologers },
    reports: { pending: pendingReports, generated: generatedReports, failed: failedReports },
    bookings: { pending: pendingBookings, confirmed: confirmedBookings, completed: completedBookings },
    contacts: { new: newContacts },
    registrations: series,
    revenue: {
      gross30dMinor: gross30d,
      refunded30dMinor: refunds30d._sum.amountMinor ?? 0,
      net30dMinor: gross30d - (refunds30d._sum.amountMinor ?? 0),
      consultationCommission30dMinor: commission30d._sum.commissionMinor ?? 0,
      byPurpose30dMinor: byPurpose,
      activeSubscriptions,
      daily: revenueRows,
    },
    recentActivity,
  });
});

// ── Users ─────────────────────────────────────────────────────
const adminUserSelect = {
  id: true,
  email: true,
  name: true,
  role: true,
  status: true,
  emailVerifiedAt: true,
  createdAt: true,
  lastLoginAt: true,
  deletionRequestedAt: true,
  _count: { select: { birthProfiles: true, reports: true, bookings: true } },
} as const;

adminRouter.get(
  "/users",
  validate({
    query: paginationSchema.extend({
      q: z.string().trim().max(100).optional(),
      role: z.enum(["USER", "ASTROLOGER", "ADMIN"]).optional(),
      status: z.enum(["ACTIVE", "SUSPENDED", "DELETION_REQUESTED"]).optional(),
    }),
  }),
  async (_req, res) => {
    const q = res.locals.query as Pagination & { q?: string; role?: "USER" | "ASTROLOGER" | "ADMIN"; status?: "ACTIVE" | "SUSPENDED" | "DELETION_REQUESTED" };
    const where = {
      ...(q.q && { OR: [{ email: containsText(q.q) }, { name: containsText(q.q) }] }),
      ...(q.role && { role: q.role }),
      ...(q.status && { status: q.status }),
    };
    const [items, total] = await Promise.all([
      prisma.user.findMany({ where, orderBy: { createdAt: "desc" }, select: adminUserSelect, ...toSkipTake(q) }),
      prisma.user.count({ where }),
    ]);
    res.json(paged(items, total, q));
  },
);

adminRouter.get("/users/:id", validate({ params: idParams }), async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.params.id as string }, select: adminUserSelect });
  if (!user) throw notFound("User not found");
  res.json({ user });
});

adminRouter.patch(
  "/users/:id",
  validate({
    params: idParams,
    body: z.object({ status: z.enum(["ACTIVE", "SUSPENDED"]).optional(), role: z.enum(["USER", "ASTROLOGER", "ADMIN"]).optional() }),
  }),
  async (req, res) => {
    const targetId = req.params.id as string;
    if (targetId === actor(req) && (req.body.role || req.body.status === "SUSPENDED")) {
      throw badRequest("You cannot change your own role or suspend yourself");
    }
    const before = await prisma.user.findUnique({ where: { id: targetId }, select: { role: true, status: true } });
    if (!before) throw notFound("User not found");
    const user = await prisma.$transaction(async (tx) => {
      const u = await tx.user.update({ where: { id: targetId }, data: req.body, select: adminUserSelect });
      // Role or suspension changes end existing sessions.
      await tx.refreshSession.updateMany({ where: { userId: targetId, revokedAt: null }, data: { revokedAt: new Date() } });
      await audit({ actorId: actor(req), action: "admin.user_updated", entityType: "User", entityId: targetId, metadata: { before, after: req.body } }, tx);
      return u;
    });
    res.json({ user });
  },
);

/** Completes a user's deletion request: removes the account and all personal data. */
adminRouter.delete("/users/:id", validate({ params: idParams }), async (req, res) => {
  const target = await prisma.user.findUnique({ where: { id: req.params.id as string } });
  if (!target) throw notFound("User not found");
  if (target.status !== "DELETION_REQUESTED") throw conflict("Only accounts with a deletion request can be deleted");
  if (target.id === actor(req)) throw badRequest("You cannot delete your own account here");
  await prisma.$transaction(async (tx) => {
    await audit({ actorId: actor(req), action: "admin.user_deleted", entityType: "User", entityId: target.id }, tx);
    await tx.user.delete({ where: { id: target.id } });
  });
  res.status(204).end();
});

// ── Astrologers ───────────────────────────────────────────────
const astrologerInput = z.object({
  displayName: z.string().trim().min(2).max(80),
  slug: z.string().regex(/^[a-z0-9-]{3,60}$/, "Use lowercase letters, numbers and hyphens"),
  bio: z.string().trim().min(20).max(4000),
  photoUrl: z.url().max(500).nullish(),
  languages: z.array(z.enum(["EN", "HI"])).min(1),
  qualifications: z.array(z.string().trim().min(2).max(200)).max(20).default([]),
  experienceYears: z.number().int().min(0).max(80).nullish(),
  consultationMinutes: z.number().int().min(10).max(180).default(30),
  feeMinor: z.number().int().min(0).nullish(),
  commissionRateBps: z.number().int().min(0).max(10_000).nullish(),
  specializationSlugs: z.array(z.string().max(60)).default([]),
  userEmail: z.email().nullish(),
});

async function linkUser(email: string | null | undefined) {
  if (!email) return null;
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  if (!user) throw badRequest("No user account exists with that email");
  return user;
}

adminRouter.get("/astrologers", async (_req, res) => {
  const items = await prisma.astrologer.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      specializations: { select: { specialization: { select: { slug: true, name: true } } } },
      user: { select: { email: true } },
      _count: { select: { bookings: true, slots: true } },
    },
  });
  res.json({ items });
});

adminRouter.post("/astrologers", validate({ body: astrologerInput }), async (req, res) => {
  const { specializationSlugs, userEmail, ...data } = req.body as z.infer<typeof astrologerInput>;
  const user = await linkUser(userEmail);
  const specs = await prisma.specialization.findMany({ where: { slug: { in: specializationSlugs } } });
  const created = await prisma.$transaction(async (tx) => {
    const a = await tx.astrologer.create({
      data: {
        ...data,
        userId: user?.id ?? null,
        specializations: { create: specs.map((s) => ({ specializationId: s.id })) },
      },
    });
    if (user && user.role === "USER") await tx.user.update({ where: { id: user.id }, data: { role: "ASTROLOGER" } });
    await audit({ actorId: actor(req), action: "admin.astrologer_created", entityType: "Astrologer", entityId: a.id }, tx);
    return a;
  });
  res.status(201).json({ astrologer: created });
});

adminRouter.put("/astrologers/:id", validate({ params: idParams, body: astrologerInput }), async (req, res) => {
  const { specializationSlugs, userEmail, ...data } = req.body as z.infer<typeof astrologerInput>;
  const user = await linkUser(userEmail);
  const specs = await prisma.specialization.findMany({ where: { slug: { in: specializationSlugs } } });
  const astrologerId = req.params.id as string;
  const updated = await prisma.$transaction(async (tx) => {
    await tx.astrologerSpecialization.deleteMany({ where: { astrologerId } });
    const a = await tx.astrologer.update({
      where: { id: astrologerId },
      data: { ...data, userId: user?.id ?? null, specializations: { create: specs.map((s) => ({ specializationId: s.id })) } },
    });
    if (user && user.role === "USER") await tx.user.update({ where: { id: user.id }, data: { role: "ASTROLOGER" } });
    await audit({ actorId: actor(req), action: "admin.astrologer_updated", entityType: "Astrologer", entityId: a.id }, tx);
    return a;
  });
  res.json({ astrologer: updated });
});

adminRouter.post(
  "/astrologers/:id/status",
  validate({ params: idParams, body: z.object({ isActive: z.boolean().optional(), credentialsVerified: z.boolean().optional() }) }),
  async (req, res) => {
    const a = await prisma.astrologer.update({
      where: { id: req.params.id as string },
      data: {
        ...(req.body.isActive !== undefined && { isActive: req.body.isActive }),
        ...(req.body.credentialsVerified !== undefined && { credentialsVerifiedAt: req.body.credentialsVerified ? new Date() : null }),
      },
    });
    await audit({ actorId: actor(req), action: "admin.astrologer_status", entityType: "Astrologer", entityId: a.id, metadata: req.body });
    res.json({ astrologer: a });
  },
);

adminRouter.post("/astrologers/:id/slots", validate({ params: idParams, body: slotsInput }), async (req, res) => {
  res.status(201).json(await createSlots(req.params.id as string, req.body));
});

adminRouter.delete("/slots/:id", validate({ params: idParams }), async (req, res) => {
  const active = await prisma.booking.count({ where: { slotId: req.params.id as string, status: { in: ["PENDING", "CONFIRMED", "RESCHEDULE_REQUESTED"] } } });
  if (active) throw conflict("This slot has an active booking");
  await prisma.availabilitySlot.update({ where: { id: req.params.id as string }, data: { status: "BLOCKED" } });
  res.status(204).end();
});

// ── Reports ───────────────────────────────────────────────────
adminRouter.get("/report-products", async (_req, res) => {
  res.json({ items: await prisma.reportProduct.findMany({ orderBy: { sortOrder: "asc" }, include: { template: true } }) });
});

adminRouter.patch(
  "/report-products/:id",
  validate({
    params: idParams,
    body: z.object({
      title: z.string().trim().min(3).max(120).optional(),
      description: z.string().trim().min(10).max(1000).optional(),
      contents: z.array(z.string().trim().min(2).max(200)).max(20).optional(),
      indicativePriceMinor: z.number().int().min(0).nullish(),
      isActive: z.boolean().optional(),
      sortOrder: z.number().int().optional(),
    }),
  }),
  async (req, res) => {
    const product = await prisma.reportProduct.update({ where: { id: req.params.id as string }, data: req.body });
    await audit({ actorId: actor(req), action: "admin.report_product_updated", entityType: "ReportProduct", entityId: product.id, metadata: req.body });
    res.json({ product });
  },
);

adminRouter.get(
  "/reports",
  validate({ query: paginationSchema.extend({ status: z.enum(["REQUESTED", "QUEUED", "GENERATING", "READY", "FAILED"]).optional() }) }),
  async (_req, res) => {
    const q = res.locals.query as Pagination & { status?: "REQUESTED" | "QUEUED" | "GENERATING" | "READY" | "FAILED" };
    const where = q.status ? { status: q.status } : {};
    const [items, total] = await Promise.all([
      prisma.report.findMany({
        where,
        orderBy: { createdAt: "desc" },
        ...toSkipTake(q),
        select: {
          id: true,
          status: true,
          createdAt: true,
          generatedAt: true,
          errorMessage: true,
          user: { select: { email: true, name: true } },
          product: { select: { title: true } },
          jobs: { orderBy: { attempt: "desc" }, take: 1, select: { attempt: true, status: true, lastError: true } },
        },
      }),
      prisma.report.count({ where }),
    ]);
    res.json(paged(items, total, q));
  },
);

adminRouter.post("/reports/:id/retry", validate({ params: idParams }), async (req, res) => {
  await retryReport(req.params.id as string);
  await audit({ actorId: actor(req), action: "admin.report_retry", entityType: "Report", entityId: req.params.id as string });
  res.json({ ok: true });
});

adminRouter.get("/grants", validate({ query: paginationSchema }), async (_req, res) => {
  const q = res.locals.query as Pagination;
  const [items, total] = await Promise.all([
    prisma.reportAccessGrant.findMany({
      orderBy: { createdAt: "desc" },
      ...toSkipTake(q),
      include: { user: { select: { email: true } }, product: { select: { title: true } }, grantedBy: { select: { email: true } } },
    }),
    prisma.reportAccessGrant.count(),
  ]);
  res.json(paged(items, total, q));
});

adminRouter.post(
  "/grants",
  validate({
    body: z.object({
      userEmail: z.email(),
      productId: id,
      usesRemaining: z.number().int().min(1).max(100).nullable().default(1),
      expiresAt: z.iso.datetime({ offset: true }).nullish(),
      reason: z.string().trim().min(3).max(300),
    }),
  }),
  async (req, res) => {
    const user = await prisma.user.findUnique({ where: { email: (req.body.userEmail as string).toLowerCase() } });
    if (!user) throw badRequest("No user account exists with that email");
    const grant = await prisma.reportAccessGrant.create({
      data: {
        userId: user.id,
        productId: req.body.productId,
        source: "ADMIN_GRANT",
        reason: req.body.reason,
        grantedById: actor(req),
        usesRemaining: req.body.usesRemaining,
        expiresAt: req.body.expiresAt ? new Date(req.body.expiresAt) : null,
      },
    });
    await audit({ actorId: actor(req), action: "admin.grant_created", entityType: "ReportAccessGrant", entityId: grant.id });
    res.status(201).json({ grant });
  },
);

adminRouter.post("/grants/:id/revoke", validate({ params: idParams }), async (req, res) => {
  await prisma.reportAccessGrant.update({ where: { id: req.params.id as string }, data: { revokedAt: new Date() } });
  await audit({ actorId: actor(req), action: "admin.grant_revoked", entityType: "ReportAccessGrant", entityId: req.params.id as string });
  res.json({ ok: true });
});

// ── Bookings ──────────────────────────────────────────────────
adminRouter.get(
  "/bookings",
  validate({
    query: paginationSchema.extend({
      status: z.enum(["PENDING", "CONFIRMED", "REJECTED", "CANCELLED", "RESCHEDULE_REQUESTED", "COMPLETED"]).optional(),
      astrologerId: id.optional(),
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    }),
  }),
  async (_req, res) => {
    const q = res.locals.query as Pagination & { status?: string; astrologerId?: string; from?: string; to?: string };
    const where = {
      ...(q.status && { status: q.status as "PENDING" }),
      ...(q.astrologerId && { astrologerId: q.astrologerId }),
      ...((q.from || q.to) && {
        startsAt: { ...(q.from && { gte: new Date(`${q.from}T00:00:00Z`) }), ...(q.to && { lt: new Date(`${q.to}T23:59:59Z`) }) },
      }),
    };
    const [items, total] = await Promise.all([
      prisma.booking.findMany({
        where,
        orderBy: { startsAt: "asc" },
        ...toSkipTake(q),
        include: {
          user: { select: { name: true, email: true } },
          astrologer: { select: { displayName: true, feeMinor: true } },
          paymentOrder: { select: { status: true, amountMinor: true } },
        },
      }),
      prisma.booking.count({ where }),
    ]);
    res.json(paged(items, total, q));
  },
);

adminRouter.patch(
  "/bookings/:id",
  validate({
    params: idParams,
    body: z.object({
      status: z.enum(["CONFIRMED", "REJECTED", "COMPLETED", "CANCELLED"]),
      note: z.string().trim().max(1000).optional(),
      meetingLink: z.url().max(500).nullish(),
    }),
  }),
  async (req, res) => {
    const me = currentUser(req);
    res.json({ booking: await decideBooking({ userId: me.userId, role: me.role }, req.params.id as string, req.body) });
  },
);

// ── Content ───────────────────────────────────────────────────
const contentStatus = z.enum(["DRAFT", "PUBLISHED", "ARCHIVED"]);
const language = z.enum(["EN", "HI"]);

adminRouter.get(
  "/horoscopes",
  validate({ query: z.object({ period: z.enum(["DAILY", "WEEKLY", "MONTHLY"]).default("DAILY"), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), language: language.default("EN") }) }),
  async (_req, res) => {
    const q = res.locals.query as { period: "DAILY" | "WEEKLY" | "MONTHLY"; date: string; language: "EN" | "HI" };
    const start = periodStart(q.period, q.date);
    const items = await prisma.horoscopeContent.findMany({ where: { period: q.period, periodStart: start, language: q.language }, orderBy: { sign: "asc" } });
    res.json({ periodStart: start.toISOString().slice(0, 10), items });
  },
);

adminRouter.put(
  "/horoscopes",
  validate({
    body: z.object({
      sign: z.number().int().min(1).max(12),
      period: z.enum(["DAILY", "WEEKLY", "MONTHLY"]),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      language,
      content: z.string().trim().min(20).max(4000),
      status: contentStatus,
    }),
  }),
  async (req, res) => {
    const b = req.body;
    const start = periodStart(b.period, b.date);
    const key = { sign: b.sign, period: b.period, periodStart: start, language: b.language };
    const row = await prisma.horoscopeContent.upsert({
      where: { sign_period_periodStart_language: key },
      update: { content: b.content, status: b.status, authorId: actor(req) },
      create: { ...key, content: b.content, status: b.status, authorId: actor(req) },
    });
    res.json({ horoscope: row });
  },
);

const faqInput = z.object({
  category: z.string().trim().min(2).max(40),
  question: z.string().trim().min(5).max(300),
  answer: z.string().trim().min(5).max(4000),
  language,
  sortOrder: z.number().int().default(0),
  status: contentStatus,
});
adminRouter.get("/faqs", async (_req, res) => res.json({ items: await prisma.faqItem.findMany({ orderBy: [{ category: "asc" }, { sortOrder: "asc" }] }) }));
adminRouter.post("/faqs", validate({ body: faqInput }), async (req, res) => res.status(201).json({ faq: await prisma.faqItem.create({ data: req.body }) }));
adminRouter.put("/faqs/:id", validate({ params: idParams, body: faqInput }), async (req, res) =>
  res.json({ faq: await prisma.faqItem.update({ where: { id: req.params.id as string }, data: req.body }) }),
);
adminRouter.delete("/faqs/:id", validate({ params: idParams }), async (req, res) => {
  await prisma.faqItem.delete({ where: { id: req.params.id as string } });
  res.status(204).end();
});

const bannerInput = z.object({
  title: z.string().trim().min(2).max(120),
  body: z.string().trim().max(500).nullish(),
  linkUrl: z.string().max(300).nullish(),
  language,
  status: contentStatus,
  startsAt: z.iso.datetime({ offset: true }).nullish(),
  endsAt: z.iso.datetime({ offset: true }).nullish(),
});
const bannerData = (b: z.infer<typeof bannerInput>) => ({
  ...b,
  startsAt: b.startsAt ? new Date(b.startsAt) : null,
  endsAt: b.endsAt ? new Date(b.endsAt) : null,
});
adminRouter.get("/banners", async (_req, res) => res.json({ items: await prisma.banner.findMany({ orderBy: { createdAt: "desc" } }) }));
adminRouter.post("/banners", validate({ body: bannerInput }), async (req, res) => res.status(201).json({ banner: await prisma.banner.create({ data: bannerData(req.body) }) }));
adminRouter.put("/banners/:id", validate({ params: idParams, body: bannerInput }), async (req, res) =>
  res.json({ banner: await prisma.banner.update({ where: { id: req.params.id as string }, data: bannerData(req.body) }) }),
);
adminRouter.delete("/banners/:id", validate({ params: idParams }), async (req, res) => {
  await prisma.banner.delete({ where: { id: req.params.id as string } });
  res.status(204).end();
});

const articleInput = z.object({
  slug: z.string().regex(/^[a-z0-9-]{3,100}$/),
  title: z.string().trim().min(3).max(200),
  excerpt: z.string().trim().max(500).nullish(),
  body: z.string().trim().min(20).max(50_000),
  language,
  status: contentStatus,
});
adminRouter.get("/articles", async (_req, res) => res.json({ items: await prisma.article.findMany({ orderBy: { updatedAt: "desc" } }) }));
adminRouter.post("/articles", validate({ body: articleInput }), async (req, res) =>
  res.status(201).json({ article: await prisma.article.create({ data: { ...req.body, publishedAt: req.body.status === "PUBLISHED" ? new Date() : null } }) }),
);
adminRouter.put("/articles/:id", validate({ params: idParams, body: articleInput }), async (req, res) => {
  const existing = await prisma.article.findUnique({ where: { id: req.params.id as string } });
  if (!existing) throw notFound("Article not found");
  const publishedAt = req.body.status === "PUBLISHED" ? (existing.publishedAt ?? new Date()) : existing.publishedAt;
  res.json({ article: await prisma.article.update({ where: { id: existing.id }, data: { ...req.body, publishedAt } }) });
});

adminRouter.delete("/articles/:id", validate({ params: idParams }), async (req, res) => {
  await prisma.article.delete({ where: { id: req.params.id as string } });
  await audit({ actorId: actor(req), action: "admin.article_deleted", entityType: "Article", entityId: req.params.id as string });
  res.status(204).end();
});

adminRouter.get("/seo", async (_req, res) => res.json({ items: await prisma.seoMetadata.findMany({ orderBy: { path: "asc" } }) }));
adminRouter.put(
  "/seo",
  validate({ body: z.object({ path: z.string().regex(/^\/[\w\-/]*$/).max(200), title: z.string().min(3).max(70), description: z.string().min(10).max(170), ogImageUrl: z.url().nullish() }) }),
  async (req, res) => {
    const { path, ...data } = req.body;
    res.json({ seo: await prisma.seoMetadata.upsert({ where: { path }, update: data, create: { path, ...data } }) });
  },
);

adminRouter.delete("/seo", validate({ query: z.object({ path: z.string().regex(/^\/[\w\-/]*$/).max(200) }) }), async (_req, res) => {
  await prisma.seoMetadata.deleteMany({ where: { path: (res.locals.query as { path: string }).path } });
  res.status(204).end();
});

// ── Contact messages ──────────────────────────────────────────
adminRouter.get(
  "/contacts",
  validate({ query: paginationSchema.extend({ status: z.enum(["NEW", "IN_PROGRESS", "RESOLVED", "SPAM"]).optional() }) }),
  async (_req, res) => {
    const q = res.locals.query as Pagination & { status?: "NEW" | "IN_PROGRESS" | "RESOLVED" | "SPAM" };
    const where = q.status ? { status: q.status } : {};
    const [items, total] = await Promise.all([
      prisma.contactMessage.findMany({ where, orderBy: { createdAt: "desc" }, ...toSkipTake(q), include: { respondedBy: { select: { name: true } } } }),
      prisma.contactMessage.count({ where }),
    ]);
    res.json(paged(items, total, q));
  },
);

adminRouter.patch(
  "/contacts/:id",
  validate({ params: idParams, body: z.object({ status: z.enum(["NEW", "IN_PROGRESS", "RESOLVED", "SPAM"]), response: z.string().trim().max(4000).optional() }) }),
  async (req, res) => {
    const msg = await prisma.contactMessage.update({
      where: { id: req.params.id as string },
      data: {
        status: req.body.status,
        ...(req.body.response !== undefined && { response: req.body.response, respondedById: actor(req), respondedAt: new Date() }),
      },
    });
    res.json({ message: msg });
  },
);

// ── Payments ──────────────────────────────────────────────────
adminRouter.get(
  "/payments",
  validate({
    query: paginationSchema.extend({
      status: z.enum(["CREATED", "ATTEMPTED", "PAID", "FAILED", "EXPIRED"]).optional(),
      purpose: z.enum(["REPORT", "CONSULTATION", "SUBSCRIPTION"]).optional(),
      q: z.string().trim().max(100).optional(),
    }),
  }),
  async (_req, res) => {
    const q = res.locals.query as Pagination & { status?: "PAID"; purpose?: "REPORT"; q?: string };
    const where = {
      ...(q.status ? { status: q.status } : { status: { not: "CREATED" as const } }),
      ...(q.purpose && { purpose: q.purpose }),
      ...(q.q && {
        OR: [
          { receipt: { contains: q.q } },
          { razorpayOrderId: { contains: q.q } },
          { user: { email: containsText(q.q) } },
          { payments: { some: { razorpayPaymentId: { contains: q.q } } } },
        ],
      }),
    };
    const [items, total] = await Promise.all([
      prisma.paymentOrder.findMany({
        where,
        orderBy: { createdAt: "desc" },
        ...toSkipTake(q),
        select: { ...orderSelect, razorpayOrderId: true, user: { select: { name: true, email: true } }, payments: { ...orderSelect.payments, select: { ...orderSelect.payments.select, razorpayPaymentId: true } } },
      }),
      prisma.paymentOrder.count({ where }),
    ]);
    res.json(paged(items, total, q));
  },
);

adminRouter.post(
  "/payments/:id/refund",
  validate({ params: idParams, body: z.object({ amountMinor: z.number().int().positive().optional(), reason: z.string().trim().min(3).max(300) }) }),
  async (req, res) => {
    res.status(201).json({ refund: await refundPayment({ paymentId: req.params.id as string, amountMinor: req.body.amountMinor, reason: req.body.reason, actorId: actor(req) }) });
  },
);

adminRouter.get("/webhooks", validate({ query: paginationSchema.extend({ failed: z.enum(["true", "false"]).optional() }) }), async (_req, res) => {
  const q = res.locals.query as Pagination & { failed?: "true" | "false" };
  const where = q.failed === "true" ? { processedAt: null } : {};
  const [items, total] = await Promise.all([
    prisma.webhookEvent.findMany({ where, orderBy: { createdAt: "desc" }, ...toSkipTake(q) }),
    prisma.webhookEvent.count({ where }),
  ]);
  res.json(paged(items, total, q));
});

// ── Astrologer earnings (commission) ──────────────────────────
adminRouter.get(
  "/earnings",
  validate({ query: paginationSchema.extend({ payoutStatus: z.enum(["PENDING", "ON_HOLD", "PAID"]).optional(), astrologerId: id.optional() }) }),
  async (_req, res) => {
    const q = res.locals.query as Pagination & { payoutStatus?: "PENDING" | "ON_HOLD" | "PAID"; astrologerId?: string };
    const where = { ...(q.payoutStatus && { payoutStatus: q.payoutStatus }), ...(q.astrologerId && { astrologerId: q.astrologerId }) };
    const [items, total, totals] = await Promise.all([
      prisma.astrologerEarning.findMany({
        where,
        orderBy: { createdAt: "desc" },
        ...toSkipTake(q),
        include: { astrologer: { select: { displayName: true } }, booking: { select: { startsAt: true } } },
      }),
      prisma.astrologerEarning.count({ where }),
      prisma.astrologerEarning.groupBy({ by: ["payoutStatus"], _sum: { grossMinor: true, commissionMinor: true, netMinor: true } }),
    ]);
    res.json({ ...paged(items, total, q), totals });
  },
);

adminRouter.post(
  "/earnings/:id/payout",
  validate({ params: idParams, body: z.object({ payoutStatus: z.enum(["PENDING", "ON_HOLD", "PAID"]) }) }),
  async (req, res) => {
    const earning = await prisma.astrologerEarning.update({
      where: { id: req.params.id as string },
      data: { payoutStatus: req.body.payoutStatus, paidOutAt: req.body.payoutStatus === "PAID" ? new Date() : null },
    });
    await audit({ actorId: actor(req), action: "admin.earning_payout", entityType: "AstrologerEarning", entityId: earning.id, metadata: req.body });
    res.json({ earning });
  },
);

// ── Membership plans and subscriptions ────────────────────────
adminRouter.get("/plans", async (_req, res) => {
  res.json({
    items: await prisma.subscriptionPlan.findMany({
      orderBy: [{ sortOrder: "asc" }, { amountMinor: "asc" }],
      include: { _count: { select: { subscriptions: { where: { status: { in: LIVE_STATUSES } } } } } },
    }),
  });
});

adminRouter.post(
  "/plans",
  validate({
    body: z.object({
      slug: z.string().regex(/^[a-z0-9-]{3,60}$/, "Use lowercase letters, numbers and hyphens"),
      name: z.string().trim().min(3).max(80),
      description: z.string().trim().min(10).max(500),
      features: z.array(z.string().trim().min(2).max(200)).max(12).default([]),
      amountMinor: z.number().int().min(100),
      interval: z.enum(["MONTHLY", "YEARLY"]),
      reportCredits: z.number().int().min(0).max(50),
      sortOrder: z.number().int().default(0),
    }),
  }),
  async (req, res) => {
    res.status(201).json({ plan: await createPlan(actor(req), req.body) });
  },
);

adminRouter.patch(
  "/plans/:id",
  validate({
    params: idParams,
    // Price and interval are fixed at Razorpay; create a new plan to change them.
    body: z.object({
      name: z.string().trim().min(3).max(80).optional(),
      description: z.string().trim().min(10).max(500).optional(),
      features: z.array(z.string().trim().min(2).max(200)).max(12).optional(),
      reportCredits: z.number().int().min(0).max(50).optional(),
      isActive: z.boolean().optional(),
      sortOrder: z.number().int().optional(),
    }),
  }),
  async (req, res) => {
    const plan = await prisma.subscriptionPlan.update({ where: { id: req.params.id as string }, data: req.body });
    await audit({ actorId: actor(req), action: "admin.plan_updated", entityType: "SubscriptionPlan", entityId: plan.id, metadata: req.body });
    res.json({ plan });
  },
);

adminRouter.get(
  "/subscriptions",
  validate({ query: paginationSchema.extend({ status: z.enum(["CREATED", "AUTHENTICATED", "ACTIVE", "PENDING", "HALTED", "CANCELLED", "COMPLETED", "EXPIRED"]).optional() }) }),
  async (_req, res) => {
    const q = res.locals.query as Pagination & { status?: "ACTIVE" };
    const where = q.status ? { status: q.status } : { status: { not: "CREATED" as const } };
    const [items, total] = await Promise.all([
      prisma.subscription.findMany({
        where,
        orderBy: { createdAt: "desc" },
        ...toSkipTake(q),
        include: { user: { select: { name: true, email: true } }, plan: { select: { name: true, amountMinor: true, interval: true } } },
      }),
      prisma.subscription.count({ where }),
    ]);
    res.json(paged(items, total, q));
  },
);

// ── Settings ──────────────────────────────────────────────────
adminRouter.get("/settings", async (_req, res) => {
  res.json({ items: await listSettings() });
});

adminRouter.put(
  "/settings/:key",
  validate({ params: z.object({ key: z.enum(Object.keys(SETTINGS) as [SettingKey, ...SettingKey[]]) }), body: z.object({ value: z.number().int() }) }),
  async (req, res) => {
    const key = req.params.key as SettingKey;
    const { min, max } = SETTINGS[key];
    if (req.body.value < min || req.body.value > max) throw badRequest(`Value must be between ${min} and ${max}`);
    await prisma.adminSetting.upsert({ where: { key }, update: { value: req.body.value }, create: { key, value: req.body.value } });
    await audit({ actorId: actor(req), action: "admin.setting_updated", entityType: "AdminSetting", entityId: key, metadata: { value: req.body.value } });
    res.json({ items: await listSettings() });
  },
);

// ── Audit logs ────────────────────────────────────────────────
adminRouter.get(
  "/audit-logs",
  validate({ query: paginationSchema.extend({ entityType: z.string().max(40).optional(), action: z.string().max(80).optional() }) }),
  async (_req, res) => {
    const q = res.locals.query as Pagination & { entityType?: string; action?: string };
    const where = { ...(q.entityType && { entityType: q.entityType }), ...(q.action && { action: { startsWith: q.action } }) };
    const [items, total] = await Promise.all([
      prisma.auditLog.findMany({ where, orderBy: { createdAt: "desc" }, ...toSkipTake(q), include: { actor: { select: { name: true, email: true } } } }),
      prisma.auditLog.count({ where }),
    ]);
    res.json(paged(items, total, q));
  },
);
