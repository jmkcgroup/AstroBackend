// Birth chart (Kundli) calculation. Pure functions over ephemeris output.
//
// Methodology (also returned in chart metadata):
// - Sidereal zodiac, ayanamsha per profile (Lahiri default), Swiss Ephemeris positions.
// - Whole-sign houses: house 1 = the sign containing the ascendant.
// - Rahu = true (or mean) lunar node; Ketu = Rahu + 180°. Nodes are always treated as retrograde.
// - Navamsha (D9): sign = floor(longitude × 9 / 30) mod 12 (standard Parashari mapping).
// - Graha drishti: every graha aspects the 7th; Mars 4th/8th, Jupiter 5th/9th, Saturn 3rd/10th.
//   Rahu/Ketu are given the 7th only (traditions differ on extra node aspects).
// - Vimshottari: 120-year cycle from the Moon's nakshatra; balance by fraction of the
//   nakshatra remaining. One dasha year = 365.25 days.
import { createHash } from "node:crypto";
import {
  EXALTATION,
  NAKSHATRAS,
  NAKSHATRA_SPAN,
  OWN_SIGNS,
  PADA_SPAN,
  PLANETS,
  SIGNS,
  SPECIAL_ASPECTS,
  VIMSHOTTARI,
  type PlanetName,
} from "./constants.js";
import {
  ENGINE_VERSION,
  assertSupportedDate,
  ephemerisSource,
  siderealAscendant,
  siderealPositions,
  type AyanamshaName,
  type NodeTypeName,
} from "./ephemeris.js";
import { dateToJulianDay, localToUtc, parseDateString, parseTimeString } from "./time.js";

export type ChartInput = {
  date: string; // YYYY-MM-DD (local)
  time: string; // HH:mm[:ss] (local wall clock)
  timezone: string; // IANA
  latitude: number;
  longitude: number; // east positive
  ayanamsha?: AyanamshaName;
  nodeType?: NodeTypeName;
};

export type Dignity = "EXALTED" | "DEBILITATED" | "OWN_SIGN" | null;

export type PlanetPlacement = {
  planet: PlanetName;
  longitude: number;
  latitude: number;
  speed: number;
  isRetrograde: boolean;
  sign: number;
  degreeInSign: number;
  house: number;
  nakshatra: number;
  pada: number;
  nakshatraLord: PlanetName;
  navamshaSign: number;
  dignity: Dignity;
};

export type HousePlacement = { house: number; sign: number; cuspLongitude: number; lord: PlanetName };

export type DashaRow = {
  level: "MAHADASHA" | "ANTARDASHA";
  planet: PlanetName;
  parentPlanet: PlanetName | null;
  startsAt: Date;
  endsAt: Date;
};

export type ChartResult = {
  inputHash: string;
  utcDateTime: Date;
  utcOffsetMinutes: number;
  timeAmbiguity: "none" | "gap" | "fold";
  julianDayUt: number;
  ayanamsha: AyanamshaName;
  ayanamshaValue: number;
  nodeType: NodeTypeName;
  houseSystem: "WHOLE_SIGN";
  ephemerisSource: string;
  engineVersion: string;
  ascendant: {
    longitude: number;
    sign: number;
    degreeInSign: number;
    nakshatra: number;
    pada: number;
    navamshaSign: number;
  };
  planets: PlanetPlacement[];
  houses: HousePlacement[];
  aspects: { planet: PlanetName; aspectsHouses: number[] }[];
  d1: Record<number, PlanetName[]>; // house → planets
  d9: { ascendantSign: number; signs: Record<number, PlanetName[]> }; // sign → planets
  summary: {
    lagnaSign: number;
    moonSign: number; // Janma Rashi
    sunSign: number;
    moonNakshatra: number;
    moonPada: number;
  };
  dashas: DashaRow[];
};

const DASHA_YEAR_MS = 365.25 * 86_400_000;

