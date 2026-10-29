import request from "supertest";
import { createApp } from "../src/app.js";
import { initEphemeris } from "../src/astrology/ephemeris.js";
import { sha256 } from "../src/lib/crypto.js";
import { isSqlite, prisma } from "../src/lib/prisma.js";

initEphemeris("./ephe");
export const app = createApp();
export { prisma };

/** Empties every application table (keeps the migrations table). */
export async function resetDatabase() {
  if (isSqlite) {
    const tables = await prisma.$queryRaw<{ name: string }[]>`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> '_prisma_migrations'`;
    await prisma.$executeRawUnsafe("PRAGMA foreign_keys = OFF");
    for (const t of tables) await prisma.$executeRawUnsafe(`DELETE FROM "${t.name}"`);
    await prisma.$executeRawUnsafe("PRAGMA foreign_keys = ON");
    return;
  }
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (tables.length === 0) return;
  const list = tables.map((t) => `"public"."${t.tablename}"`).join(", ");
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}

let counter = 0;
export const uniqueEmail = (prefix = "user") => `${prefix}.${Date.now()}.${++counter}@example.test`;

export const STRONG_PASSWORD = "Cosmic-Path-2024";

/** Registers a user and returns a cookie-carrying agent. */
export async function registerAgent(overrides: Partial<{ name: string; email: string; password: string }> = {}) {
  const agent = request.agent(app);
  const email = overrides.email ?? uniqueEmail();
  const password = overrides.password ?? STRONG_PASSWORD;
  const res = await agent.post("/api/auth/register").send({
    name: overrides.name ?? "Test User",
    email,
    password,
    confirmPassword: password,
    acceptTerms: true,
  });
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { agent, email, password, user: res.body.user as { id: string; email: string } };
}

/** Inserts a single-use token with a known plaintext, as the email flow would. */
export async function knownToken(kind: "verification" | "reset", userId: string, ttlMs = 60_000) {
  const token = `test-token-${kind}-${Date.now()}-${++counter}`;
  const data = { userId, tokenHash: sha256(token), expiresAt: new Date(Date.now() + ttlMs) };
  if (kind === "verification") await prisma.verificationToken.create({ data });
  else await prisma.passwordResetToken.create({ data });
  return token;
}

export const PUNE_PROFILE = {
  name: "Samruddhi",
  dateOfBirth: "2002-09-20",
  birthTime: "10:15",
  birthTimeAccuracy: "EXACT",
  placeName: "Hadapsar, Pune, India",
  latitude: 18.5089,
  longitude: 73.9259,
  timezone: "Asia/Kolkata",
  ayanamsha: "LAHIRI",
};
