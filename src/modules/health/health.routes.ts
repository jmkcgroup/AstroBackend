import { Router } from "express";
import { features } from "../../config/env.js";
import { ephemerisStatus } from "../../astrology/ephemeris.js";
import { prisma } from "../../lib/prisma.js";

export const healthRouter = Router();

healthRouter.get("/", async (_req, res) => {
  let database: "up" | "down" = "up";
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    database = "down";
  }
  const astrology = ephemerisStatus();
  const ok = database === "up" && astrology.available;

  res.status(ok ? 200 : 503).json({
    status: ok ? "ok" : "degraded",
    database,
    astrology,
    integrations: features,
  });
});
