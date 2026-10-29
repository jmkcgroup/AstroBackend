// Public free-tool endpoints. Inputs (birth data) are never stored or logged here;
// only an anonymous usage counter is recorded.
import { Router } from "express";
import { z } from "zod";
import type { Prisma } from "../../generated/prisma/client.js";
import { calculateChart, METHODOLOGY } from "../../astrology/chart.js";
import { NAKSHATRAS, SIGNS } from "../../astrology/constants.js";
import { ENGINE_VERSION, tropicalLongitude } from "../../astrology/ephemeris.js";
import { gunaMilan } from "../../astrology/matching.js";
import { calculateNumerology } from "../../astrology/numerology.js";
import { calculatePanchang } from "../../astrology/panchang.js";
import { isValidTimeZone } from "../../astrology/time.js";
import { calculateTransits, upcomingSkyEvents } from "../../astrology/transit.js";
import { dateToJulianDay } from "../../astrology/time.js";
import { prisma } from "../../lib/prisma.js";
import { toolLimiter } from "../../middleware/rate-limit.js";
import { validate } from "../../middleware/validate.js";
import type { ToolType } from "../../generated/prisma/enums.js";
import { searchPlaces, timezoneFor } from "./geocode.service.js";

export const toolsRouter = Router();
toolsRouter.use(toolLimiter);

const birthSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD"),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, "Use 24-hour HH:mm"),
  timezone: z.string().refine(isValidTimeZone, "Unknown IANA time zone"),
  latitude: z.coerce.number().min(-90).max(90),
  longitude: z.coerce.number().min(-180).max(180),
  ayanamsha: z.enum(["LAHIRI", "RAMAN", "KRISHNAMURTI"]).default("LAHIRI"),
});

const track = (tool: ToolType, userId?: string) =>
  prisma.toolUsage.create({ data: { tool, userId: userId ?? null } }).catch(() => undefined);

toolsRouter.post("/kundli", validate({ body: birthSchema }), async (req, res) => {
  const chart = calculateChart(req.body);
  void track("KUNDLI", req.auth?.userId);
  res.json({ chart: { ...chart, methodology: METHODOLOGY } });
});

toolsRouter.post(
  "/matching",
  validate({ body: z.object({ boy: birthSchema, girl: birthSchema }) }),
  async (req, res) => {
    const boy = calculateChart(req.body.boy);
    const girl = calculateChart(req.body.girl);
    const moon = (c: typeof boy) => c.planets.find((p) => p.planet === "MOON")!.longitude;
    void track("MATCHING", req.auth?.userId);
    res.json({ result: gunaMilan({ moonLongitude: moon(boy) }, { moonLongitude: moon(girl) }) });
  },
);

toolsRouter.get(
  "/panchang",
  validate({
    query: z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      latitude: z.coerce.number().min(-66).max(66),
      longitude: z.coerce.number().min(-180).max(180),
      timezone: z.string().refine(isValidTimeZone, "Unknown IANA time zone"),
    }),
  }),
  async (req, res) => {
    const q = res.locals.query as { date: string; latitude: number; longitude: number; timezone: string };
    // Cache by ~1 km grid so repeated lookups for a city reuse one calculation.
    const lat = Math.round(q.latitude * 100) / 100;
    const lon = Math.round(q.longitude * 100) / 100;
    const key = {
      date: new Date(`${q.date}T00:00:00Z`),
      latitude: lat.toFixed(2),
      longitude: lon.toFixed(2),
      timezone: q.timezone,
      engineVersion: ENGINE_VERSION,
    };
    const cached = await prisma.panchangEntry.findUnique({
      where: { date_latitude_longitude_timezone_engineVersion: key },
    });
    let data: unknown = cached?.data;
    if (!data) {
      const p = calculatePanchang({ date: q.date, latitude: lat, longitude: lon, timezone: q.timezone });
      const json = JSON.parse(JSON.stringify(p)) as Prisma.InputJsonValue;
      await prisma.panchangEntry
        .create({ data: { ...key, data: json } })
        .catch(() => undefined); // concurrent insert of the same key is harmless
      data = json;
    }
    void track("PANCHANG", req.auth?.userId);
    res.set("Cache-Control", "public, max-age=3600");
    res.json({ panchang: data });
  },
);

toolsRouter.post(
  "/numerology",
  validate({
    body: z.object({
      dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      name: z.string().trim().max(120).optional(),
    }),
  }),
  async (req, res) => {
    void track("NUMEROLOGY", req.auth?.userId);
    res.json({ result: calculateNumerology(req.body) });
  },
);

