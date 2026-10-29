import { z } from "zod";
import { localToUtc, parseDateString, parseTimeString } from "../../astrology/time.js";
import { badRequest } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";

// Creates evenly spaced slots on given local dates, e.g. 10:00–13:00 in 30-minute steps.
export const slotsInput = z.object({
  dates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).min(1).max(60),
  startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  endTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  durationMinutes: z.number().int().min(10).max(180),
  timezone: z.string().default("Asia/Kolkata"),
});

export async function createSlots(astrologerId: string, input: z.infer<typeof slotsInput>) {
  const data: { astrologerId: string; startsAt: Date; endsAt: Date }[] = [];
  for (const date of input.dates) {
    const d = parseDateString(date);
    const s = parseTimeString(input.startTime);
    const e = parseTimeString(input.endTime);
    const start = localToUtc({ ...d, ...s }, input.timezone).utc.getTime();
    const end = localToUtc({ ...d, ...e }, input.timezone).utc.getTime();
    if (end <= start) throw badRequest("End time must be after start time");
    for (let t = start; t + input.durationMinutes * 60_000 <= end; t += input.durationMinutes * 60_000) {
      if (t > Date.now()) data.push({ astrologerId, startsAt: new Date(t), endsAt: new Date(t + input.durationMinutes * 60_000) });
    }
  }
  if (data.length === 0) throw badRequest("No future slots fall within that range");
  if (data.length > 500) throw badRequest("Too many slots at once (max 500)");

  // Overlap check against existing slots of this astrologer
  const first = data[0]!.startsAt;
  const last = data[data.length - 1]!.endsAt;
  const existing = await prisma.availabilitySlot.findMany({
    where: { astrologerId, startsAt: { lt: last }, endsAt: { gt: first } },
    select: { startsAt: true, endsAt: true },
  });
  const fresh = data.filter((n) => !existing.some((e) => n.startsAt < e.endsAt && n.endsAt > e.startsAt));
  const result = await prisma.availabilitySlot.createMany({ data: fresh });
  return { created: result.count, skippedOverlapping: data.length - fresh.length };
}
