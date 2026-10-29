import { pino } from "pino";
import { env } from "../config/env.js";

// Birth details, passwords and tokens must never reach the logs.
export const logger = pino({
  level: env.NODE_ENV === "test" ? "silent" : env.NODE_ENV === "production" ? "info" : "debug",
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      'res.headers["set-cookie"]',
      "*.password",
      "*.passwordHash",
      "*.token",
      "*.dateOfBirth",
      "*.birthTime",
      "*.latitude",
      "*.longitude",
    ],
    censor: "[redacted]",
  },
  ...(env.NODE_ENV === "development" && {
    transport: { target: "pino-pretty", options: { colorize: true } },
  }),
});
