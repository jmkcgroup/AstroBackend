// Google OAuth 2.0 authorization-code flow (optional; enabled when credentials are set).
import { env, features } from "../../config/env.js";
import { serviceUnavailable, unauthorized } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import { normalizeEmail } from "./auth.service.js";

// The frontend proxies /api/* to this server, so the callback lives on the site origin.
export const googleRedirectUri = () => `${env.FRONTEND_URL}/api/auth/google/callback`;

export function googleAuthUrl(state: string): string {
  if (!features.googleOAuth) throw serviceUnavailable("Google sign-in is not configured");
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID!,
    redirect_uri: googleRedirectUri(),
    response_type: "code",
    scope: "openid email profile",
    state,
    prompt: "select_account",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

type GoogleProfile = { sub: string; email: string; email_verified: boolean; name?: string; picture?: string };

export async function exchangeGoogleCode(code: string): Promise<GoogleProfile> {
  if (!features.googleOAuth) throw serviceUnavailable("Google sign-in is not configured");

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID!,
      client_secret: env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: googleRedirectUri(),
      grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) throw unauthorized("Google sign-in failed");
  const { access_token } = (await tokenRes.json()) as { access_token?: string };
  if (!access_token) throw unauthorized("Google sign-in failed");

  const infoRes = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${access_token}` },
  });
  if (!infoRes.ok) throw unauthorized("Google sign-in failed");
  return (await infoRes.json()) as GoogleProfile;
}

/** Finds or creates the user for a Google identity. Only verified Google emails are linked. */
export async function upsertGoogleUser(profile: GoogleProfile) {
  if (!profile.email_verified) throw unauthorized("Your Google email address is not verified");

  const linked = await prisma.oAuthAccount.findUnique({
    where: { provider_providerAccountId: { provider: "google", providerAccountId: profile.sub } },
    include: { user: true },
  });
  if (linked) return linked.user;

  const email = normalizeEmail(profile.email);
  return prisma.$transaction(async (tx) => {
    const existing = await tx.user.findUnique({ where: { email } });
    const user =
      existing ??
      (await tx.user.create({
        data: { email, name: profile.name ?? email.split("@")[0]!, imageUrl: profile.picture, emailVerifiedAt: new Date() },
      }));
    if (existing && !existing.emailVerifiedAt) {
      await tx.user.update({ where: { id: existing.id }, data: { emailVerifiedAt: new Date() } });
    }
    await tx.oAuthAccount.create({ data: { userId: user.id, provider: "google", providerAccountId: profile.sub } });
    return user;
  });
}
