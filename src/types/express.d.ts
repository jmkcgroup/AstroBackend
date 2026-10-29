import type { Role } from "../generated/prisma/enums.js";

declare global {
  namespace Express {
    interface Request {
      auth?: {
        userId: string;
        sessionId: string;
        role: Role;
        email: string;
        name: string;
        emailVerified: boolean;
      };
    }
  }
}

export {};
