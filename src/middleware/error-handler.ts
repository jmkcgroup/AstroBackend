import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";
import { EphemerisUnavailableError } from "../astrology/ephemeris.js";
import { AppError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";

export const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(404).json({ error: { code: "NOT_FOUND", message: "Route not found" } });
};

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof AppError) {
    res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details },
    });
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "Invalid request",
        details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      },
    });
    return;
  }

  if (err instanceof EphemerisUnavailableError) {
    logger.error({ err: err.message }, "Astrology engine unavailable");
    res.status(503).json({ error: { code: "ENGINE_UNAVAILABLE", message: err.message } });
    return;
  }

  // Calculation input outside a valid domain (impossible date, polar sunrise, unknown zone...).
  if (err instanceof RangeError) {
    res.status(400).json({ error: { code: "INVALID_INPUT", message: err.message } });
    return;
  }

  // Malformed JSON body
  if (err instanceof SyntaxError && "body" in err) {
    res.status(400).json({ error: { code: "BAD_JSON", message: "Request body is not valid JSON" } });
    return;
  }

  logger.error({ err, path: req.path, method: req.method }, "Unhandled error");
  res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Something went wrong" } });
};
