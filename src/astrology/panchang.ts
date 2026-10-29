// Panchang for a date and location.
//
// Conventions: elements are evaluated at local sunrise (the traditional start of the Hindu day).
// Tithi = floor(((Moon − Sun) mod 360) / 12); Yoga = floor(((Sun + Moon) mod 360) / (360/27));
// Karana = half-tithi (60 per lunar month: Kimstughna, 8 × 7 movable, Shakuni, Chatushpada, Naga).
// Rahu Kaal / Yamaganda / Gulika = one of eight equal parts of daytime, fixed per weekday.
// Sunrise/sunset: upper limb of the Sun with standard atmospheric refraction.
import { MOVABLE_KARANAS, NAKSHATRAS, NAKSHATRA_SPAN, TITHIS, WEEKDAYS, YOGAS } from "./constants.js";
import { nextSunEvent, siderealLongitude, type AyanamshaName } from "./ephemeris.js";
import { dateToJulianDay, julianDayToDate, localToUtc, parseDateString, toZonedParts } from "./time.js";

export type PanchangInput = {
  date: string; // YYYY-MM-DD local
  latitude: number;
  longitude: number;
  timezone: string;
  ayanamsha?: AyanamshaName;
};

const norm = (x: number) => ((x % 360) + 360) % 360;

type Angles = { sun: number; moon: number };

function anglesAt(jd: number, ay: AyanamshaName): Angles {
  return { sun: siderealLongitude(jd, "SUN", ay), moon: siderealLongitude(jd, "MOON", ay) };
}

const tithiAngle = (a: Angles) => norm(a.moon - a.sun);
const yogaAngle = (a: Angles) => norm(a.sun + a.moon);

/**
 * Finds when `angleFn` next reaches the end of its current `span`-degree segment.
 * The angle increases monotonically (tithi/nakshatra/yoga all advance), so we step
 * forward until the segment index changes and then bisect to ~1 second.
 */
function segmentEnd(startJd: number, span: number, angleFn: (jd: number) => number): number {
  const index = (jd: number) => Math.floor(angleFn(jd) / span);
  const startIdx = index(startJd);
  const step = 2 / 24; // 2 hours: shorter than any segment duration
  let lo = startJd;
  let hi = startJd + step;
  for (let guard = 0; index(hi) === startIdx && guard < 48; guard++) {
    lo = hi;
    hi += step;
  }
  while ((hi - lo) * 86_400 > 1) {
    const mid = (lo + hi) / 2;
    if (index(mid) === startIdx) lo = mid;
    else hi = mid;
  }
  return hi;
}

function karanaName(index: number): string {
  // index 0–59 within the synodic month
  if (index === 0) return "Kimstughna";
  if (index === 57) return "Shakuni";
  if (index === 58) return "Chatushpada";
  if (index === 59) return "Naga";
  return MOVABLE_KARANAS[(index - 1) % 7]!;
}

const RAHU_PART = [8, 2, 7, 5, 6, 4, 3]; // Sun..Sat
const YAMAGANDA_PART = [5, 4, 3, 2, 1, 7, 6];
const GULIKA_PART = [7, 6, 5, 4, 3, 2, 1];

