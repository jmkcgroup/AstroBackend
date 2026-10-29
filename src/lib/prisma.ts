import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";
import { env } from "../config/env.js";

/** SQLite locally ("file:..."), PostgreSQL in production. The generated client must match (npm run db:generate). */
export const isSqlite = env.DATABASE_URL.startsWith("file:");

const adapter = isSqlite
  ? new PrismaBetterSqlite3({ url: env.DATABASE_URL })
  : new PrismaPg({ connectionString: env.DATABASE_URL });

export const prisma = new PrismaClient({ adapter });

/**
 * Case-insensitive "contains" filter. PostgreSQL needs mode: "insensitive"; SQLite's LIKE is
 * already case-insensitive for ASCII and rejects the mode argument.
 */
export const containsText = (value: string) => (isSqlite ? { contains: value } : ({ contains: value, mode: "insensitive" } as { contains: string }));
