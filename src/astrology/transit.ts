// Planetary transits (gochar): geocentric sidereal positions at a moment, optionally
// related to a natal Moon sign (house counted from the Moon, as is traditional for gochar).
import { NAKSHATRAS, PLANETS, type PlanetName } from "./constants.js";
import { ENGINE_VERSION, assertSupportedDate, siderealPositions, type AyanamshaName } from "./ephemeris.js";
import { dateToJulianDay } from "./time.js";
import { houseFromLagna, nakshatraOf, padaOf, signOf } from "./chart.js";

export function calculateTransits(moment: Date, ayanamsha: AyanamshaName = "LAHIRI", natalMoonSign?: number) {
  assertSupportedDate(moment);
  const jd = dateToJulianDay(moment);
  const { ayanamshaValue, bodies } = siderealPositions(jd, ayanamsha, "TRUE_NODE");

  const positions = PLANETS.map((planet: PlanetName) => {
    const b = bodies[planet];
    const sign = signOf(b.longitude);
    const nak = nakshatraOf(b.longitude);
    return {
      planet,
      longitude: b.longitude,
      speed: b.speed,
      isRetrograde: planet === "RAHU" || planet === "KETU" ? true : b.speed < 0,
      sign,
      degreeInSign: b.longitude % 30,
      nakshatra: nak,
      nakshatraName: NAKSHATRAS[nak - 1]!.en,
      pada: padaOf(b.longitude),
      houseFromMoon: natalMoonSign ? houseFromLagna(sign, natalMoonSign) : null,
    };
  });

  let sadeSati: { active: boolean; phase: "RISING" | "PEAK" | "SETTING" | null } | null = null;
  if (natalMoonSign) {
    const saturnHouse = positions.find((p) => p.planet === "SATURN")!.houseFromMoon;
    const phase = saturnHouse === 12 ? "RISING" : saturnHouse === 1 ? "PEAK" : saturnHouse === 2 ? "SETTING" : null;
    sadeSati = { active: phase !== null, phase };
  }

  return { moment, ayanamsha, ayanamshaValue, engineVersion: ENGINE_VERSION, positions, sadeSati };
}

export type TransitResult = ReturnType<typeof calculateTransits>;

export type SkyEvent = {
  planet: PlanetName;
  type: "INGRESS" | "RETROGRADE" | "DIRECT";
  /** Sign entered (ingress) or the sign the station happens in */
  sign: number;
  at: Date;
};

const bodyAt = (planet: PlanetName, ms: number) => siderealPositions(dateToJulianDay(new Date(ms)), "LAHIRI", "TRUE_NODE").bodies[planet];

/** Narrows a change of `key` between two moments down to one minute. */
function refine(planet: PlanetName, lo: number, hi: number, key: (b: { longitude: number; speed: number }) => number) {
  const k0 = key(bodyAt(planet, lo));
  while (hi - lo > 60_000) {
    const mid = (lo + hi) / 2;
    if (key(bodyAt(planet, mid)) === k0) lo = mid;
    else hi = mid;
  }
  return hi;
}

/**
 * Sign changes and stations (retrograde / direct) of the grahas between `from` and `from + days`,
 * sorted by time and accurate to the minute. The Moon is sampled every 3 hours, others daily
 * (no planet other than the Moon can change sign twice within a day).
 */
export function upcomingSkyEvents(from: Date, days: number): SkyEvent[] {
  assertSupportedDate(from);
  const end = from.getTime() + days * 86_400_000;
  const events: SkyEvent[] = [];
  for (const planet of PLANETS) {
    const step = planet === "MOON" ? 3 * 3_600_000 : 86_400_000;
    let t = from.getTime();
    let prev = bodyAt(planet, t);
    while (t < end) {
      const next = Math.min(t + step, end);
      const cur = bodyAt(planet, next);
      if (signOf(prev.longitude) !== signOf(cur.longitude)) {
        const at = refine(planet, t, next, (b) => signOf(b.longitude));
        events.push({ planet, type: "INGRESS", sign: signOf(bodyAt(planet, at).longitude), at: new Date(at) });
      }
      // Nodes always move backwards (mean motion); only true planets have stations.
      if (planet !== "RAHU" && planet !== "KETU" && planet !== "SUN" && planet !== "MOON" && Math.sign(prev.speed) !== Math.sign(cur.speed)) {
        const at = refine(planet, t, next, (b) => Math.sign(b.speed));
        events.push({ planet, type: cur.speed < 0 ? "RETROGRADE" : "DIRECT", sign: signOf(cur.longitude), at: new Date(at) });
      }
      prev = cur;
      t = next;
    }
  }
  return events.sort((a, b) => a.at.getTime() - b.at.getTime());
}
