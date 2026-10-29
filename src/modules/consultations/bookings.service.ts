// Consultation bookings. A booking is a request: it stays PENDING until the astrologer or an
// admin confirms it. Double booking is prevented by a row lock on the slot inside a transaction
// plus a partial unique index (one active booking per slot) as the last line of defence.
// Paid consultations (astrologer fee > 0) must be paid before they can be confirmed; unpaid
// requests release their slot after the configured hold time.
import type { Prisma } from "../../generated/prisma/client.js";
import type { BookingStatus, Role } from "../../generated/prisma/enums.js";
import { audit } from "../../lib/audit.js";
import { badRequest, conflict, forbidden, notFound } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import { lockRow } from "../../lib/db-lock.js";
import { prisma } from "../../lib/prisma.js";
import { getNumberSetting } from "../../lib/settings.js";
import { capturedBookingPayment, isBookingPaid, recordEarning, refundPayment } from "../../payments/payments.service.js";
import { getOwnedProfile } from "../birth-profiles/birth-profiles.service.js";
import { notify } from "../notifications/notifications.service.js";
import { ACTIVE_STATUSES } from "./booking-status.js";

export { ACTIVE_STATUSES };

const bookingSelect = {
  id: true,
  status: true,
  startsAt: true,
  endsAt: true,
  userNotes: true,
  meetingLink: true,
  cancellationReason: true,
  decidedAt: true,
  createdAt: true,
  astrologer: { select: { id: true, slug: true, displayName: true, photoUrl: true, feeMinor: true, currency: true } },
  birthProfile: { select: { id: true, name: true } },
  review: { select: { rating: true, comment: true } },
  paymentOrder: { select: { status: true, amountMinor: true } },
} as const;

/** Refunds whatever is left of a booking's payment; failures are logged for admins to retry. */
async function refundBooking(bookingId: string, reason: string, actorId: string | null) {
  const payment = await capturedBookingPayment(bookingId);
  if (!payment) return false;
  try {
    await refundPayment({ paymentId: payment.id, reason, actorId });
    return true;
  } catch (err) {
    logger.error({ err, bookingId }, "Automatic refund failed");
    await audit({ actorId, action: "payment.refund_failed", entityType: "Booking", entityId: bookingId, metadata: { reason } });
    return false;
  }
}

type Tx = Prisma.TransactionClient;

/** Locks the slot row and verifies it can be booked. */
async function lockBookableSlot(tx: Tx, slotId: string) {
  if (!(await lockRow(tx, "AvailabilitySlot", slotId))) throw notFound("This time slot does not exist");
  const slot = await tx.availabilitySlot.findUniqueOrThrow({ where: { id: slotId }, include: { astrologer: true } });
  if (slot.status !== "OPEN" || !slot.astrologer.isActive) throw conflict("This time slot is not available");
  if (slot.startsAt <= new Date()) throw conflict("This time slot has already started");
  const taken = await tx.booking.count({ where: { slotId, status: { in: ACTIVE_STATUSES } } });
  if (taken > 0) throw conflict("This time slot has just been booked by someone else");
  return slot;
}

const isUniqueViolation = (err: unknown) => (err as { code?: string }).code === "P2002";

export async function createBooking(userId: string, input: { slotId: string; notes?: string; birthProfileId?: string }) {
  if (input.birthProfileId) await getOwnedProfile(userId, input.birthProfileId);
  try {
    const booking = await prisma.$transaction(async (tx) => {
      const slot = await lockBookableSlot(tx, input.slotId);
      return tx.booking.create({
        data: {
          userId,
          astrologerId: slot.astrologerId,
          slotId: slot.id,
          startsAt: slot.startsAt,
          endsAt: slot.endsAt,
          userNotes: input.notes ?? null,
          birthProfileId: input.birthProfileId ?? null,
          status: "PENDING",
        },
        select: { ...bookingSelect, astrologer: { select: { ...bookingSelect.astrologer.select, userId: true } } },
      });
    });
    await notify(userId, {
      type: "BOOKING_REQUESTED",
      title: "Consultation request sent",
      body: `Your request with ${booking.astrologer.displayName} is pending confirmation.`,
      link: "/dashboard/bookings",
    });
    if (booking.astrologer.userId) {
      await notify(
        booking.astrologer.userId,
        { type: "BOOKING_NEW", title: "New consultation request", body: `A new request for ${booking.startsAt.toISOString()} needs your decision.`, link: "/astrologer" },
        { email: true },
      );
    }
    const { userId: _u, ...astrologer } = booking.astrologer;
    return { ...booking, astrologer };
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict("This time slot has just been booked by someone else");
    throw err;
  }
}

