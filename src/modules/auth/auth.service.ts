import { env } from "../../config/env.js";
import { audit } from "../../lib/audit.js";
import { randomToken, sha256 } from "../../lib/crypto.js";
import { emails, sendMail } from "../../lib/email.js";
import { badRequest, conflict, forbidden, unauthorized } from "../../lib/errors.js";
import { REFRESH_TTL_SECONDS, signAccessToken } from "../../lib/jwt.js";
import { logger } from "../../lib/logger.js";
import { burnPasswordCheck, hashPassword, verifyPassword } from "../../lib/password.js";
import { prisma } from "../../lib/prisma.js";

const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 60 * 60 * 1000;

export const publicUserSelect = {
  id: true,
  email: true,
  name: true,
  role: true,
  status: true,
  emailVerifiedAt: true,
  preferredLanguage: true,
  timezone: true,
  imageUrl: true,
  createdAt: true,
} as const;

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

type SessionMeta = { userAgent?: string };

export async function createSession(user: { id: string; role: import("../../generated/prisma/enums.js").Role }, meta: SessionMeta) {
  const refreshToken = randomToken(48);
  const session = await prisma.refreshSession.create({
    data: {
      userId: user.id,
      tokenHash: sha256(refreshToken),
      userAgent: meta.userAgent?.slice(0, 255),
      expiresAt: new Date(Date.now() + REFRESH_TTL_SECONDS * 1000),
    },
  });
  const accessToken = signAccessToken({ sub: user.id, role: user.role, sid: session.id });
  return { accessToken, refreshToken };
}

async function issueVerification(user: { id: string; email: string; name: string }) {
  const token = randomToken();
  await prisma.verificationToken.create({
    data: { userId: user.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + VERIFY_TTL_MS) },
  });
  const link = `${env.FRONTEND_URL}/verify-email?token=${encodeURIComponent(token)}`;
  await sendMail({ to: user.email, ...emails.verifyEmail(user.name, link) }).catch((err) =>
    logger.error({ err }, "Failed to send verification email"),
  );
}

export async function register(input: { name: string; email: string; password: string }, meta: SessionMeta) {
  const email = normalizeEmail(input.email);
  const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (existing) throw conflict("An account with this email already exists");

  const user = await prisma.user.create({
    data: { email, name: input.name.trim(), passwordHash: await hashPassword(input.password) },
    select: publicUserSelect,
  });

  await issueVerification(user);
  const tokens = await createSession(user, meta);
  return { user, ...tokens };
}

export async function login(input: { email: string; password: string }, meta: SessionMeta) {
  const email = normalizeEmail(input.email);
  const user = await prisma.user.findUnique({ where: { email } });

  if (!user || !user.passwordHash) {
    await burnPasswordCheck(input.password);
    throw unauthorized("Invalid email or password");
  }
  if (!(await verifyPassword(input.password, user.passwordHash))) {
    throw unauthorized("Invalid email or password");
  }
  if (user.status === "SUSPENDED") throw forbidden("This account has been suspended. Please contact support.");

  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  const tokens = await createSession(user, meta);
  const publicUser = await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: publicUserSelect });
  return { user: publicUser, ...tokens };
}

/**
 * Rotates a refresh token. Presenting an already-rotated token signals theft, so every
 * session of that user is revoked.
 */
export async function refresh(refreshToken: string, meta: SessionMeta) {
  const session = await prisma.refreshSession.findUnique({
    where: { tokenHash: sha256(refreshToken) },
    include: { user: { select: { id: true, role: true, status: true } } },
  });
  if (!session) throw unauthorized("Session expired");

  if (session.revokedAt) {
    await prisma.refreshSession.updateMany({
      where: { userId: session.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    logger.warn({ userId: session.userId }, "Refresh token reuse detected; all sessions revoked");
    throw unauthorized("Session expired");
  }
  if (session.expiresAt < new Date() || session.user.status === "SUSPENDED") throw unauthorized("Session expired");

  const [, tokens] = await prisma.$transaction(async (tx) => {
    const revoked = await tx.refreshSession.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
    const next = randomToken(48);
    const created = await tx.refreshSession.create({
      data: {
        userId: session.userId,
        tokenHash: sha256(next),
        userAgent: meta.userAgent?.slice(0, 255),
        expiresAt: new Date(Date.now() + REFRESH_TTL_SECONDS * 1000),
      },
    });
    return [
      revoked,
      {
        refreshToken: next,
        accessToken: signAccessToken({ sub: session.user.id, role: session.user.role, sid: created.id }),
      },
    ] as const;
  });
  return tokens;
}

export async function logout(sessionId: string | undefined, refreshToken: string | undefined) {
  const now = new Date();
  if (sessionId) await prisma.refreshSession.updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt: now } });
  if (refreshToken) {
    await prisma.refreshSession.updateMany({
      where: { tokenHash: sha256(refreshToken), revokedAt: null },
      data: { revokedAt: now },
    });
  }
}

