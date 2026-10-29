import type { Request, RequestHandler } from "express";
import type { Role } from "../generated/prisma/enums.js";
import { ACCESS_COOKIE } from "../lib/cookies.js";
import { forbidden, unauthorized } from "../lib/errors.js";
import { verifyAccessToken } from "../lib/jwt.js";
import { prisma } from "../lib/prisma.js";

/**
 * Resolves the caller from the access-token cookie. The user row and session are re-read on
 * every request so suspensions, role changes and logouts take effect immediately.
 */
export const authenticate: RequestHandler = async (req, _res, next) => {
  const token = req.cookies?.[ACCESS_COOKIE] as string | undefined;
  if (!token) return next();

  const claims = verifyAccessToken(token);
  if (!claims) return next();

  const session = await prisma.refreshSession.findUnique({
    where: { id: claims.sid },
    select: {
      revokedAt: true,
      expiresAt: true,
      user: { select: { id: true, role: true, status: true, email: true, name: true, emailVerifiedAt: true } },
    },
  });

  if (
    !session ||
    session.revokedAt ||
    session.expiresAt < new Date() ||
    session.user.id !== claims.sub ||
    session.user.status === "SUSPENDED"
  ) {
    return next();
  }

  req.auth = {
    userId: session.user.id,
    sessionId: claims.sid,
    role: session.user.role,
    email: session.user.email,
    name: session.user.name,
    emailVerified: session.user.emailVerifiedAt !== null,
  };
  next();
};

export const requireAuth: RequestHandler = (req, _res, next) => {
  if (!req.auth) throw unauthorized();
  next();
};

export const requireRole =
  (...roles: Role[]): RequestHandler =>
  (req, _res, next) => {
    if (!req.auth) throw unauthorized();
    if (!roles.includes(req.auth.role)) throw forbidden();
    next();
  };

export const requireVerifiedEmail: RequestHandler = (req, _res, next) => {
  if (!req.auth) throw unauthorized();
  if (!req.auth.emailVerified) throw forbidden("Please verify your email address first");
  next();
};

/** Narrowing helper for handlers mounted behind requireAuth. */
export function currentUser(req: Request) {
  if (!req.auth) throw unauthorized();
  return req.auth;
}
