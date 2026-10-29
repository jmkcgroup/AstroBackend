import { z } from "zod";
import type { Prisma } from "../../generated/prisma/client.js";
import { isValidTimeZone, parseDateString } from "../../astrology/time.js";
import { SUPPORTED_YEARS } from "../../astrology/ephemeris.js";
import { notFound } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";

export const birthProfileInput = z.object({
  name: z.string().trim().min(1, "Name is required").max(80),
  dateOfBirth: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
    .refine((d) => {
      try {
        const { year } = parseDateString(d);
        return year >= SUPPORTED_YEARS.min && year <= SUPPORTED_YEARS.max;
      } catch {
        return false;
      }
    }, `Enter a valid date between ${SUPPORTED_YEARS.min} and ${SUPPORTED_YEARS.max}`),
  birthTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, "Use 24-hour HH:mm"),
  birthTimeAccuracy: z.enum(["EXACT", "APPROXIMATE", "UNKNOWN"]).default("EXACT"),
  placeName: z.string().trim().min(2).max(200),
  latitude: z.coerce.number().min(-90).max(90),
  longitude: z.coerce.number().min(-180).max(180),
  timezone: z.string().refine(isValidTimeZone, "Unknown IANA time zone"),
  ayanamsha: z.enum(["LAHIRI", "RAMAN", "KRISHNAMURTI"]).default("LAHIRI"),
  notes: z.string().trim().max(1000).optional().nullable(),
  isPrimary: z.boolean().optional(),
});

export type BirthProfileInput = z.infer<typeof birthProfileInput>;

/** Serialises a profile for the API: date as YYYY-MM-DD and coordinates as numbers. */
export function serializeProfile<T extends { dateOfBirth: Date; latitude: Prisma.Decimal; longitude: Prisma.Decimal }>(p: T) {
  return {
    ...p,
    dateOfBirth: p.dateOfBirth.toISOString().slice(0, 10),
    latitude: Number(p.latitude),
    longitude: Number(p.longitude),
  };
}

const toData = (input: BirthProfileInput) => ({
  name: input.name,
  dateOfBirth: new Date(`${input.dateOfBirth}T00:00:00Z`),
  birthTime: input.birthTime,
  birthTimeAccuracy: input.birthTimeAccuracy,
  placeName: input.placeName,
  latitude: input.latitude.toFixed(6),
  longitude: input.longitude.toFixed(6),
  timezone: input.timezone,
  ayanamsha: input.ayanamsha,
  notes: input.notes ?? null,
});

/** Ownership-checked lookup: a profile that belongs to someone else is reported as not found. */
export async function getOwnedProfile(userId: string, id: string) {
  const profile = await prisma.birthProfile.findFirst({ where: { id, userId } });
  if (!profile) throw notFound("Birth profile not found");
  return profile;
}

export async function listProfiles(userId: string) {
  const rows = await prisma.birthProfile.findMany({
    where: { userId },
    orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
    include: { charts: { select: { id: true, createdAt: true, details: true }, orderBy: { createdAt: "desc" }, take: 1 } },
  });
  return rows.map(({ charts, ...p }) => ({
    ...serializeProfile(p),
    latestChartId: charts[0]?.id ?? null,
    // Lagna, Moon sign and Nakshatra for profile cards (computed when the chart was calculated).
    latestChartSummary: charts[0] ? ((charts[0].details as { summary?: unknown }).summary ?? null) : null,
  }));
}

export async function createProfile(userId: string, input: BirthProfileInput) {
  return prisma.$transaction(async (tx) => {
    const count = await tx.birthProfile.count({ where: { userId } });
    const makePrimary = input.isPrimary === true || count === 0;
    if (makePrimary) await tx.birthProfile.updateMany({ where: { userId, isPrimary: true }, data: { isPrimary: false } });
    const created = await tx.birthProfile.create({ data: { ...toData(input), userId, isPrimary: makePrimary } });
    return serializeProfile(created);
  });
}

export async function updateProfile(userId: string, id: string, input: BirthProfileInput) {
  await getOwnedProfile(userId, id);
  return prisma.$transaction(async (tx) => {
    if (input.isPrimary === true) {
      await tx.birthProfile.updateMany({ where: { userId, isPrimary: true, NOT: { id } }, data: { isPrimary: false } });
    }
    const updated = await tx.birthProfile.update({
      where: { id },
      data: { ...toData(input), ...(input.isPrimary === true && { isPrimary: true }) },
    });
    return serializeProfile(updated);
  });
}

export async function setPrimary(userId: string, id: string) {
  await getOwnedProfile(userId, id);
  await prisma.$transaction([
    prisma.birthProfile.updateMany({ where: { userId, isPrimary: true }, data: { isPrimary: false } }),
    prisma.birthProfile.update({ where: { id }, data: { isPrimary: true } }),
  ]);
}

export async function deleteProfile(userId: string, id: string) {
  const profile = await getOwnedProfile(userId, id);
  await prisma.$transaction(async (tx) => {
    await tx.birthProfile.delete({ where: { id } });
    if (profile.isPrimary) {
      const next = await tx.birthProfile.findFirst({ where: { userId }, orderBy: { createdAt: "asc" } });
      if (next) await tx.birthProfile.update({ where: { id: next.id }, data: { isPrimary: true } });
    }
  });
}
