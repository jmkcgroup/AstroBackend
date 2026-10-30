import { env } from "../config/env.js";
import { hashPassword, passwordSchema } from "../lib/password.js";
import { prisma } from "../lib/prisma.js";

/**
 * Creates the admin account from SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD on server start, so the
 * admin can log in from the site without running `npm run db:seed`. Idempotent: an existing
 * account keeps its password and is only promoted to ADMIN.
 */
export async function ensureAdmin(): Promise<string | null> {
  const email = env.SEED_ADMIN_EMAIL?.trim().toLowerCase();
  const password = env.SEED_ADMIN_PASSWORD;
  if (!email || !password) return null;

  const existing = await prisma.user.findUnique({ where: { email }, select: { id: true, role: true } });
  if (existing) {
    if (existing.role !== "ADMIN") await prisma.user.update({ where: { id: existing.id }, data: { role: "ADMIN" } });
    return email;
  }
  passwordSchema.parse(password);
  await prisma.user.create({
    data: {
      email,
      name: "AstroVeda Admin",
      role: "ADMIN",
      passwordHash: await hashPassword(password),
      emailVerifiedAt: new Date(),
    },
  });
  return email;
}
