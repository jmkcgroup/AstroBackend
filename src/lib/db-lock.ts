import { Prisma } from "../generated/prisma/client.js";

type Tx = Pick<Prisma.TransactionClient, "$executeRaw">;

/**
 * Takes a write lock on one row for the rest of the transaction and reports whether it exists.
 * A no-op UPDATE works on both databases: PostgreSQL locks the row, SQLite takes the database
 * write lock, so concurrent transactions touching the same row run one after another.
 */
export async function lockRow(tx: Tx, table: "AvailabilitySlot" | "Payment", id: string): Promise<boolean> {
  const updated = await tx.$executeRaw`UPDATE ${Prisma.raw(`"${table}"`)} SET "id" = "id" WHERE "id" = ${id}`;
  return updated > 0;
}