toolsRouter.post("/nakshatra", validate({ body: birthSchema }), async (req, res) => {
  const chart = calculateChart(req.body);
  const moon = chart.planets.find((p) => p.planet === "MOON")!;
  const n = NAKSHATRAS[moon.nakshatra - 1]!;
  void track("NAKSHATRA", req.auth?.userId);
  res.json({
    result: {
      nakshatra: moon.nakshatra,
      name: n.en,
      hi: n.hi,
      pada: moon.pada,
      lord: n.lord,
      gana: n.gana,
      yoni: n.yoni,
      nadi: n.nadi,
      moonLongitude: moon.longitude,
      ayanamsha: chart.ayanamsha,
      timeAmbiguity: chart.timeAmbiguity,
    },
  });
});

toolsRouter.post("/rashi", validate({ body: birthSchema }), async (req, res) => {
  const chart = calculateChart(req.body);
  const moon = chart.planets.find((p) => p.planet === "MOON")!;
  const sun = chart.planets.find((p) => p.planet === "SUN")!;
  const tropicalSun = tropicalLongitude(dateToJulianDay(chart.utcDateTime), "SUN");
  const tropicalSign = Math.floor(tropicalSun / 30) + 1;
  void track("RASHI", req.auth?.userId);
  res.json({
    result: {
      vedic: {
        moonSign: moon.sign, // Janma Rashi
        moonSignName: SIGNS[moon.sign - 1],
        sunSign: sun.sign,
        sunSignName: SIGNS[sun.sign - 1],
        lagnaSign: chart.ascendant.sign,
      },
      western: { sunSign: tropicalSign, sunSignName: SIGNS[tropicalSign - 1]!.en, sunLongitude: tropicalSun },
      ayanamshaValue: chart.ayanamshaValue,
      explanation:
        "Vedic astrology uses the sidereal zodiac, offset from the Western tropical zodiac by the ayanamsha (about 24° today). Your Janma Rashi is the sidereal sign of the Moon, which is why it usually differs from your Western Sun sign.",
    },
  });
});

toolsRouter.get(
  "/transits",
  validate({ query: z.object({ date: z.iso.datetime({ offset: true }).optional(), moonSign: z.coerce.number().int().min(1).max(12).optional() }) }),
  async (req, res) => {
    const q = res.locals.query as { date?: string; moonSign?: number };
    void track("TRANSIT", req.auth?.userId);
    res.json({ transits: calculateTransits(q.date ? new Date(q.date) : new Date(), "LAHIRI", q.moonSign) });
  },
);

// Current sky for the homepage hero; identical for everyone, so cached for 10 minutes.
let skyCache: { at: number; body: unknown } | null = null;
toolsRouter.get("/sky", async (_req, res) => {
  if (!skyCache || Date.now() - skyCache.at > 10 * 60 * 1000) {
    const t = calculateTransits(new Date());
    skyCache = {
      at: Date.now(),
      body: {
        moment: t.moment,
        positions: t.positions.map((p) => ({
          planet: p.planet,
          longitude: p.longitude,
          sign: p.sign,
          nakshatraName: p.nakshatraName,
          isRetrograde: p.isRetrograde,
        })),
      },
    };
  }
  res.set("Cache-Control", "public, max-age=600");
  res.json(skyCache.body);
});

// Upcoming sign changes and stations; the same for everyone, so cached for an hour.
let eventsCache: { at: number; body: unknown } | null = null;
toolsRouter.get("/sky/events", async (_req, res) => {
  if (!eventsCache || Date.now() - eventsCache.at > 60 * 60 * 1000) {
    const now = new Date();
    eventsCache = { at: Date.now(), body: { from: now, days: 45, events: upcomingSkyEvents(now, 45) } };
  }
  res.set("Cache-Control", "public, max-age=900");
  res.json(eventsCache.body);
});

toolsRouter.get(
  "/geocode",
  validate({ query: z.object({ q: z.string().trim().min(2).max(120), lang: z.enum(["en", "hi"]).default("en") }) }),
  async (req, res) => {
    const q = res.locals.query as { q: string; lang: "en" | "hi" };
    res.json({ places: await searchPlaces(q.q, q.lang) });
  },
);

toolsRouter.get(
  "/timezone",
  validate({ query: z.object({ latitude: z.coerce.number().min(-90).max(90), longitude: z.coerce.number().min(-180).max(180) }) }),
  (req, res) => {
    const q = res.locals.query as { latitude: number; longitude: number };
    res.json({ timezone: timezoneFor(q.latitude, q.longitude) });
  },
);
