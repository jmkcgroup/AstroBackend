// Derives prisma/sqlite/schema.prisma from prisma/schema.prisma (the PostgreSQL source of truth):
// switches the provider, drops PostgreSQL-only native type attributes and fixes relative paths.
// Run automatically by the db:* scripts; never edit the generated file by hand.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const source = readFileSync("prisma/schema.prisma", "utf8");

const sqlite = source
  .replace(/provider\s*=\s*"postgresql"/, 'provider = "sqlite"')
  .replace(/\s@db\.\w+(\([^)]*\))?/g, "")
  .replace('output   = "../src/generated/prisma"', 'output   = "../../src/generated/prisma"');

if (sqlite.includes("@db.") || !sqlite.includes('provider = "sqlite"')) {
  throw new Error("Could not derive the SQLite schema");
}

mkdirSync("prisma/sqlite", { recursive: true });
writeFileSync("prisma/sqlite/schema.prisma", `// GENERATED from prisma/schema.prisma by scripts/sqlite-schema.ts. Do not edit.\n\n${sqlite}`);
console.log("Wrote prisma/sqlite/schema.prisma");
