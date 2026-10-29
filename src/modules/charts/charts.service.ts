import type { Prisma } from "../../generated/prisma/client.js";
import {
  calculateChart,
  chartInputHash,
  dignityOf as dignityFor,
  METHODOLOGY,
  type ChartInput,
  type ChartResult,
} from "../../astrology/chart.js";
import { calculateTransits } from "../../astrology/transit.js";
import { INTERPRETATION_DISCLAIMER, interpretChart, type Lang } from "../../astrology/interpretation.js";
import { NAKSHATRAS, PLANET_LABELS, SIGNS } from "../../astrology/constants.js";
import { notFound } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import { getOwnedProfile } from "../birth-profiles/birth-profiles.service.js";

type ProfileRow = Awaited<ReturnType<typeof getOwnedProfile>>;

export const profileToChartInput = (p: ProfileRow): ChartInput => ({
  date: p.dateOfBirth.toISOString().slice(0, 10),
  time: p.birthTime,
  timezone: p.timezone,
  latitude: Number(p.latitude),
  longitude: Number(p.longitude),
  ayanamsha: p.ayanamsha,
  nodeType: "TRUE_NODE",
});

type StoredDetails = Pick<
  ChartResult,
  "ascendant" | "aspects" | "d1" | "d9" | "summary" | "utcOffsetMinutes" | "timeAmbiguity"
> & { methodology: typeof METHODOLOGY };

/** Calculates (or reuses) the chart for a birth profile and persists it. */
export async function calculateForProfile(userId: string, profileId: string) {
  const profile = await getOwnedProfile(userId, profileId);
  const input = profileToChartInput(profile);
  const hash = chartInputHash(input);

  const existing = await prisma.chartCalculation.findUnique({
    where: { birthProfileId_inputHash: { birthProfileId: profile.id, inputHash: hash } },
    select: { id: true },
  });
  if (existing) return { chartId: existing.id, reused: true };

  const chart = calculateChart(input);
  try {
    return { chartId: await persistChart(profile.id, chart), reused: false };
  } catch (err) {
    // A concurrent request for the same inputs won the race; reuse its row.
    if ((err as { code?: string }).code === "P2002") {
      const winner = await prisma.chartCalculation.findUniqueOrThrow({
        where: { birthProfileId_inputHash: { birthProfileId: profile.id, inputHash: hash } },
        select: { id: true },
      });
      return { chartId: winner.id, reused: true };
    }
    throw err;
  }
}

async function persistChart(birthProfileId: string, chart: ChartResult): Promise<string> {
  const details: StoredDetails = {
    ascendant: chart.ascendant,
    aspects: chart.aspects,
    d1: chart.d1,
    d9: chart.d9,
    summary: chart.summary,
    utcOffsetMinutes: chart.utcOffsetMinutes,
    timeAmbiguity: chart.timeAmbiguity,
    methodology: METHODOLOGY,
  };

  const created = await prisma.chartCalculation.create({
    data: {
      birthProfileId,
      inputHash: chart.inputHash,
      ayanamsha: chart.ayanamsha,
      ayanamshaValue: chart.ayanamshaValue,
      nodeType: chart.nodeType,
      houseSystem: chart.houseSystem,
      ephemerisSource: chart.ephemerisSource,
      engineVersion: chart.engineVersion,
      utcDateTime: chart.utcDateTime,
      julianDayUt: chart.julianDayUt,
      ascendant: chart.ascendant.longitude,
      details: details as unknown as Prisma.InputJsonValue,
      planets: {
        create: chart.planets.map((p) => ({
          planet: p.planet,
          longitude: p.longitude,
          latitude: p.latitude,
          speed: p.speed,
          isRetrograde: p.isRetrograde,
          sign: p.sign,
          degreeInSign: p.degreeInSign,
          house: p.house,
          nakshatra: p.nakshatra,
          pada: p.pada,
          navamshaSign: p.navamshaSign,
        })),
      },
      houses: { create: chart.houses.map((h) => ({ house: h.house, sign: h.sign, cuspLongitude: h.cuspLongitude })) },
      dashas: {
        create: chart.dashas.map((d) => ({
          level: d.level,
          planet: d.planet,
          parentPlanet: d.parentPlanet,
          startsAt: d.startsAt,
          endsAt: d.endsAt,
        })),
      },
    },
    select: { id: true },
  });
  return created.id;
}

/** Loads a chart, enforcing that it belongs to one of the caller's birth profiles. */
export async function getOwnedChartRow(userId: string, chartId: string) {
  const row = await prisma.chartCalculation.findFirst({
    where: { id: chartId, birthProfile: { userId } },
    include: {
      birthProfile: true,
      planets: true,
      houses: { orderBy: { house: "asc" } },
      dashas: { orderBy: [{ startsAt: "asc" }] },
    },
  });
  if (!row) throw notFound("Chart not found");
  return row;
}

type ChartRow = Awaited<ReturnType<typeof getOwnedChartRow>>;

const PLANET_ORDER = Object.keys(PLANET_LABELS);

