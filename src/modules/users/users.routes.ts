import { Router } from "express";
import { z } from "zod";
import { isValidTimeZone } from "../../astrology/time.js";
import { audit } from "../../lib/audit.js";
import { paged, paginationSchema, toSkipTake, type Pagination } from "../../lib/pagination.js";
import { prisma } from "../../lib/prisma.js";
import { currentUser, requireAuth } from "../../middleware/auth.js";
import { validate } from "../../middleware/validate.js";
import { publicUserSelect } from "../auth/auth.service.js";
import { serializeProfile } from "../birth-profiles/birth-profiles.service.js";

export const usersRouter = Router();
usersRouter.use(requireAuth);

usersRouter.get("/me", async (req, res) => {
  res.json({ user: await prisma.user.findUniqueOrThrow({ where: { id: currentUser(req).userId }, select: publicUserSelect }) });
});

usersRouter.patch(
  "/me",
  validate({
    body: z.object({
      name: z.string().trim().min(2).max(80).optional(),
      preferredLanguage: z.enum(["EN", "HI"]).optional(),
      timezone: z.string().refine(isValidTimeZone, "Unknown IANA time zone").optional(),
    }),
  }),
  async (req, res) => {
    const user = await prisma.user.update({ where: { id: currentUser(req).userId }, data: req.body, select: publicUserSelect });
    res.json({ user });
  },
);

usersRouter.get("/me/dashboard", async (req, res) => {
  const userId = currentUser(req).userId;
  const now = new Date();
  const [primary, latestChart, reportsReady, reportsPending, upcoming, notifications, unread, recentTools] = await Promise.all([
    prisma.birthProfile.findFirst({ where: { userId, isPrimary: true } }),
    prisma.chartCalculation.findFirst({
      where: { birthProfile: { userId } },
      // The primary profile's chart drives "today for you"; otherwise the newest chart.
      orderBy: [{ birthProfile: { isPrimary: "desc" } }, { createdAt: "desc" }],
      select: { id: true, createdAt: true, details: true, birthProfile: { select: { name: true } } },
    }),
    prisma.report.count({ where: { userId, status: "READY" } }),
    prisma.report.count({ where: { userId, status: { in: ["REQUESTED", "QUEUED", "GENERATING"] } } }),
    prisma.booking.findMany({
      where: { userId, startsAt: { gte: now }, status: { in: ["PENDING", "CONFIRMED", "RESCHEDULE_REQUESTED"] } },
      orderBy: { startsAt: "asc" },
      take: 3,
      select: { id: true, startsAt: true, endsAt: true, status: true, astrologer: { select: { displayName: true, slug: true } } },
    }),
    prisma.notification.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: 5 }),
    prisma.notification.count({ where: { userId, readAt: null } }),
    prisma.toolUsage.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: 5, select: { tool: true, createdAt: true } }),
  ]);

  res.json({
    primaryProfile: primary ? serializeProfile(primary) : null,
    latestChart: latestChart
      ? {
          id: latestChart.id,
          createdAt: latestChart.createdAt,
          profileName: latestChart.birthProfile.name,
          summary: (latestChart.details as { summary: unknown }).summary,
        }
      : null,
    reports: { ready: reportsReady, pending: reportsPending },
    upcomingBookings: upcoming,
    notifications: { recent: notifications, unread },
    recentActivity: recentTools,
  });
});

usersRouter.get("/me/notifications", validate({ query: paginationSchema }), async (req, res) => {
  const userId = currentUser(req).userId;
  const p = res.locals.query as Pagination;
  const [items, total] = await Promise.all([
    prisma.notification.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, ...toSkipTake(p) }),
    prisma.notification.count({ where: { userId } }),
  ]);
  res.json(paged(items, total, p));
});

usersRouter.post("/me/notifications/:id/read", validate({ params: z.object({ id: z.string().max(40) }) }), async (req, res) => {
  await prisma.notification.updateMany({
    where: { id: req.params.id as string, userId: currentUser(req).userId, readAt: null },
    data: { readAt: new Date() },
  });
  res.json({ ok: true });
});

usersRouter.post("/me/notifications/read-all", async (req, res) => {
  await prisma.notification.updateMany({ where: { userId: currentUser(req).userId, readAt: null }, data: { readAt: new Date() } });
  res.json({ ok: true });
});

usersRouter.get("/me/sessions", async (req, res) => {
  const me = currentUser(req);
  const sessions = await prisma.refreshSession.findMany({
    where: { userId: me.userId, revokedAt: null, expiresAt: { gt: new Date() } },
    select: { id: true, userAgent: true, createdAt: true, expiresAt: true },
    orderBy: { createdAt: "desc" },
  });
  res.json({ items: sessions.map((s) => ({ ...s, current: s.id === me.sessionId })) });
});

usersRouter.delete("/me/sessions/:id", validate({ params: z.object({ id: z.string().max(40) }) }), async (req, res) => {
  await prisma.refreshSession.updateMany({
    where: { id: req.params.id as string, userId: currentUser(req).userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  res.status(204).end();
});

/** Machine-readable export of everything stored about the caller (no secrets or hashes). */
usersRouter.get("/me/export", async (req, res) => {
  const userId = currentUser(req).userId;
  const [user, profiles, charts, reports, bookings, notifications] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: userId }, select: publicUserSelect }),
    prisma.birthProfile.findMany({ where: { userId } }),
    prisma.chartCalculation.findMany({ where: { birthProfile: { userId } }, include: { planets: true, houses: true } }),
    prisma.report.findMany({ where: { userId }, select: { id: true, status: true, createdAt: true, generatedAt: true, product: { select: { title: true } } } }),
    prisma.booking.findMany({ where: { userId }, select: { id: true, status: true, startsAt: true, endsAt: true, userNotes: true, astrologer: { select: { displayName: true } } } }),
    prisma.notification.findMany({ where: { userId } }),
  ]);
  await audit({ actorId: userId, action: "user.data_export", entityType: "User", entityId: userId });
  res.set("Content-Disposition", `attachment; filename="astroveda-export.json"`);
  res.set("Cache-Control", "no-store");
  res.json({
    exportedAt: new Date(),
    user,
    birthProfiles: profiles.map(serializeProfile),
    charts,
    reports,
    bookings,
    notifications,
  });
});

usersRouter.post("/me/deletion-request", async (req, res) => {
  const userId = currentUser(req).userId;
  await prisma.user.update({ where: { id: userId }, data: { status: "DELETION_REQUESTED", deletionRequestedAt: new Date() } });
  await audit({ actorId: userId, action: "user.deletion_requested", entityType: "User", entityId: userId });
  res.json({ ok: true });
});

usersRouter.delete("/me/deletion-request", async (req, res) => {
  const userId = currentUser(req).userId;
  await prisma.user.updateMany({
    where: { id: userId, status: "DELETION_REQUESTED" },
    data: { status: "ACTIVE", deletionRequestedAt: null },
  });
  await audit({ actorId: userId, action: "user.deletion_cancelled", entityType: "User", entityId: userId });
  res.json({ ok: true });
});
