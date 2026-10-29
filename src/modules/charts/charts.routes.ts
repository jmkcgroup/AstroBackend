import { Router } from "express";
import { z } from "zod";
import { calculateTransits } from "../../astrology/transit.js";
import { prisma } from "../../lib/prisma.js";
import { currentUser, requireAuth } from "../../middleware/auth.js";
import { toolLimiter } from "../../middleware/rate-limit.js";
import { validate } from "../../middleware/validate.js";
import * as svc from "./charts.service.js";

export const chartsRouter = Router();
chartsRouter.use(requireAuth);

const idParams = z.object({ id: z.string().min(1).max(40) });
const langQuery = z.object({ lang: z.enum(["EN", "HI", "en", "hi"]).default("EN").transform((v) => v.toUpperCase() as "EN" | "HI") });

chartsRouter.get("/", async (req, res) => {
  res.json({ items: await svc.listUserCharts(currentUser(req).userId) });
});

/** Calculate (or reuse) the Kundli for one of the caller's birth profiles. */
chartsRouter.post(
  "/calculate",
  toolLimiter,
  validate({ body: z.object({ birthProfileId: z.string().min(1).max(40) }) }),
  async (req, res) => {
    const me = currentUser(req);
    const { chartId, reused } = await svc.calculateForProfile(me.userId, req.body.birthProfileId);
    await prisma.toolUsage.create({ data: { tool: "KUNDLI", userId: me.userId } });
    const row = await svc.getOwnedChartRow(me.userId, chartId);
    res.status(reused ? 200 : 201).json({ chart: svc.chartResponse(row), reused });
  },
);

chartsRouter.get("/:id", validate({ params: idParams }), async (req, res) => {
  const row = await svc.getOwnedChartRow(currentUser(req).userId, req.params.id as string);
  res.json({ chart: svc.chartResponse(row) });
});

chartsRouter.get("/:id/planets", validate({ params: idParams }), async (req, res) => {
  const row = await svc.getOwnedChartRow(currentUser(req).userId, req.params.id as string);
  res.json({ planets: svc.rowToChartResult(row).planets });
});

chartsRouter.get("/:id/houses", validate({ params: idParams }), async (req, res) => {
  const row = await svc.getOwnedChartRow(currentUser(req).userId, req.params.id as string);
  res.json({ houses: svc.rowToChartResult(row).houses });
});

chartsRouter.get("/:id/dashas", validate({ params: idParams }), async (req, res) => {
  const row = await svc.getOwnedChartRow(currentUser(req).userId, req.params.id as string);
  const dashas = svc.rowToChartResult(row).dashas;
  const now = new Date();
  res.json({
    mahadashas: dashas.filter((d) => d.level === "MAHADASHA"),
    antardashas: dashas.filter((d) => d.level === "ANTARDASHA"),
    current: {
      mahadasha: dashas.find((d) => d.level === "MAHADASHA" && d.startsAt <= now && d.endsAt > now) ?? null,
      antardasha: dashas.find((d) => d.level === "ANTARDASHA" && d.startsAt <= now && d.endsAt > now) ?? null,
    },
  });
});

chartsRouter.get("/:id/divisional/:division", validate({ params: idParams.extend({ division: z.enum(["D1", "D9", "d1", "d9"]) }) }), async (req, res) => {
  const row = await svc.getOwnedChartRow(currentUser(req).userId, req.params.id as string);
  const chart = svc.rowToChartResult(row);
  const division = (req.params.division as string).toUpperCase();
  res.json(
    division === "D1"
      ? { division, ascendantSign: chart.ascendant.sign, houses: chart.d1 }
      : { division, ascendantSign: chart.d9.ascendantSign, signs: chart.d9.signs },
  );
});

chartsRouter.get(
  "/:id/transits",
  validate({ params: idParams, query: z.object({ date: z.iso.datetime({ offset: true }).optional() }) }),
  async (req, res) => {
    const row = await svc.getOwnedChartRow(currentUser(req).userId, req.params.id as string);
    const chart = svc.rowToChartResult(row);
    const { date } = res.locals.query as { date?: string };
    res.json({ transits: calculateTransits(date ? new Date(date) : new Date(), chart.ayanamsha, chart.summary.moonSign) });
  },
);

chartsRouter.get("/:id/interpretations", validate({ params: idParams, query: langQuery }), async (req, res) => {
  const { lang } = res.locals.query as { lang: "EN" | "HI" };
  res.json(await svc.interpretationsFor(currentUser(req).userId, req.params.id as string, lang));
});

chartsRouter.post(
  "/:id/save",
  validate({ params: idParams, body: z.object({ label: z.string().trim().max(80).optional() }) }),
  async (req, res) => {
    res.json({ saved: await svc.saveChart(currentUser(req).userId, req.params.id as string, req.body.label) });
  },
);
