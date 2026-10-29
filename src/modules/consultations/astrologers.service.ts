import type { Prisma } from "../../generated/prisma/client.js";
import { notFound } from "../../lib/errors.js";
import { jsonList } from "../../lib/json.js";
import { containsText, prisma } from "../../lib/prisma.js";

export type AstrologerFilters = {
  q?: string;
  specialization?: string;
  language?: "EN" | "HI";
  maxFee?: number;
  minRating?: number;
  available?: boolean;
};

const publicSelect = {
  id: true,
  slug: true,
  displayName: true,
  photoUrl: true,
  bio: true,
  languages: true,
  qualifications: true,
  experienceYears: true,
  credentialsVerifiedAt: true,
  consultationMinutes: true,
  feeMinor: true,
  currency: true,
  specializations: { select: { specialization: { select: { slug: true, name: true } } } },
} as const;

type Row = Prisma.AstrologerGetPayload<{ select: typeof publicSelect }>;

/** Ratings come only from published reviews of completed consultations. */
async function ratingsFor(ids: string[]) {
  if (ids.length === 0) return new Map<string, { average: number; count: number }>();
  const groups = await prisma.consultationReview.groupBy({
    by: ["astrologerId"],
    where: { astrologerId: { in: ids }, isPublished: true },
    _avg: { rating: true },
    _count: { _all: true },
  });
  return new Map(groups.map((g) => [g.astrologerId, { average: Math.round((g._avg.rating ?? 0) * 10) / 10, count: g._count._all }]));
}

function present(a: Row, rating?: { average: number; count: number }) {
  const verified = a.credentialsVerifiedAt !== null;
  return {
    ...a,
    languages: jsonList(a.languages),
    // Unverified credentials are never shown publicly.
    qualifications: verified ? jsonList(a.qualifications) : [],
    experienceYears: verified ? a.experienceYears : null,
    credentialsVerified: verified,
    credentialsVerifiedAt: undefined,
    specializations: a.specializations.map((s) => s.specialization),
    rating: rating ?? { average: null, count: 0 },
  };
}

export async function listAstrologers(f: AstrologerFilters) {
  const now = new Date();
  const rows = await prisma.astrologer.findMany({
    where: {
      isActive: true,
      ...(f.q && {
        OR: [
          { displayName: containsText(f.q) },
          { bio: containsText(f.q) },
          { specializations: { some: { specialization: { name: containsText(f.q) } } } },
        ],
      }),
      ...(f.specialization && { specializations: { some: { specialization: { slug: f.specialization } } } }),
      ...(f.maxFee !== undefined && { feeMinor: { lte: f.maxFee } }),
      ...(f.available && { slots: { some: { status: "OPEN", startsAt: { gt: now }, bookings: { none: { status: { in: ["PENDING", "CONFIRMED", "RESCHEDULE_REQUESTED"] } } } } } }),
    },
    select: publicSelect,
    orderBy: { displayName: "asc" },
    take: 100,
  });
  const ratings = await ratingsFor(rows.map((r) => r.id));
  return rows
    .map((r) => present(r, ratings.get(r.id)))
    // Languages are a JSON list, so the language filter runs here (the directory is small).
    .filter((r) => !f.language || r.languages.includes(f.language))
    .filter((r) => f.minRating === undefined || (r.rating.average !== null && r.rating.average >= f.minRating));
}

export async function getAstrologer(slug: string) {
  const a = await prisma.astrologer.findFirst({ where: { slug, isActive: true }, select: publicSelect });
  if (!a) throw notFound("Astrologer not found");
  const ratings = await ratingsFor([a.id]);
  const reviews = await prisma.consultationReview.findMany({
    where: { astrologerId: a.id, isPublished: true },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: { rating: true, comment: true, createdAt: true, user: { select: { name: true } } },
  });
  return {
    ...present(a, ratings.get(a.id)),
    // Reviewer shown by first name only.
    reviews: reviews.map((r) => ({ rating: r.rating, comment: r.comment, createdAt: r.createdAt, reviewer: r.user.name.split(" ")[0] })),
  };
}

/** Open, unbooked future slots for an astrologer within a window. */
export async function openSlots(slug: string, from: Date, to: Date) {
  const a = await prisma.astrologer.findFirst({ where: { slug, isActive: true }, select: { id: true } });
  if (!a) throw notFound("Astrologer not found");
  const start = from > new Date() ? from : new Date();
  return prisma.availabilitySlot.findMany({
    where: {
      astrologerId: a.id,
      status: "OPEN",
      startsAt: { gt: start, lt: to },
      bookings: { none: { status: { in: ["PENDING", "CONFIRMED", "RESCHEDULE_REQUESTED"] } } },
    },
    orderBy: { startsAt: "asc" },
    select: { id: true, startsAt: true, endsAt: true },
  });
}

export const listSpecializations = () => prisma.specialization.findMany({ orderBy: { name: "asc" }, select: { slug: true, name: true } });
