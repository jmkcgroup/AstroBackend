import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** URL-safe random token for emails, refresh sessions and OAuth state. */
export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");

/** Tokens are stored only as SHA-256 hashes so a database leak cannot be replayed. */
export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
