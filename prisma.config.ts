import "dotenv/config";
import { defineConfig, env } from "prisma/config";

// DATABASE_URL decides the database: "file:./dev.db" = SQLite (local), "postgresql://..." = PostgreSQL (production).
const sqlite = (process.env.DATABASE_URL ?? "").startsWith("file:");

export default defineConfig({
  schema: sqlite ? "prisma/sqlite/schema.prisma" : "prisma/schema.prisma",
  migrations: {
    path: sqlite ? "prisma/sqlite/migrations" : "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url: env("DATABASE_URL"),
  },
});
