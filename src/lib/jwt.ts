import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import type { Role } from "../generated/prisma/enums.js";

export type AccessClaims = { sub: string; role: Role; sid: string };

export const ACCESS_TTL_SECONDS = 15 * 60;
export const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;

export function signAccessToken(claims: AccessClaims): string {
  return jwt.sign(claims, env.JWT_ACCESS_SECRET, {
    algorithm: "HS256",
    expiresIn: ACCESS_TTL_SECONDS,
    issuer: "astroveda",
    audience: "astroveda-web",
  });
}

export function verifyAccessToken(token: string): AccessClaims | null {
  try {
    const payload = jwt.verify(token, env.JWT_ACCESS_SECRET, {
      algorithms: ["HS256"],
      issuer: "astroveda",
      audience: "astroveda-web",
    });
    if (typeof payload === "string" || !payload.sub) return null;
    return { sub: payload.sub, role: payload.role as Role, sid: payload.sid as string };
  } catch {
    return null;
  }
}
