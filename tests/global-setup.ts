// Creates the isolated test database once per run (SQLite file by default, or TEST_DATABASE_URL).
import { execSync } from "node:child_process";
import { rmSync } from "node:fs";

export default function setup() {
  const url = process.env.TEST_DATABASE_URL ?? "file:./test.db";
  if (url.startsWith("file:")) rmSync(url.replace(/^file:/, ""), { force: true });
  execSync("npm run db:schema && npx prisma migrate deploy", { stdio: "ignore", env: { ...process.env, DATABASE_URL: url } });
}