export async function listMyBookings(userId: string, scope: "upcoming" | "past" | "all") {
  const now = new Date();
  return prisma.booking.findMany({
    where: {
      userId,
      ...(scope === "upcoming" && { endsAt: { gte: now } }),
      ...(scope === "past" && { endsAt: { lt: now } }),
    },
    orderBy: { startsAt: scope === "past" ? "desc" : "asc" },
    select: bookingSelect,
    take: 100,
  });
}

export async function getMyBooking(userId: string, id: string) {
  const b = await prisma.booking.findFirst({ where: { id, userId }, select: bookingSelect });
  if (!b) throw notFound("Booking not found");
  return b;
}

/** Cancels the user's booking. Paid bookings are refunded in full when cancelled before the cut-off. */
export async function cancelMyBooking(userId: string, id: string, reason?: string) {
  const b = await prisma.booking.findFirst({ where: { id, userId } });
  if (!b) throw notFound("Booking not found");
  if (!ACTIVE_STATUSES.includes(b.status)) throw conflict("This booking can no longer be cancelled");
  if (b.startsAt <= new Date()) throw conflict("A consultation that has started cannot be cancelled");
  const changed = await prisma.booking.updateMany({
    where: { id, status: { in: ACTIVE_STATUSES } },
    data: { status: "CANCELLED", cancellationReason: reason ?? "Cancelled by user" },
  });
  if (changed.count !== 1) throw conflict("This booking can no longer be cancelled");
  await audit({ actorId: userId, action: "booking.cancelled_by_user", entityType: "Booking", entityId: id });

  const cutoffHours = await getNumberSetting("consultation.refundCutoffHours");
  const eligible = b.startsAt.getTime() - Date.now() >= cutoffHours * 3_600_000;
  const refunded = eligible ? await refundBooking(id, "Cancelled by the user before the refund cut-off", userId) : false;
  const paid = await isBookingPaid(id);
  return { refunded, paid, refundCutoffHours: cutoffHours };
}

/** Releases slots held by unpaid requests for paid consultations. Run periodically. */
export async function expireUnpaidBookings() {
  const holdMinutes = await getNumberSetting("consultation.unpaidHoldMinutes");
  const stale = await prisma.booking.findMany({
    where: {
      status: "PENDING",
      createdAt: { lt: new Date(Date.now() - holdMinutes * 60_000) },
      astrologer: { feeMinor: { gt: 0 } },
      OR: [{ paymentOrder: null }, { paymentOrder: { status: { not: "PAID" } } }],
    },
    select: { id: true, userId: true, astrologer: { select: { displayName: true } } },
    take: 200,
  });
  for (const b of stale) {
    const changed = await prisma.booking.updateMany({
      where: { id: b.id, status: "PENDING", OR: [{ paymentOrder: null }, { paymentOrder: { status: { not: "PAID" } } }] },
      data: { status: "CANCELLED", cancellationReason: "Payment was not completed in time" },
    });
    if (changed.count === 1) {
      await notify(b.userId, {
        type: "BOOKING_EXPIRED",
        title: "Consultation request expired",
        body: `Payment for your request with ${b.astrologer.displayName} was not completed, so the slot was released.`,
        link: "/dashboard/bookings",
      });
    }
  }
  return stale.length;
}

let sweeper: NodeJS.Timeout | null = null;
export function startBookingSweeper() {
  sweeper = setInterval(() => void expireUnpaidBookings().catch((err) => logger.error({ err }, "Unpaid booking sweep failed")), 60_000);
  sweeper.unref();
}

