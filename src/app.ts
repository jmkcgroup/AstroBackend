import express from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import { pinoHttp } from "pino-http";
import { env } from "./config/env.js";
import { logger } from "./lib/logger.js";
import { authenticate } from "./middleware/auth.js";
import { originCheck } from "./middleware/csrf.js";
import { errorHandler, notFoundHandler } from "./middleware/error-handler.js";
import { apiLimiter, webhookLimiter } from "./middleware/rate-limit.js";
import { paymentsRouter, razorpayWebhook } from "./modules/payments/payments.routes.js";
import { healthRouter } from "./modules/health/health.routes.js";
import { authRouter } from "./modules/auth/auth.routes.js";
import { usersRouter } from "./modules/users/users.routes.js";
import { birthProfilesRouter } from "./modules/birth-profiles/birth-profiles.routes.js";
import { chartsRouter } from "./modules/charts/charts.routes.js";
import { toolsRouter } from "./modules/tools/tools.routes.js";
import { contentRouter } from "./modules/content/content.routes.js";
import { contactRouter } from "./modules/contact/contact.routes.js";
import { reportsRouter } from "./modules/reports/reports.routes.js";
import { astrologerSelfRouter, astrologersRouter, bookingsRouter } from "./modules/consultations/consultations.routes.js";
import { adminRouter } from "./modules/admin/admin.routes.js";

export function createApp() {
  const app = express();

  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(helmet());
  app.use(cors({ origin: env.FRONTEND_URL, credentials: true }));
  // Webhook signatures cover the exact bytes, so this route gets the raw body and no CSRF/auth.
  app.post("/api/payments/webhook/razorpay", webhookLimiter, express.raw({ type: "*/*", limit: "1mb" }), razorpayWebhook);
  app.use(express.json({ limit: "100kb" }));
  app.use(cookieParser());
  app.use(
    pinoHttp({
      logger,
      autoLogging: env.NODE_ENV !== "test",
      // Log the path only: query strings may carry coordinates or dates.
      serializers: { req: (req: { method: string; url: string }) => ({ method: req.method, path: req.url.split("?")[0] }) },
    }),
  );

  app.use("/api/health", healthRouter);

  app.use("/api", apiLimiter, originCheck, authenticate);
  // Authenticated responses must never be cached by shared caches.
  app.use("/api", (req, res, next) => {
    if (req.auth) res.set("Cache-Control", "private, no-store");
    next();
  });

  app.use("/api/auth", authRouter);
  app.use("/api/users", usersRouter);
  app.use("/api/birth-profiles", birthProfilesRouter);
  app.use("/api/charts", chartsRouter);
  app.use("/api/tools", toolsRouter);
  app.use("/api/content", contentRouter);
  app.use("/api/reports", reportsRouter);
  app.use("/api/payments", paymentsRouter);
  app.use("/api/astrologers", astrologersRouter);
  app.use("/api/bookings", bookingsRouter);
  app.use("/api/astrologer", astrologerSelfRouter);
  app.use("/api/admin", adminRouter);
  app.use("/api", contactRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
