// Astrology engine tests. Expected values come from independently known astronomical events
// and published Panchang timings — never from this engine's own output.
import { beforeAll, describe, expect, it } from "vitest";
import { initEphemeris, siderealLongitude, siderealPositions } from "../src/astrology/ephemeris.js";
import { dateToJulianDay, localToUtc, offsetAt } from "../src/astrology/time.js";
import {
  calculateChart,
  houseFromLagna,
  nakshatraOf,
  navamshaSignOf,
  padaOf,
  signOf,
  vimshottari,
} from "../src/astrology/chart.js";
import { calculatePanchang } from "../src/astrology/panchang.js";
import { gunaMilan } from "../src/astrology/matching.js";
import { calculateNumerology } from "../src/astrology/numerology.js";
import { calculateTransits, upcomingSkyEvents } from "../src/astrology/transit.js";

// Initialise at module load: some describe blocks compute fixtures during collection.
const ephemeris = initEphemeris("./ephe");

beforeAll(() => {
  expect(ephemeris.ok, `missing ephemeris files: ${ephemeris.missing.join(", ")}`).toBe(true);
});

const jd = (iso: string) => dateToJulianDay(new Date(iso));
const MIN = 60_000;

describe("timezone conversion", () => {
  it("uses India Standard Time (+05:30) for modern dates", () => {
    expect(offsetAt(Date.parse("2000-01-01T00:00:00Z"), "Asia/Kolkata") / MIN).toBe(330);
  });

  it("applies the historical +06:30 war-time offset in India (1942–1945)", () => {
    expect(offsetAt(Date.parse("1943-06-01T00:00:00Z"), "Asia/Kolkata") / MIN).toBe(390);
  });

  it("converts local birth time to UTC", () => {
    const r = localToUtc({ year: 2002, month: 9, day: 20, hour: 10, minute: 15, second: 0 }, "Asia/Kolkata");
    expect(r.utc.toISOString()).toBe("2002-09-20T04:45:00.000Z");
    expect(r.ambiguity).toBe("none");
  });

  it("flags a nonexistent local time in a DST gap", () => {
    const r = localToUtc({ year: 2024, month: 3, day: 10, hour: 2, minute: 30, second: 0 }, "America/New_York");
    expect(r.ambiguity).toBe("gap");
  });

  it("flags an ambiguous local time in a DST fold and picks the earlier instant", () => {
    const r = localToUtc({ year: 2024, month: 11, day: 3, hour: 1, minute: 30, second: 0 }, "America/New_York");
    expect(r.ambiguity).toBe("fold");
    expect(r.utc.toISOString()).toBe("2024-11-03T05:30:00.000Z"); // EDT interpretation
  });

  it("rejects unknown time zones", () => {
    expect(() => localToUtc({ year: 2000, month: 1, day: 1, hour: 0, minute: 0, second: 0 }, "Mars/Olympus")).toThrow();
  });
});

describe("ephemeris and ayanamsha", () => {
  it("Lahiri ayanamsha at J2000.0 is 23°51′ (≈23.853°)", () => {
    const { ayanamshaValue } = siderealPositions(2451545.0, "LAHIRI", "TRUE_NODE");
    expect(ayanamshaValue).toBeCloseTo(23.853, 2);
  });

  it("Makar Sankranti 2024: sidereal Sun enters Capricorn (270°) near 15 Jan 02:54 IST", () => {
    // 02:54 IST = 2024-01-14T21:24Z. Bracket by ±25 minutes.
    expect(siderealLongitude(jd("2024-01-14T20:59:00Z"), "SUN", "LAHIRI")).toBeLessThan(270);
    expect(siderealLongitude(jd("2024-01-14T21:49:00Z"), "SUN", "LAHIRI")).toBeGreaterThan(270);
  });

  it("total solar eclipse of 8 April 2024: Sun and Moon are conjunct", () => {
    const t = jd("2024-04-08T18:17:00Z");
    const diff = Math.abs(siderealLongitude(t, "MOON", "LAHIRI") - siderealLongitude(t, "SUN", "LAHIRI"));
    expect(diff).toBeLessThan(0.3);
  });

  it("Rahu and Ketu are exactly opposite", () => {
    const { bodies } = siderealPositions(jd("2024-01-01T00:00:00Z"), "LAHIRI", "TRUE_NODE");
    expect(((bodies.KETU.longitude - bodies.RAHU.longitude + 360) % 360)).toBeCloseTo(180, 9);
  });
});

