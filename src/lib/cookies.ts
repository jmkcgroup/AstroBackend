import type { CookieOptions, Response } from "express";
import { env } from "../config/env.js";
import { ACCESS_TTL_SECONDS, REFRESH_TTL_SECONDS } from "./jwt.js";

export const ACCESS_COOKIE = "av_access";
export const REFRESH_COOKIE = "av_refresh";

const base: CookieOptions = {
  httpOnly: true,
  secure: env.NODE_ENV === "production",
  sameSite: "lax",
  ...(env.COOKIE_DOMAIN && { domain: env.COOKIE_DOMAIN }),
};

// The refresh cookie is only sent to the auth endpoints that need it.
const refreshOptions: CookieOptions = { ...base, path: "/api/auth" };

// Non-secret marker so the frontend can tell (before any API call) that a session may exist,
// even after the short-lived access cookie has expired. It grants nothing by itself.
export const SESSION_HINT_COOKIE = "av_session";

export function setAuthCookies(res: Response, accessToken: string, refreshToken: string) {
  res.cookie(ACCESS_COOKIE, accessToken, { ...base, path: "/", maxAge: ACCESS_TTL_SECONDS * 1000 });
  res.cookie(REFRESH_COOKIE, refreshToken, { ...refreshOptions, maxAge: REFRESH_TTL_SECONDS * 1000 });
  res.cookie(SESSION_HINT_COOKIE, "1", { ...base, path: "/", maxAge: REFRESH_TTL_SECONDS * 1000 });
}

export function clearAuthCookies(res: Response) {
  res.clearCookie(ACCESS_COOKIE, { ...base, path: "/" });
  res.clearCookie(REFRESH_COOKIE, refreshOptions);
  res.clearCookie(SESSION_HINT_COOKIE, { ...base, path: "/" });
}