/** Moves an active booking to a new slot of the same astrologer; it needs confirmation again. */
export async function rescheduleMyBooking(userId: string, id: string, newSlotId: string) {
  try {
    await prisma.$transaction(async (tx) => {
      const b = await tx.booking.findFirst({ where: { id, userId } });
      if (!b) throw notFound("Booking not found");
      if (!ACTIVE_STATUSES.includes(b.status)) throw conflict("This booking can no longer be rescheduled");
      if (b.slotId === newSlotId) throw badRequest("Choose a different time slot");
      const slot = await lockBookableSlot(tx, newSlotId);
      if (slot.astrologerId !== b.astrologerId) throw badRequest("Choose a slot with the same astrologer");
      await tx.booking.update({
        where: { id },
        data: { slotId: slot.id, startsAt: slot.startsAt, endsAt: slot.endsAt, status: "RESCHEDULE_REQUESTED", decidedAt: null, decidedById: null },
      });
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict("This time slot has just been booked by someone else");
    throw err;
  }
}

const TRANSITIONS: Record<BookingStatus, BookingStatus[]> = {
  PENDING: ["CONFIRMED", "REJECTED"],
  RESCHEDULE_REQUESTED: ["CONFIRMED", "REJECTED"],
  CONFIRMED: ["COMPLETED", "CANCELLED"],
  REJECTED: [],
  CANCELLED: [],
  COMPLETED: [],
};

/** Status change by the booking's astrologer or an admin. */
export async function decideBooking(
  actor: { userId: string; role: Role },
  id: string,
  input: { status: BookingStatus; note?: string; meetingLink?: string | null },
) {
  const b = await prisma.booking.findUnique({ where: { id }, include: { astrologer: true } });
  if (!b) throw notFound("Booking not found");
  const isAdmin = actor.role === "ADMIN";
  const isOwnAstrologer = actor.role === "ASTROLOGER" && b.astrologer.userId === actor.userId;
  if (!isAdmin && !isOwnAstrologer) throw forbidden();
  if (!TRANSITIONS[b.status].includes(input.status)) {
    throw conflict(`A ${b.status.toLowerCase()} booking cannot become ${input.status.toLowerCase()}`);
  }
  if (input.status === "COMPLETED" && b.startsAt > new Date()) throw conflict("A consultation cannot be completed before it starts");
  if (input.status === "CONFIRMED" && (b.astrologer.feeMinor ?? 0) > 0 && !(await isBookingPaid(id))) {
    throw conflict("This consultation has not been paid yet");
  }

  const changed = await prisma.booking.updateMany({
    where: { id, status: b.status },
    data: {
      status: input.status,
      decidedById: actor.userId,
      decidedAt: new Date(),
      ...(input.note !== undefined && { astrologerNotes: input.note }),
      ...(input.meetingLink !== undefined && { meetingLink: input.meetingLink }),
      ...(input.status === "CANCELLED" && { cancellationReason: input.note ?? "Cancelled by astrologer" }),
    },
  });
  // Someone else changed the booking between our read and write.
  if (changed.count !== 1) throw conflict("This booking was just updated. Please refresh and try again.");
  const updated = await prisma.booking.findUniqueOrThrow({ where: { id } });
  await audit({ actorId: actor.userId, action: `booking.${input.status.toLowerCase()}`, entityType: "Booking", entityId: id });

  // Money follows the decision: declined or cancelled by the practice = full refund; completed = commission split.
  if (input.status === "REJECTED" || input.status === "CANCELLED") {
    await refundBooking(id, input.status === "REJECTED" ? "Request declined by the astrologer" : "Cancelled by the astrologer or AstroVeda", actor.userId);
  } else if (input.status === "COMPLETED") {
    await recordEarning(id);
  }

  const messages: Partial<Record<BookingStatus, [string, string]>> = {
    CONFIRMED: ["Consultation confirmed", `Your consultation with ${b.astrologer.displayName} on ${b.startsAt.toISOString()} is confirmed.`],
    REJECTED: ["Consultation request declined", `${b.astrologer.displayName} could not accept your request. Please choose another slot.`],
    CANCELLED: ["Consultation cancelled", `Your consultation with ${b.astrologer.displayName} was cancelled.`],
    COMPLETED: ["Consultation completed", `You can now leave a review for ${b.astrologer.displayName}.`],
  };
  const msg = messages[input.status];
  if (msg) await notify(b.userId, { type: `BOOKING_${input.status}`, title: msg[0], body: msg[1], link: "/dashboard/bookings" }, { email: true });
  return updated;
}

export async function reviewBooking(userId: string, id: string, input: { rating: number; comment?: string }) {
  const b = await prisma.booking.findFirst({ where: { id, userId }, include: { review: true } });
  if (!b) throw notFound("Booking not found");
  if (b.status !== "COMPLETED") throw conflict("Only completed consultations can be reviewed");
  if (b.review) throw conflict("You have already reviewed this consultation");
  return prisma.consultationReview.create({
    data: { bookingId: id, userId, astrologerId: b.astrologerId, rating: input.rating, comment: input.comment ?? null },
  });
}