export async function verifyEmail(token: string) {
  const row = await prisma.verificationToken.findUnique({ where: { tokenHash: sha256(token) } });
  if (!row || row.usedAt || row.expiresAt < new Date()) throw badRequest("This verification link is invalid or has expired");

  await prisma.$transaction([
    prisma.verificationToken.update({ where: { id: row.id }, data: { usedAt: new Date() } }),
    prisma.user.update({ where: { id: row.userId }, data: { emailVerifiedAt: new Date() } }),
  ]);
}

export async function resendVerification(userId: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (user.emailVerifiedAt) throw badRequest("Email is already verified");
  await prisma.verificationToken.updateMany({ where: { userId, usedAt: null }, data: { usedAt: new Date() } });
  await issueVerification(user);
}

/** Always resolves, whether or not the email exists, to avoid account enumeration. */
export async function forgotPassword(emailInput: string) {
  const user = await prisma.user.findUnique({ where: { email: normalizeEmail(emailInput) } });
  if (!user || user.status === "SUSPENDED") return;

  await prisma.passwordResetToken.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: new Date() } });
  const token = randomToken();
  await prisma.passwordResetToken.create({
    data: { userId: user.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + RESET_TTL_MS) },
  });
  const link = `${env.FRONTEND_URL}/reset-password?token=${encodeURIComponent(token)}`;
  await sendMail({ to: user.email, ...emails.resetPassword(user.name, link) }).catch((err) =>
    logger.error({ err }, "Failed to send password reset email"),
  );
}

export async function resetPassword(token: string, password: string) {
  const row = await prisma.passwordResetToken.findUnique({ where: { tokenHash: sha256(token) } });
  if (!row || row.usedAt || row.expiresAt < new Date()) throw badRequest("This reset link is invalid or has expired");

  const passwordHash = await hashPassword(password);
  await prisma.$transaction([
    prisma.passwordResetToken.update({ where: { id: row.id }, data: { usedAt: new Date() } }),
    prisma.user.update({ where: { id: row.userId }, data: { passwordHash } }),
    // Resetting via the emailed link also proves ownership of the address.
    prisma.user.updateMany({
      where: { id: row.userId, emailVerifiedAt: null },
      data: { emailVerifiedAt: new Date() },
    }),
    prisma.refreshSession.updateMany({ where: { userId: row.userId, revokedAt: null }, data: { revokedAt: new Date() } }),
  ]);
  await audit({ actorId: row.userId, action: "auth.password_reset", entityType: "User", entityId: row.userId });
}

export async function changePassword(userId: string, sessionId: string, current: string, next: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (user.passwordHash && !(await verifyPassword(current, user.passwordHash))) {
    throw badRequest("Current password is incorrect");
  }
  await prisma.$transaction([
    prisma.user.update({ where: { id: userId }, data: { passwordHash: await hashPassword(next) } }),
    // Sign out every other device.
    prisma.refreshSession.updateMany({
      where: { userId, revokedAt: null, NOT: { id: sessionId } },
      data: { revokedAt: new Date() },
    }),
  ]);
  await audit({ actorId: userId, action: "auth.password_changed", entityType: "User", entityId: userId });
}

export async function getMe(userId: string) {
  return prisma.user.findUniqueOrThrow({ where: { id: userId }, select: publicUserSelect });
}
