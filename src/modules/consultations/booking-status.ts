import type { BookingStatus } from "../../generated/prisma/enums.js";

/** Bookings in these states hold their slot (matches the partial unique index in the migration). */
export const ACTIVE_STATUSES: BookingStatus[] = ["PENDING", "CONFIRMED", "RESCHEDULE_REQUESTED"];
