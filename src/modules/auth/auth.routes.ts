import { Router } from "express";
import { z } from "zod";
import { env, features } from "../../config/env.js";
import { REFRESH_COOKIE, clearAuthCookies, setAuthCookies } from "../../lib/cookies.js";
import { randomToken, safeEqual } from "../../lib/crypto.js";
import { forbidden, unauthorized } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import { passwordSchema } from "../../lib/password.js";
import { currentUser, requireAuth } from "../../middleware/auth.js";
import { authLimiter, emailLimiter } from "../../middleware/rate-limit.js";
import { validate } from "../../middleware/validate.js";
import * as auth from "./auth.service.js";
import { exchangeGoogleCode, googleAuthUrl, upsertGoogleUser } from "./google.service.js";

export const authRouter = Router();

const emailSchema = z.email("Enter a valid email address").max(254);

const registerSchema = z
  .object({
    name: z.string().trim().min(2, "Name is too short").max(80),
    email: emailSchema,
    password: passwordSchema,
    confirmPassword: z.string(),
    acceptTerms: z.literal(true, { error: "You must accept the Terms and Privacy Policy" }),
  })
  .refine((d) => d.password === d.confirmPassword, { path: ["confirmPassword"], message: "Passwords do not match" });

const meta = (req: import("express").Request) => ({ userAgent: req.get("user-agent") });

authRouter.get("/providers", (_req, res) => {
  res.json({ google: features.googleOAuth });
});

authRouter.post("/register", authLimiter, validate({ body: registerSchema }), async (req, res) => {
  const { user, accessToken, refreshToken } = await auth.register(req.body, meta(req));
  setAuthCookies(res, accessToken, refreshToken);
  res.status(201).json({ user });
});

authRouter.post(
  "/login",
  authLimiter,
  validate({ body: z.object({ email: emailSchema, password: z.string().min(1).max(128) }) }),
  async (req, res) => {
    const { user, accessToken, refreshToken } = await auth.login(req.body, meta(req));
    setAuthCookies(res, accessToken, refreshToken);
    res.json({ user });
  },
);

authRouter.post("/refresh", authLimiter, async (req, res) => {
  const token = req.cookies?.[REFRESH_COOKIE] as string | undefined;
  if (!token) throw unauthorized("Session expired");
  try {
    const { accessToken, refreshToken } = await auth.refresh(token, meta(req));
    setAuthCookies(res, accessToken, refreshToken);
    res.json({ ok: true });
  } catch (err) {
    clearAuthCookies(res);
    throw err;
  }
});

authRouter.post("/logout", async (req, res) => {
  await auth.logout(req.auth?.sessionId, req.cookies?.[REFRESH_COOKIE]);
  clearAuthCookies(res);
  res.status(204).end();
});

authRouter.get("/me", requireAuth, async (req, res) => {
  res.json({ user: await auth.getMe(currentUser(req).userId) });
});

authRouter.post("/verify-email", authLimiter, validate({ body: z.object({ token: z.string().min(10).max(200) }) }), async (req, res) => {
  await auth.verifyEmail(req.body.token);
  res.json({ ok: true });
});

authRouter.post("/resend-verification", requireAuth, emailLimiter, async (req, res) => {
  await auth.resendVerification(currentUser(req).userId);
  res.json({ ok: true });
});

authRouter.post("/forgot-password", emailLimiter, validate({ body: z.object({ email: emailSchema }) }), async (req, res) => {
  await auth.forgotPassword(req.body.email);
  // Same response whether or not the account exists.
  res.json({ ok: true, message: "If an account exists for this email, a reset link has been sent." });
});

authRouter.post(
  "/reset-password",
  authLimiter,
  validate({
    body: z
      .object({ token: z.string().min(10).max(200), password: passwordSchema, confirmPassword: z.string() })
      .refine((d) => d.password === d.confirmPassword, { path: ["confirmPassword"], message: "Passwords do not match" }),
  }),
  async (req, res) => {
    await auth.resetPassword(req.body.token, req.body.password);
    clearAuthCookies(res);
    res.json({ ok: true });
  },
);

authRouter.post(
  "/change-password",
  requireAuth,
  authLimiter,
  validate({ body: z.object({ currentPassword: z.string().max(128).default(""), newPassword: passwordSchema }) }),
  async (req, res) => {
    const me = currentUser(req);
    await auth.changePassword(me.userId, me.sessionId, req.body.currentPassword, req.body.newPassword);
    res.json({ ok: true });
  },
);

// ── Google OAuth ──────────────────────────────────────────────
const OAUTH_STATE_COOKIE = "av_oauth_state";

authRouter.get("/google", (req, res) => {
  const state = randomToken(24);
  const next = typeof req.query.next === "string" && req.query.next.startsWith("/") && !req.query.next.startsWith("//") ? req.query.next : "/dashboard";
  res.cookie(OAUTH_STATE_COOKIE, JSON.stringify({ state, next }), {
    httpOnly: true,
    sameSite: "lax",
    secure: env.NODE_ENV === "production",
    maxAge: 10 * 60 * 1000,
    path: "/api/auth/google",
  });
  res.redirect(googleAuthUrl(state));
});

authRouter.get("/google/callback", async (req, res) => {
  const fail = (reason: string) => res.redirect(`${env.FRONTEND_URL}/login?error=${encodeURIComponent(reason)}`);
  try {
    const raw = req.cookies?.[OAUTH_STATE_COOKIE] as string | undefined;
    res.clearCookie(OAUTH_STATE_COOKIE, { path: "/api/auth/google" });
    const saved = raw ? (JSON.parse(raw) as { state: string; next: string }) : null;
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const code = typeof req.query.code === "string" ? req.query.code : "";
    if (!saved || !state || !safeEqual(saved.state, state) || !code) throw forbidden("Invalid OAuth state");

    const profile = await exchangeGoogleCode(code);
    const user = await upsertGoogleUser(profile);
    if (user.status === "SUSPENDED") return fail("suspended");

    const { accessToken, refreshToken } = await auth.createSession(user, meta(req));
    setAuthCookies(res, accessToken, refreshToken);
    res.redirect(`${env.FRONTEND_URL}${saved.next}`);
  } catch (err) {
    logger.warn({ err }, "Google OAuth callback failed");
    fail("google");
  }
});
