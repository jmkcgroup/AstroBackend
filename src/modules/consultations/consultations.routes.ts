import { Router } from "express";
import { z } from "zod";
import { forbidden } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import { currentUser, requireAuth, requireRole } from "../../middleware/auth.js";
import { validate } from "../../middleware/validate.js";
import * as astro from "./astrologers.service.js";
import * as bookings from "./bookings.service.js";
import { createSlots, slotsInput } from "./slots.service.js";

const id = z.string().min(1).max(40);

// ── Public directory ──────────────────────────────────────────
export const astrologersRouter = Router();

astrologersRouter.get("/specializations", async (_req, res) => {
  res.json({ items: await astro.listSpecializations() });
});

astrologersRouter.get(
  "/",
  validate({
    query: z.object({
      q: z.string().trim().max(80).optional(),
      specialization: z.string().max(60).optional(),
      language: z.enum(["EN", "HI"]).optional(),
      maxFee: z.coerce.number().int().min(0).optional(),
      minRating: z.coerce.number().min(1).max(5).optional(),
      available: z.enum(["true", "false"]).transform((v) => v === "true").optional(),
    }),
  }),
  async (_req, res) => {
    res.json({ items: await astro.listAstrologers(res.locals.query as astro.AstrologerFilters) });
  },
);

astrologersRouter.get("/:slug", validate({ params: z.object({ slug: z.string().max(80) }) }), async (req, res) => {
  res.json({ astrologer: await astro.getAstrologer(req.params.slug as string) });
});

astrologersRouter.get(
  "/:slug/slots",
  validate({
    params: z.object({ slug: z.string().max(80) }),
    query: z.object({ from: z.iso.datetime({ offset: true }).optional(), days: z.coerce.number().int().min(1).max(60).default(14) }),
  }),
  async (req, res) => {
    const q = res.locals.query as { from?: string; days: number };
    const from = q.from ? new Date(q.from) : new Date();
    const to = new Date(from.getTime() + q.days * 86_400_000);
    res.json({ items: await astro.openSlots(req.params.slug as string, from, to) });
  },
);

// ── Customer bookings ─────────────────────────────────────────
export const bookingsRouter = Router();
bookingsRouter.use(requireAuth);

bookingsRouter.get("/", validate({ query: z.object({ scope: z.enum(["upcoming", "past", "all"]).default("all") }) }), async (req, res) => {
  const { scope } = res.locals.query as { scope: "upcoming" | "past" | "all" };
  res.json({ items: await bookings.listMyBookings(currentUser(req).userId, scope) });
});

bookingsRouter.post(
  "/",
  validate({ body: z.object({ slotId: id, notes: z.string().trim().max(1000).optional(), birthProfileId: id.optional() }) }),
  async (req, res) => {
    res.status(201).json({ booking: await bookings.createBooking(currentUser(req).userId, req.body) });
  },
);

bookingsRouter.get("/:id", validate({ params: z.object({ id }) }), async (req, res) => {
  res.json({ booking: await bookings.getMyBooking(currentUser(req).userId, req.params.id as string) });
});

bookingsRouter.post(
  "/:id/cancel",
  validate({ params: z.object({ id }), body: z.object({ reason: z.string().trim().max(500).optional() }).default({}) }),
  async (req, res) => {
    const result = await bookings.cancelMyBooking(currentUser(req).userId, req.params.id as string, req.body.reason);
    res.json({ ok: true, ...result });
  },
);

bookingsRouter.post("/:id/reschedule", validate({ params: z.object({ id }), body: z.object({ slotId: id }) }), async (req, res) => {
  await bookings.rescheduleMyBooking(currentUser(req).userId, req.params.id as string, req.body.slotId);
  res.json({ ok: true });
});

bookingsRouter.post(
  "/:id/review",
  validate({ params: z.object({ id }), body: z.object({ rating: z.number().int().min(1).max(5), comment: z.string().trim().max(1000).optional() }) }),
  async (req, res) => {
    res.status(201).json({ review: await bookings.reviewBooking(currentUser(req).userId, req.params.id as string, req.body) });
  },
);

// ── Astrologer workspace ──────────────────────────────────────
export const astrologerSelfRouter = Router();
astrologerSelfRouter.use(requireRole("ASTROLOGER"));

async function myAstrologerId(userId: string) {
  const a = await prisma.astrologer.findUnique({ where: { userId }, select: { id: true } });
  if (!a) throw forbidden("No astrologer profile is linked to this account");
  return a.id;
}

astrologerSelfRouter.get("/bookings", async (req, res) => {
  const astrologerId = await myAstrologerId(currentUser(req).userId);
  const items = await prisma.booking.findMany({
    where: { astrologerId },
    orderBy: { startsAt: "asc" },
    take: 200,
    select: {
      id: true,
      status: true,
      startsAt: true,
      endsAt: true,
      userNotes: true,
      astrologerNotes: true,
      meetingLink: true,
      paymentOrder: { select: { status: true, amountMinor: true } },
      user: { select: { name: true } },
      // Birth data is shared with the consulting astrologer only when the user attached a profile.
      birthProfile: { select: { name: true, dateOfBirth: true, birthTime: true, birthTimeAccuracy: true, placeName: true, timezone: true } },
    },
  });
  res.json({ items });
});

astrologerSelfRouter.patch(
  "/bookings/:id",
  validate({
    params: z.object({ id }),
    body: z.object({
      status: z.enum(["CONFIRMED", "REJECTED", "COMPLETED", "CANCELLED"]),
      note: z.string().trim().max(1000).optional(),
      meetingLink: z.url().max(500).nullish(),
    }),
  }),
  async (req, res) => {
    const me = currentUser(req);
    res.json({ booking: await bookings.decideBooking({ userId: me.userId, role: me.role }, req.params.id as string, req.body) });
  },
);

astrologerSelfRouter.get("/slots", async (req, res) => {
  const astrologerId = await myAstrologerId(currentUser(req).userId);
  const items = await prisma.availabilitySlot.findMany({
    where: { astrologerId, startsAt: { gt: new Date() } },
    orderBy: { startsAt: "asc" },
    include: { bookings: { where: { status: { in: bookings.ACTIVE_STATUSES } }, select: { id: true, status: true } } },
  });
  res.json({ items });
});

astrologerSelfRouter.post("/slots", validate({ body: slotsInput }), async (req, res) => {
  const astrologerId = await myAstrologerId(currentUser(req).userId);
  res.status(201).json(await createSlots(astrologerId, req.body));
});
