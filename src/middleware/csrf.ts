import type { RequestHandler } from "express";
import { env } from "../config/env.js";
import { forbidden } from "../lib/errors.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const allowedOrigins = new Set([new URL(env.FRONTEND_URL).origin, `http://localhost:${env.PORT}`]);

/**
 * CSRF defence for cookie-authenticated requests: state-changing requests must come from the
 * frontend origin (checked via Origin, falling back to Referer). SameSite=Lax cookies are the
 * first layer; this is the second. Webhooks are mounted before this middleware.
 */
export const originCheck: RequestHandler = (req, _res, next) => {
  if (SAFE_METHODS.has(req.method)) return next();

  const origin = req.get("origin") ?? (req.get("referer") ? new URL(req.get("referer")!).origin : undefined);
  // Non-browser clients (curl, server-to-server from Next.js) send no Origin and carry no ambient cookies
  // unless explicitly forwarded, so only reject when an Origin is present and foreign.
  if (origin && !allowedOrigins.has(origin)) throw forbidden("Cross-origin request blocked");
  next();
};
