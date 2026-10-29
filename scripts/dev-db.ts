// Development-only PostgreSQL server for machines without Docker.
// Runs real PostgreSQL binaries (from npm) with data persisted in ./.pgdata.
// Usage: npm run db:dev   (keep this terminal open; Ctrl+C stops the server)
import { existsSync } from "node:fs";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";

const databaseDir = path.resolve(import.meta.dirname, "..", ".pgdata");
const DB_NAME = "astroveda";
// Separate database used by integration tests so they never touch development data.
const TEST_DB_NAME = "astroveda_test";

const pg = new EmbeddedPostgres({
  databaseDir,
  user: "astroveda",
  password: "astroveda_dev_password",
  port: 5432,
  persistent: true,
  // Without this, initdb on Windows inherits the system code page (e.g. WIN1252),
  // which cannot store Hindi (Devanagari) text.
  initdbFlags: ["--encoding=UTF8", "--locale=C"],
  onLog: () => {},
});

async function alreadyRunning(): Promise<boolean> {
  const probe = pg.getPgClient("postgres");
  try {
    await probe.connect();
    await probe.end();
    return true;
  } catch {
    return false;
  }
}

async function main() {
  if (await alreadyRunning()) {
    console.log("PostgreSQL is already running on localhost:5432; nothing to do.");
    process.exit(0);
  }

  if (!existsSync(path.join(databaseDir, "PG_VERSION"))) {
    console.log("Initialising new PostgreSQL cluster in .pgdata ...");
    await pg.initialise();
  }

  await pg.start();

  const client = pg.getPgClient("postgres");
  await client.connect();
  const { rows } = await client.query<{ encoding: string }>("SELECT pg_encoding_to_char(encoding) AS encoding FROM pg_database WHERE datname = 'template1'");
  if (rows[0]?.encoding !== "UTF8") {
    await client.end();
    throw new Error(
      `The existing cluster in .pgdata uses ${rows[0]?.encoding} encoding, which cannot store Hindi text. Stop the server, delete .pgdata and run "npm run db:dev" again.`,
    );
  }
  for (const name of [DB_NAME, TEST_DB_NAME]) {
    const { rowCount } = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
    if (!rowCount) await pg.createDatabase(name);
  }
  await client.end();

  console.log(`PostgreSQL ready on localhost:5432 (databases "${DB_NAME}", "${TEST_DB_NAME}"). Press Ctrl+C to stop.`);
}

async function shutdown() {
  await pg.stop();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

main().catch(async (err) => {
  console.error("Failed to start development database:", err);
  await pg.stop().catch(() => {});
  process.exit(1);
});
