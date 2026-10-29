import { env } from "./config/env.js";
import { createApp } from "./app.js";
import { initEphemeris } from "./astrology/ephemeris.js";
import { logger } from "./lib/logger.js";
import { prisma } from "./lib/prisma.js";
import { startBookingSweeper } from "./modules/consultations/bookings.service.js";
import { startReportWorker } from "./reports/reports.service.js";

const ephemeris = initEphemeris(env.SWISSEPH_EPHE_PATH);
if (!ephemeris.ok) {
  logger.error(
    { missing: ephemeris.missing },
    "Swiss Ephemeris files not found: astrology endpoints will return 503 until SWISSEPH_EPHE_PATH is fixed",
  );
}

const app = createApp();

const server = app.listen(env.PORT, () => {
  logger.info(`AstroVeda API listening on http://localhost:${env.PORT}`);
  startReportWorker().catch((err) => logger.error({ err }, "Report worker failed to start"));
  startBookingSweeper();
});

async function shutdown(signal: string) {
  logger.info(`${signal} received, shutting down`);
  server.close();
  await prisma.$disconnect();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