describe("sign, nakshatra and pada boundaries", () => {
  it("assigns signs at exact boundaries", () => {
    expect(signOf(0)).toBe(1);
    expect(signOf(29.9999)).toBe(1);
    expect(signOf(30)).toBe(2);
    expect(signOf(359.9999)).toBe(12);
  });

  it("assigns nakshatras of 13°20′ and padas of 3°20′", () => {
    expect(nakshatraOf(0)).toBe(1);
    expect(nakshatraOf(13.3333)).toBe(1);
    expect(nakshatraOf(13.33334)).toBe(2);
    expect(nakshatraOf(359.99)).toBe(27);
    expect(padaOf(0)).toBe(1);
    expect(padaOf(3.3333)).toBe(1);
    expect(padaOf(3.33334)).toBe(2);
    expect(padaOf(13.3333)).toBe(4);
  });

  it("maps navamsha by element (fire→Aries, earth→Capricorn, air→Libra, water→Cancer)", () => {
    expect(navamshaSignOf(0)).toBe(1); // Aries 0°
    expect(navamshaSignOf(30)).toBe(10); // Taurus 0°
    expect(navamshaSignOf(60)).toBe(7); // Gemini 0°
    expect(navamshaSignOf(90)).toBe(4); // Cancer 0°
    expect(navamshaSignOf(3.34)).toBe(2); // second navamsha of Aries
    expect(navamshaSignOf(359.9)).toBe(12); // last navamsha of Pisces
  });

  it("counts whole-sign houses from the lagna", () => {
    expect(houseFromLagna(10, 10)).toBe(1);
    expect(houseFromLagna(1, 10)).toBe(4);
    expect(houseFromLagna(9, 10)).toBe(12);
  });
});

describe("Vimshottari dasha", () => {
  const birth = new Date("2000-01-01T00:00:00Z");
  const YEAR = 365.25 * 86_400_000;

  it("starts with the full Ketu dasha when the Moon is at 0° Ashwini", () => {
    const rows = vimshottari(0, birth);
    const first = rows.find((r) => r.level === "MAHADASHA")!;
    expect(first.planet).toBe("KETU");
    expect(first.startsAt.getTime()).toBe(birth.getTime());
    expect((first.endsAt.getTime() - first.startsAt.getTime()) / YEAR).toBeCloseTo(7, 9);
  });

  it("gives the correct balance mid-nakshatra (Moon halfway through Bharani → 10 years of Venus left)", () => {
    const rows = vimshottari(13.3333333333 + 6.6666666667, birth);
    const first = rows.find((r) => r.level === "MAHADASHA")!;
    expect(first.planet).toBe("VENUS");
    expect((first.endsAt.getTime() - birth.getTime()) / YEAR).toBeCloseTo(10, 6);
  });

  it("covers a 120-year cycle and antardashas exactly fill each mahadasha", () => {
    const rows = vimshottari(123.4, birth);
    const mahas = rows.filter((r) => r.level === "MAHADASHA");
    expect(mahas).toHaveLength(9);
    const total = mahas.reduce((s, m) => s + (m.endsAt.getTime() - m.startsAt.getTime()), 0) / YEAR;
    expect(total).toBeCloseTo(120, 6);
    for (const m of mahas) {
      const antars = rows.filter((r) => r.level === "ANTARDASHA" && r.parentPlanet === m.planet);
      expect(antars).toHaveLength(9);
      expect(antars[0]!.planet).toBe(m.planet);
      expect(antars[0]!.startsAt.getTime()).toBe(m.startsAt.getTime());
      expect(Math.abs(antars[8]!.endsAt.getTime() - m.endsAt.getTime())).toBeLessThan(5);
    }
  });
});

