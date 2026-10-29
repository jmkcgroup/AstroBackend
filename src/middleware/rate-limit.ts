import { rateLimit } from "express-rate-limit";
import { env } from "../config/env.js";

const make = (limit: number, windowMinutes: number, message: string) =>
  rateLimit({
    windowMs: windowMinutes * 60 * 1000,
    limit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    skip: () => env.NODE_ENV === "test",
    message: { error: { code: "RATE_LIMITED", message } },
  });

/** Login / register / password-reset: small budget per IP. */
export const authLimiter = make(20, 15, "Too many attempts. Please try again in a few minutes.");
/** Emails sent on demand (verification resend, forgot password). */
export const emailLimiter = make(5, 60, "Too many email requests. Please try again later.");
/** Public calculation tools (CPU-bound ephemeris work). */
export const toolLimiter = make(120, 15, "Too many calculations. Please slow down.");
/** Contact form and newsletter. */
export const formLimiter = make(5, 60, "Too many submissions. Please try again later.");
/** Checkout creation (each call opens an order at the payment provider). */
export const checkoutLimiter = make(30, 15, "Too many checkout attempts. Please try again in a few minutes.");
/** Incoming payment-provider webhooks. */
export const webhookLimiter = make(300, 1, "Too many webhook deliveries.");
/** General API budget. */
export const apiLimiter = make(600, 15, "Too many requests. Please slow down.");