export function calculatePanchang(input: PanchangInput) {
  const ay = input.ayanamsha ?? "LAHIRI";
  const { year, month, day } = parseDateString(input.date);
  const midnight = localToUtc({ year, month, day, hour: 0, minute: 0, second: 0 }, input.timezone).utc;
  const midnightJd = dateToJulianDay(midnight);

  const sunriseJd = nextSunEvent(midnightJd, "rise", input.latitude, input.longitude);
  if (sunriseJd === null) {
    throw new RangeError("The Sun does not rise on this date at this latitude; Panchang is undefined.");
  }
  const sunsetJd = nextSunEvent(sunriseJd, "set", input.latitude, input.longitude);
  const nextSunriseJd = nextSunEvent(sunriseJd + 0.5, "rise", input.latitude, input.longitude);
  if (sunsetJd === null || nextSunriseJd === null) {
    throw new RangeError("Sunset could not be determined at this latitude for this date.");
  }

  const at = anglesAt(sunriseJd, ay);

  const tithiIdx = Math.floor(tithiAngle(at) / 12); // 0–29
  const paksha = tithiIdx < 15 ? "SHUKLA" : "KRISHNA";
  const tithiInPaksha = (tithiIdx % 15) + 1;
  const tithiName = tithiIdx === 14 ? "Purnima" : tithiIdx === 29 ? "Amavasya" : TITHIS[tithiInPaksha - 1]!;
  const tithiEnd = segmentEnd(sunriseJd, 12, (jd) => tithiAngle(anglesAt(jd, ay)));

  const nakIdx = Math.floor(at.moon / NAKSHATRA_SPAN);
  const nakEnd = segmentEnd(sunriseJd, NAKSHATRA_SPAN, (jd) => siderealLongitude(jd, "MOON", ay));

  const yogaIdx = Math.floor(yogaAngle(at) / NAKSHATRA_SPAN);
  const yogaEnd = segmentEnd(sunriseJd, NAKSHATRA_SPAN, (jd) => yogaAngle(anglesAt(jd, ay)));

  const karanaIdx = Math.floor(tithiAngle(at) / 6);
  const karanaEnd = segmentEnd(sunriseJd, 6, (jd) => tithiAngle(anglesAt(jd, ay)));

  // Weekday of the local calendar date (the Vara runs sunrise to sunrise).
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();

  const dayLength = sunsetJd - sunriseJd;
  const part = (n: number) => ({
    start: julianDayToDate(sunriseJd + ((n - 1) * dayLength) / 8),
    end: julianDayToDate(sunriseJd + (n * dayLength) / 8),
  });

  const toLocal = (jd: number) => {
    const p = toZonedParts(julianDayToDate(jd).getTime(), input.timezone);
    return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
  };

  // Abhijit muhurta: the 8th of 15 daytime muhurtas (centred on local noon).
  const muhurta = dayLength / 15;

  return {
    date: input.date,
    location: { latitude: input.latitude, longitude: input.longitude, timezone: input.timezone },
    ayanamsha: ay,
    sunrise: julianDayToDate(sunriseJd),
    sunset: julianDayToDate(sunsetJd),
    nextSunrise: julianDayToDate(nextSunriseJd),
    localTimes: { sunrise: toLocal(sunriseJd), sunset: toLocal(sunsetJd) },
    vara: { index: weekday, ...WEEKDAYS[weekday]! },
    tithi: { number: tithiIdx + 1, paksha, name: tithiName, endsAt: julianDayToDate(tithiEnd) },
    nakshatra: {
      number: nakIdx + 1,
      name: NAKSHATRAS[nakIdx]!.en,
      hi: NAKSHATRAS[nakIdx]!.hi,
      lord: NAKSHATRAS[nakIdx]!.lord,
      endsAt: julianDayToDate(nakEnd),
    },
    yoga: { number: yogaIdx + 1, name: YOGAS[yogaIdx]!, endsAt: julianDayToDate(yogaEnd) },
    karana: { name: karanaName(karanaIdx), endsAt: julianDayToDate(karanaEnd) },
    rahuKaal: part(RAHU_PART[weekday]!),
    yamaganda: part(YAMAGANDA_PART[weekday]!),
    gulikaKaal: part(GULIKA_PART[weekday]!),
    abhijitMuhurta: {
      start: julianDayToDate(sunriseJd + 7 * muhurta),
      end: julianDayToDate(sunriseJd + 8 * muhurta),
    },
    moonSign: Math.floor(at.moon / 30) + 1,
    sunSign: Math.floor(at.sun / 30) + 1,
  };
}

export type Panchang = ReturnType<typeof calculatePanchang>;