export const signOf = (lon: number) => Math.floor(lon / 30) + 1;
export const degreeInSign = (lon: number) => lon % 30;
export const nakshatraOf = (lon: number) => Math.floor(lon / NAKSHATRA_SPAN) + 1;
export const padaOf = (lon: number) => Math.floor((lon % NAKSHATRA_SPAN) / PADA_SPAN) + 1;
export const navamshaSignOf = (lon: number) => (Math.floor((lon * 9) / 30) % 12) + 1;
/** Whole-sign house of a sign relative to the lagna sign. */
export const houseFromLagna = (sign: number, lagnaSign: number) => ((sign - lagnaSign + 12) % 12) + 1;

export function dignityOf(planet: PlanetName, sign: number): Dignity {
  const ex = EXALTATION[planet];
  if (ex === sign) return "EXALTED";
  if (ex !== undefined && ((ex + 5) % 12) + 1 === sign) return "DEBILITATED";
  if (OWN_SIGNS[planet]?.includes(sign)) return "OWN_SIGN";
  return null;
}

export function aspectedHouses(planet: PlanetName, fromHouse: number): number[] {
  const offsets = [7, ...(SPECIAL_ASPECTS[planet] ?? [])].sort((a, b) => a - b);
  return offsets.map((n) => ((fromHouse - 1 + n - 1) % 12) + 1);
}

export function vimshottari(moonLongitude: number, birth: Date): DashaRow[] {
  const nak = nakshatraOf(moonLongitude); // 1–27
  const startIndex = (nak - 1) % 9;
  const fractionElapsed = (moonLongitude % NAKSHATRA_SPAN) / NAKSHATRA_SPAN;

  const first = VIMSHOTTARI[startIndex]!;
  // The first mahadasha began before birth; anchor it so the balance runs from birth.
  let cursor = birth.getTime() - fractionElapsed * first.years * DASHA_YEAR_MS;

  const rows: DashaRow[] = [];
  for (let i = 0; i < 9; i++) {
    const maha = VIMSHOTTARI[(startIndex + i) % 9]!;
    const mahaStart = cursor;
    const mahaEnd = mahaStart + maha.years * DASHA_YEAR_MS;
    rows.push({
      level: "MAHADASHA",
      planet: maha.planet,
      parentPlanet: null,
      startsAt: new Date(mahaStart),
      endsAt: new Date(mahaEnd),
    });

    let sub = mahaStart;
    for (let j = 0; j < 9; j++) {
      const antar = VIMSHOTTARI[(startIndex + i + j) % 9]!;
      const len = ((maha.years * antar.years) / 120) * DASHA_YEAR_MS;
      rows.push({
        level: "ANTARDASHA",
        planet: antar.planet,
        parentPlanet: maha.planet,
        startsAt: new Date(sub),
        endsAt: new Date(sub + len),
      });
      sub += len;
    }
    cursor = mahaEnd;
  }
  return rows;
}

