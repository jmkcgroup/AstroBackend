import type { Prisma } from "../generated/prisma/client.js";

/** Reads a JSON column that stores a list of strings (portable replacement for String[] columns). */
export function jsonList(value: Prisma.JsonValue | null | undefined): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}
