import bcrypt from "bcryptjs";
import { z } from "zod";

const COST = 12;

export const hashPassword = (plain: string) => bcrypt.hash(plain, COST);
export const verifyPassword = (plain: string, hash: string) => bcrypt.compare(plain, hash);

// A real hash at the same cost, so login takes the same time whether or not the email exists.
const DUMMY_HASH = bcrypt.hashSync("astroveda-timing-equaliser", COST);
export const burnPasswordCheck = (plain: string) => bcrypt.compare(plain, DUMMY_HASH);

export const passwordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .max(128, "Password must be at most 128 characters")
  .regex(/[a-z]/, "Password must contain a lowercase letter")
  .regex(/[A-Z]/, "Password must contain an uppercase letter")
  .regex(/\d/, "Password must contain a number");
