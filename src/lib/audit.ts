import type { Prisma } from "../generated/prisma/client.js";
import { prisma } from "./prisma.js";

type Db = Pick<typeof prisma, "auditLog">;

/** Records a sensitive action. Never include passwords, tokens or birth details in metadata. */
export function audit(
  entry: {
    actorId: string | null;
    action: string;
    entityType: string;
    entityId?: string | null;
    metadata?: Prisma.InputJsonValue;
  },
  db: Db = prisma,
) {
  return db.auditLog.create({ data: { ...entry, entityId: entry.entityId ?? null } });
}