/** Reassembles the engine result from stored rows (no recalculation). */
export function rowToChartResult(row: ChartRow): ChartResult {
  const details = row.details as unknown as StoredDetails;
  const planets = [...row.planets]
    .sort((a, b) => PLANET_ORDER.indexOf(a.planet) - PLANET_ORDER.indexOf(b.planet))
    .map((p) => ({
      planet: p.planet,
      longitude: p.longitude,
      latitude: p.latitude,
      speed: p.speed,
      isRetrograde: p.isRetrograde,
      sign: p.sign,
      degreeInSign: p.degreeInSign,
      house: p.house,
      nakshatra: p.nakshatra,
      pada: p.pada,
      nakshatraLord: NAKSHATRAS[p.nakshatra - 1]!.lord,
      navamshaSign: p.navamshaSign,
      dignity: null as ChartResult["planets"][number]["dignity"],
    }));
  // Dignity is derived, not stored; recompute from sign.
  return {
    inputHash: row.inputHash,
    utcDateTime: row.utcDateTime,
    utcOffsetMinutes: details.utcOffsetMinutes,
    timeAmbiguity: details.timeAmbiguity,
    julianDayUt: row.julianDayUt,
    ayanamsha: row.ayanamsha,
    ayanamshaValue: row.ayanamshaValue,
    nodeType: row.nodeType,
    houseSystem: "WHOLE_SIGN",
    ephemerisSource: row.ephemerisSource,
    engineVersion: row.engineVersion,
    ascendant: details.ascendant,
    planets: planets.map((p) => ({ ...p, dignity: dignityFor(p.planet, p.sign) })),
    houses: row.houses.map((h) => ({ house: h.house, sign: h.sign, cuspLongitude: h.cuspLongitude, lord: SIGNS[h.sign - 1]!.lord })),
    aspects: details.aspects,
    d1: details.d1,
    d9: details.d9,
    summary: details.summary,
    dashas: row.dashas.map((d) => ({
      level: d.level,
      planet: d.planet,
      parentPlanet: d.parentPlanet,
      startsAt: d.startsAt,
      endsAt: d.endsAt,
    })),
  };
}

export function chartResponse(row: ChartRow) {
  const chart = rowToChartResult(row);
  const p = row.birthProfile;
  return {
    id: row.id,
    createdAt: row.createdAt,
    profile: {
      id: p.id,
      name: p.name,
      dateOfBirth: p.dateOfBirth.toISOString().slice(0, 10),
      birthTime: p.birthTime,
      birthTimeAccuracy: p.birthTimeAccuracy,
      placeName: p.placeName,
      latitude: Number(p.latitude),
      longitude: Number(p.longitude),
      timezone: p.timezone,
    },
    metadata: {
      ayanamsha: chart.ayanamsha,
      ayanamshaValue: chart.ayanamshaValue,
      nodeType: chart.nodeType,
      houseSystem: chart.houseSystem,
      ephemerisSource: chart.ephemerisSource,
      engineVersion: chart.engineVersion,
      utcDateTime: chart.utcDateTime,
      utcOffsetMinutes: chart.utcOffsetMinutes,
      timeAmbiguity: chart.timeAmbiguity,
      julianDayUt: chart.julianDayUt,
      methodology: METHODOLOGY,
    },
    ascendant: chart.ascendant,
    summary: chart.summary,
    planets: chart.planets,
    houses: chart.houses,
    aspects: chart.aspects,
    d1: chart.d1,
    d9: chart.d9,
  };
}

export async function listUserCharts(userId: string) {
  const rows = await prisma.chartCalculation.findMany({
    where: { birthProfile: { userId } },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      createdAt: true,
      ascendant: true,
      details: true,
      birthProfile: { select: { id: true, name: true, isPrimary: true } },
    },
    take: 50,
  });
  return rows.map((r) => ({
    id: r.id,
    createdAt: r.createdAt,
    profile: r.birthProfile,
    summary: (r.details as unknown as StoredDetails).summary,
  }));
}

export async function interpretationsFor(userId: string, chartId: string, lang: Lang) {
  const row = await getOwnedChartRow(userId, chartId);
  const chart = rowToChartResult(row);
  const transits = calculateTransits(new Date(), chart.ayanamsha, chart.summary.moonSign);
  const blocks = interpretChart(chart, lang, transits);

  // Persist the static (non-time-dependent) sections for reports and later review.
  for (const b of blocks.filter((x) => x.section !== "DASHA" && x.section !== "TRANSITS")) {
    await prisma.chartInterpretation.upsert({
      where: { chartId_section_language_source: { chartId, section: b.section, language: lang, source: "RULE_BASED" } },
      update: { content: b as unknown as Prisma.InputJsonValue },
      create: { chartId, section: b.section, language: lang, source: "RULE_BASED", content: b as unknown as Prisma.InputJsonValue },
    });
  }

  return {
    source: "RULE_BASED" as const,
    label: lang === "HI" ? "नियम-आधारित व्याख्या" : "Rule-based interpretation",
    disclaimer: lang === "HI" ? INTERPRETATION_DISCLAIMER.hi : INTERPRETATION_DISCLAIMER.en,
    sections: blocks,
  };
}

export async function saveChart(userId: string, chartId: string, label?: string) {
  await getOwnedChartRow(userId, chartId);
  return prisma.savedChart.upsert({
    where: { userId_chartId: { userId, chartId } },
    update: { label: label ?? null },
    create: { userId, chartId, label: label ?? null },
  });
}
