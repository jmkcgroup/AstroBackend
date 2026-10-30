import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { app, prisma, resetDatabase, STRONG_PASSWORD } from "./helpers.js";
import { ensureAdmin } from "../src/seed/admin.js";

// Hoisted so the mocked nodemailer transport is shared with the module under test.
const sendMailMock = vi.hoisted(() => vi.fn().mockResolvedValue({ messageId: "x" }));
const createTransportMock = vi.hoisted(() => vi.fn(() => ({ sendMail: sendMailMock })));
vi.mock("nodemailer", () => ({ default: { createTransport: createTransportMock } }));

beforeEach(async () => {
  await resetDatabase();
  sendMailMock.mockClear();
});

describe("ensureAdmin", () => {
  it("creates a verified admin that can log in, and is idempotent", async () => {
    vi.resetModules();
    process.env.SEED_ADMIN_EMAIL = "Boss@Example.Test";
    process.env.SEED_ADMIN_PASSWORD = STRONG_PASSWORD;
    const { ensureAdmin: fresh } = await import("../src/seed/admin.js");

    expect(await fresh()).toBe("boss@example.test");
    expect(await fresh()).toBe("boss@example.test");
    expect(await prisma.user.count({ where: { email: "boss@example.test" } })).toBe(1);

    const res = await request(app).post("/api/auth/login").send({ email: "boss@example.test", password: STRONG_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe("ADMIN");
  });

  it("does nothing without credentials", async () => {
    vi.resetModules();
    delete process.env.SEED_ADMIN_EMAIL;
    delete process.env.SEED_ADMIN_PASSWORD;
    const { ensureAdmin: fresh } = await import("../src/seed/admin.js");
    expect(await fresh()).toBeNull();
    expect(ensureAdmin).toBeTypeOf("function");
  });
});

describe("email via Resend SMTP", () => {
  it("builds an SMTP transport from env and forwards contact forms", async () => {
    vi.resetModules();
    process.env.SMTP_HOST = "smtp.resend.com";
    process.env.SMTP_PORT = "465";
    process.env.SMTP_USER = "resend";
    process.env.SMTP_PASSWORD = "re_test_key";
    process.env.EMAIL_FROM = "AstroVeda <noreply@getsitego.in>";
    process.env.CONTACT_INBOX = "inbox@getsitego.in";
    const { createApp } = await import("../src/app.js");

    const res = await request(createApp()).post("/api/contact").send({
      name: "Asha",
      email: "asha@example.test",
      subject: "Hello there",
      message: "I would like to know more.",
    });
    expect(res.status).toBe(201);
    expect(createTransportMock).toHaveBeenCalledWith(
      expect.objectContaining({ host: "smtp.resend.com", port: 465, secure: true, auth: { user: "resend", pass: "re_test_key" } }),
    );
    expect(sendMailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "AstroVeda <noreply@getsitego.in>",
        to: "inbox@getsitego.in",
        replyTo: "asha@example.test",
      }),
    );
  });
});