export function chartInputHash(input: ChartInput): string {
  const canonical = JSON.stringify([
    input.date,
    input.time,
    input.timezone,
    input.latitude.toFixed(6),
    input.longitude.toFixed(6),
    input.ayanamsha ?? "LAHIRI",
    input.nodeType ?? "TRUE_NODE",
    ENGINE_VERSION,
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

export function calculateChart(input: ChartInput): ChartResult {
  const ayanamsha = input.ayanamsha ?? "LAHIRI";
  const nodeType = input.nodeType ?? "TRUE_NODE";

  if (input.latitude < -90 || input.latitude > 90) throw new RangeError("Latitude must be between -90 and 90");
  if (input.longitude < -180 || input.longitude > 180) throw new RangeError("Longitude must be between -180 and 180");

  const d = parseDateString(input.date);
  const t = parseTimeString(input.time);
  const resolved = localToUtc({ ...d, ...t }, input.timezone);
  assertSupportedDate(resolved.utc);

  const jd = dateToJulianDay(resolved.utc);
  const { ayanamshaValue, bodies } = siderealPositions(jd, ayanamsha, nodeType);
  const ascLon = siderealAscendant(jd, input.latitude, input.longitude, ayanamsha);
  const lagnaSign = signOf(ascLon);

  const planets: PlanetPlacement[] = PLANETS.map((planet) => {
    const b = bodies[planet];
    const sign = signOf(b.longitude);
    const nak = nakshatraOf(b.longitude);
    return {
      planet,
      longitude: b.longitude,
      latitude: b.latitude,
      speed: b.speed,
      isRetrograde: planet === "RAHU" || planet === "KETU" ? true : b.speed < 0,
      sign,
      degreeInSign: degreeInSign(b.longitude),
      house: houseFromLagna(sign, lagnaSign),
      nakshatra: nak,
      pada: padaOf(b.longitude),
      nakshatraLord: NAKSHATRAS[nak - 1]!.lord,
      navamshaSign: navamshaSignOf(b.longitude),
      dignity: dignityOf(planet, sign),
    };
  });

  const houses: HousePlacement[] = Array.from({ length: 12 }, (_, i) => {
    const sign = ((lagnaSign - 1 + i) % 12) + 1;
    return { house: i + 1, sign, cuspLongitude: (sign - 1) * 30, lord: SIGNS[sign - 1]!.lord };
  });

  const d1: Record<number, PlanetName[]> = {};
  for (let h = 1; h <= 12; h++) d1[h] = [];
  for (const p of planets) d1[p.house]!.push(p.planet);

  const d9Signs: Record<number, PlanetName[]> = {};
  for (let s = 1; s <= 12; s++) d9Signs[s] = [];
  for (const p of planets) d9Signs[p.navamshaSign]!.push(p.planet);

  const moon = planets.find((p) => p.planet === "MOON")!;
  const sun = planets.find((p) => p.planet === "SUN")!;

  return {
    inputHash: chartInputHash({ ...input, ayanamsha, nodeType }),
    utcDateTime: resolved.utc,
    utcOffsetMinutes: resolved.offsetMinutes,
    timeAmbiguity: resolved.ambiguity,
    julianDayUt: jd,
    ayanamsha,
    ayanamshaValue,
    nodeType,
    houseSystem: "WHOLE_SIGN",
    ephemerisSource: ephemerisSource(),
    engineVersion: ENGINE_VERSION,
    ascendant: {
      longitude: ascLon,
      sign: lagnaSign,
      degreeInSign: degreeInSign(ascLon),
      nakshatra: nakshatraOf(ascLon),
      pada: padaOf(ascLon),
      navamshaSign: navamshaSignOf(ascLon),
    },
    planets,
    houses,
    aspects: planets.map((p) => ({ planet: p.planet, aspectsHouses: aspectedHouses(p.planet, p.house) })),
    d1,
    d9: { ascendantSign: navamshaSignOf(ascLon), signs: d9Signs },
    summary: {
      lagnaSign,
      moonSign: moon.sign,
      sunSign: sun.sign,
      moonNakshatra: moon.nakshatra,
      moonPada: moon.pada,
    },
    dashas: vimshottari(moon.longitude, resolved.utc),
  };
}

export const METHODOLOGY = {
  zodiac: "Sidereal",
  defaultAyanamsha: "Lahiri (Chitrapaksha), SE_SIDM_LAHIRI",
  houseSystem: "Whole sign (house 1 = ascendant sign)",
  lunarNode: "True node by default (mean node selectable); Ketu = Rahu + 180°",
  divisionalCharts: "D9 Navamsha: sign = floor(longitude × 9 / 30) mod 12",
  aspects: "All grahas 7th; Mars +4th/8th; Jupiter +5th/9th; Saturn +3rd/10th; nodes 7th only",
  dasha: "Vimshottari, 120 years, balance from Moon's nakshatra; year = 365.25 days",
  timezone: "IANA tz database (historical offsets) via Node ICU; DST gaps/folds are flagged",
  precision: "Swiss Ephemeris .se1 files, supported 1800–2399 CE; no Moshier fallback",
} as const;