describe("birth chart", () => {
  const chart = calculateChart({
    date: "2002-09-20",
    time: "10:15",
    timezone: "Asia/Kolkata",
    latitude: 18.5089,
    longitude: 73.9259,
  });

  it("records reproducibility metadata", () => {
    expect(chart.ayanamsha).toBe("LAHIRI");
    expect(chart.houseSystem).toBe("WHOLE_SIGN");
    expect(chart.ephemerisSource).toMatch(/Swiss Ephemeris/);
    expect(chart.inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(chart.utcDateTime.toISOString()).toBe("2002-09-20T04:45:00.000Z");
  });

  it("places all nine grahas consistently", () => {
    expect(chart.planets).toHaveLength(9);
    for (const p of chart.planets) {
      expect(p.sign).toBe(signOf(p.longitude));
      expect(p.house).toBe(houseFromLagna(p.sign, chart.ascendant.sign));
      expect(chart.d1[p.house]).toContain(p.planet);
    }
    expect(Object.values(chart.d1).flat()).toHaveLength(9);
    expect(Object.values(chart.d9.signs).flat()).toHaveLength(9);
  });

  it("puts the Sun in sidereal Virgo on 20 September", () => {
    // Tropical Sun ≈ 177° on 20 Sep; minus ~23.9° ayanamsha ≈ 153° → Virgo (6).
    expect(chart.planets.find((p) => p.planet === "SUN")!.sign).toBe(6);
  });

  it("is deterministic for identical input", () => {
    const again = calculateChart({
      date: "2002-09-20",
      time: "10:15",
      timezone: "Asia/Kolkata",
      latitude: 18.5089,
      longitude: 73.9259,
    });
    expect(again.inputHash).toBe(chart.inputHash);
    expect(again.ascendant.longitude).toBe(chart.ascendant.longitude);
  });

  it("rejects dates outside the ephemeris range", () => {
    expect(() =>
      calculateChart({ date: "1700-01-01", time: "12:00", timezone: "UTC", latitude: 0, longitude: 0 }),
    ).toThrow(/between 1800 and 2399/);
  });
});

describe("panchang", () => {
  // Guru Purnima 2024 (New Delhi): Purnima tithi from 20 Jul 17:59 IST to 21 Jul 15:46 IST.
  const p = calculatePanchang({ date: "2024-07-21", latitude: 28.6139, longitude: 77.209, timezone: "Asia/Kolkata" });

  it("finds Purnima at sunrise on Guru Purnima 2024", () => {
    expect(p.tithi.name).toBe("Purnima");
    expect(p.tithi.paksha).toBe("SHUKLA");
  });

  it("computes the Purnima end time within 5 minutes of the published value", () => {
    const published = Date.parse("2024-07-21T15:46:00+05:30");
    expect(Math.abs(p.tithi.endsAt.getTime() - published)).toBeLessThan(5 * MIN);
  });

  it("computes Delhi sunrise near 05:36 IST", () => {
    const published = Date.parse("2024-07-21T05:36:00+05:30");
    expect(Math.abs(p.sunrise.getTime() - published)).toBeLessThan(3 * MIN);
  });

  it("identifies the weekday and Sunday's Rahu Kaal as the last eighth of daytime", () => {
    expect(p.vara.en).toBe("Sunday");
    expect(Math.abs(p.rahuKaal.end.getTime() - p.sunset.getTime())).toBeLessThan(1000);
  });
});

describe("guna milan", () => {
  it("scores identical Moon positions as 28/36 with Nadi dosha", () => {
    const r = gunaMilan({ moonLongitude: 45 }, { moonLongitude: 45 });
    const by = Object.fromEntries(r.kootas.map((k) => [k.koota, k.score]));
    expect(by).toEqual({
      Varna: 1,
      Vashya: 2,
      Tara: 3,
      Yoni: 4,
      "Graha Maitri": 5,
      Gana: 6,
      Bhakoot: 7,
      Nadi: 0,
    });
    expect(r.total).toBe(28);
  });

  it("applies Bhakoot dosha for a 6/8 relationship", () => {
    // Aries Moon (boy) and Virgo Moon (girl): Aries is 8th from Virgo.
    const r = gunaMilan({ moonLongitude: 5 }, { moonLongitude: 155 });
    expect(r.kootas.find((k) => k.koota === "Bhakoot")!.score).toBe(0);
  });

  it("never exceeds the maximum per koota", () => {
    for (let a = 0; a < 360; a += 7.3) {
      for (let b = 0; b < 360; b += 11.1) {
        const r = gunaMilan({ moonLongitude: a }, { moonLongitude: b });
        for (const k of r.kootas) expect(k.score).toBeLessThanOrEqual(k.max);
        expect(r.total).toBeLessThanOrEqual(36);
      }
    }
  });
});

describe("numerology", () => {
  it("computes moolank and bhagyank", () => {
    const r = calculateNumerology({ dateOfBirth: "1990-08-15" });
    expect(r.moolank.value).toBe(6); // 1+5
    expect(r.bhagyank.value).toBe(6); // 1+5+0+8+1+9+9+0 = 33 → 6
    expect(r.bhagyank.compound).toBe(33);
  });

  it("computes a Chaldean name number", () => {
    // A1 S3 H5 A1 = 10 → 1
    expect(calculateNumerology({ dateOfBirth: "2000-01-01", name: "Asha" }).namank?.value).toBe(1);
  });
});

describe("transits", () => {
  it("detects Sade Sati phase relative to the natal Moon", () => {
    const t = calculateTransits(new Date("2024-06-01T00:00:00Z"), "LAHIRI", 11);
    // Saturn was in sidereal Aquarius in mid-2024.
    expect(t.positions.find((p) => p.planet === "SATURN")!.sign).toBe(11);
    expect(t.sadeSati).toEqual({ active: true, phase: "PEAK" });
  });
});

describe("upcoming sky events", () => {
  const events = () => upcomingSkyEvents(new Date("2024-03-01T00:00:00Z"), 45);
  const find = (planet: string, type: string, sign: number) =>
    events().find((e) => e.planet === planet && e.type === type && e.sign === sign);

  it("finds Meena and Mesha Sankranti to the minute", () => {
    // Drik reference: Sun enters sidereal Pisces 14 Mar 2024 ~12:36 IST, Aries 13 Apr 2024 ~21:05 IST
    const meena = find("SUN", "INGRESS", 12)!;
    const mesha = find("SUN", "INGRESS", 1)!;
    expect(Math.abs(meena.at.getTime() - Date.parse("2024-03-14T07:06Z"))).toBeLessThan(10 * 60_000);
    expect(Math.abs(mesha.at.getTime() - Date.parse("2024-04-13T15:35Z"))).toBeLessThan(10 * 60_000);
  });

  it("finds the April 2024 Mercury retrograde station", () => {
    const station = find("MERCURY", "RETROGRADE", 1)!;
    expect(Math.abs(station.at.getTime() - Date.parse("2024-04-01T22:14Z"))).toBeLessThan(30 * 60_000);
  });

  it("returns events in time order including Moon ingresses about every 2.5 days", () => {
    const list = events();
    expect(list.map((e) => e.at.getTime())).toEqual([...list].map((e) => e.at.getTime()).sort((a, b) => a - b));
    const moon = list.filter((e) => e.planet === "MOON");
    expect(moon.length).toBeGreaterThanOrEqual(16);
    expect(moon.length).toBeLessThanOrEqual(21);
  });
});
