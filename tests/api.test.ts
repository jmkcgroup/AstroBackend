// Integration tests: real Express app, real PostgreSQL (astroveda_test), real ephemeris.
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PUNE_PROFILE, STRONG_PASSWORD, app, knownToken, prisma, registerAgent, resetDatabase, uniqueEmail } from "./helpers.js";

beforeAll(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("health", () => {
  it("reports database and astrology engine status", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body.database).toBe("up");
    expect(res.body.astrology.available).toBe(true);
  });
});

describe("registration and login", () => {
  it("rejects weak passwords, mismatches and missing consent", async () => {
    const base = { name: "A User", email: uniqueEmail(), acceptTerms: true };
    const weak = await request(app).post("/api/auth/register").send({ ...base, password: "short", confirmPassword: "short" });
    expect(weak.status).toBe(400);

    const mismatch = await request(app)
      .post("/api/auth/register")
      .send({ ...base, password: STRONG_PASSWORD, confirmPassword: `${STRONG_PASSWORD}x` });
    expect(mismatch.status).toBe(400);

    const noConsent = await request(app)
      .post("/api/auth/register")
      .send({ ...base, acceptTerms: false, password: STRONG_PASSWORD, confirmPassword: STRONG_PASSWORD });
    expect(noConsent.status).toBe(400);
  });

  it("registers, hashes the password, sets httpOnly cookies and prevents duplicates", async () => {
    const email = uniqueEmail("dup");
    const res = await request(app)
      .post("/api/auth/register")
      .send({ name: "Dup", email, password: STRONG_PASSWORD, confirmPassword: STRONG_PASSWORD, acceptTerms: true });
    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe(email);
    expect(res.body.user).not.toHaveProperty("passwordHash");

    const cookies = ([] as string[]).concat(res.headers["set-cookie"] ?? []);
    expect(cookies.some((c) => c.startsWith("av_access=") && /HttpOnly/i.test(c))).toBe(true);
    expect(cookies.some((c) => c.startsWith("av_refresh=") && /Path=\/api\/auth/i.test(c))).toBe(true);

    const stored = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(stored.passwordHash).toMatch(/^\$2[aby]\$12\$/);
    expect(stored.emailVerifiedAt).toBeNull();
    expect(await prisma.verificationToken.count({ where: { userId: stored.id } })).toBe(1);

    const again = await request(app)
      .post("/api/auth/register")
      .send({ name: "Dup", email: email.toUpperCase(), password: STRONG_PASSWORD, confirmPassword: STRONG_PASSWORD, acceptTerms: true });
    expect(again.status).toBe(409);
  });

  it("logs in with correct credentials only and reports the same error for unknown emails", async () => {
    const { email } = await registerAgent();
    const wrong = await request(app).post("/api/auth/login").send({ email, password: "Wrong-Password-1" });
    const unknown = await request(app).post("/api/auth/login").send({ email: uniqueEmail("nobody"), password: "Wrong-Password-1" });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error.message).toBe(unknown.body.error.message);

    const agent = request.agent(app);
    const ok = await agent.post("/api/auth/login").send({ email, password: STRONG_PASSWORD });
    expect(ok.status).toBe(200);
    expect((await agent.get("/api/auth/me")).status).toBe(200);
  });

  it("requires authentication for /me and logs out", async () => {
    expect((await request(app).get("/api/auth/me")).status).toBe(401);
    const { agent } = await registerAgent();
    expect((await agent.get("/api/auth/me")).status).toBe(200);
    expect((await agent.post("/api/auth/logout")).status).toBe(204);
    expect((await agent.get("/api/auth/me")).status).toBe(401);
  });

  it("blocks suspended users immediately", async () => {
    const { agent, user } = await registerAgent();
    await prisma.user.update({ where: { id: user.id }, data: { status: "SUSPENDED" } });
    expect((await agent.get("/api/auth/me")).status).toBe(401);
  });
});

describe("email verification and password reset", () => {
  it("verifies email with a single-use token", async () => {
    const { agent, user } = await registerAgent();
    const token = await knownToken("verification", user.id);
    expect((await request(app).post("/api/auth/verify-email").send({ token })).status).toBe(200);
    const me = await agent.get("/api/auth/me");
    expect(me.body.user.emailVerifiedAt).not.toBeNull();
    expect((await request(app).post("/api/auth/verify-email").send({ token })).status).toBe(400);
  });

  it("rejects expired verification tokens", async () => {
    const { user } = await registerAgent();
    const token = await knownToken("verification", user.id, -1000);
    expect((await request(app).post("/api/auth/verify-email").send({ token })).status).toBe(400);
  });

  it("does not reveal whether an email exists on forgot-password", async () => {
    const { email } = await registerAgent();
    const a = await request(app).post("/api/auth/forgot-password").send({ email });
    const b = await request(app).post("/api/auth/forgot-password").send({ email: uniqueEmail("ghost") });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body).toEqual(b.body);
  });

  it("resets the password, invalidates the token and signs out every session", async () => {
    const { agent, email, user } = await registerAgent();
    const token = await knownToken("reset", user.id);
    const newPassword = "New-Stars-2025";

    const res = await request(app).post("/api/auth/reset-password").send({ token, password: newPassword, confirmPassword: newPassword });
    expect(res.status).toBe(200);
    expect((await agent.get("/api/auth/me")).status).toBe(401);
    expect((await request(app).post("/api/auth/login").send({ email, password: STRONG_PASSWORD })).status).toBe(401);
    expect((await request(app).post("/api/auth/login").send({ email, password: newPassword })).status).toBe(200);
    expect(
      (await request(app).post("/api/auth/reset-password").send({ token, password: newPassword, confirmPassword: newPassword })).status,
    ).toBe(400);
  });
});

describe("refresh token rotation", () => {
  const cookieValue = (res: request.Response, name: string) => {
    const raw = ([] as string[]).concat(res.headers["set-cookie"] ?? []).find((c) => c.startsWith(`${name}=`));
    return raw?.split(";")[0]!.slice(name.length + 1);
  };

  it("rotates refresh tokens and revokes all sessions when an old token is reused", async () => {
    const email = uniqueEmail("rotate");
    const reg = await request(app)
      .post("/api/auth/register")
      .send({ name: "Rotate", email, password: STRONG_PASSWORD, confirmPassword: STRONG_PASSWORD, acceptTerms: true });
    const userId = reg.body.user.id as string;
    const oldRefresh = cookieValue(reg, "av_refresh")!;
    expect(oldRefresh).toBeTruthy();

    const rotated = await request(app).post("/api/auth/refresh").set("Cookie", `av_refresh=${oldRefresh}`);
    expect(rotated.status).toBe(200);
    const newRefresh = cookieValue(rotated, "av_refresh")!;
    const newAccess = cookieValue(rotated, "av_access")!;
    expect(newRefresh).not.toBe(oldRefresh);
    expect((await request(app).get("/api/auth/me").set("Cookie", `av_access=${newAccess}`)).status).toBe(200);

    // Replaying the rotated-out token is treated as theft: every session is revoked.
    const replay = await request(app).post("/api/auth/refresh").set("Cookie", `av_refresh=${oldRefresh}`);
    expect(replay.status).toBe(401);
    expect(await prisma.refreshSession.count({ where: { userId, revokedAt: null } })).toBe(0);
    expect((await request(app).get("/api/auth/me").set("Cookie", `av_access=${newAccess}`)).status).toBe(401);
    expect((await request(app).post("/api/auth/refresh").set("Cookie", `av_refresh=${newRefresh}`)).status).toBe(401);
  });
});

describe("CSRF protection", () => {
  it("rejects state-changing requests from a foreign origin", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .set("Origin", "https://evil.example")
      .send({ email: uniqueEmail(), password: STRONG_PASSWORD });
    expect(res.status).toBe(403);
  });

  it("allows the configured frontend origin", async () => {
    const res = await request(app)
      .post("/api/auth/forgot-password")
      .set("Origin", "http://localhost:3000")
      .send({ email: uniqueEmail() });
    expect(res.status).toBe(200);
  });
});

describe("birth profiles", () => {
  it("creates, lists, updates and deletes profiles with ownership checks", async () => {
    const owner = await registerAgent();
    const other = await registerAgent();

    const created = await owner.agent.post("/api/birth-profiles").send(PUNE_PROFILE);
    expect(created.status).toBe(201);
    const id = created.body.profile.id as string;
    expect(created.body.profile.isPrimary).toBe(true);
    expect(created.body.profile.dateOfBirth).toBe("2002-09-20");
    expect(created.body.profile.latitude).toBeCloseTo(18.5089, 4);

    const second = await owner.agent.post("/api/birth-profiles").send({ ...PUNE_PROFILE, name: "Partner" });
    expect(second.body.profile.isPrimary).toBe(false);

    const list = await owner.agent.get("/api/birth-profiles");
    expect(list.body.items).toHaveLength(2);
    expect(list.body.items[0].id).toBe(id);

    // Another user cannot read, edit or delete it
    expect((await other.agent.get(`/api/birth-profiles/${id}`)).status).toBe(404);
    expect((await other.agent.put(`/api/birth-profiles/${id}`).send(PUNE_PROFILE)).status).toBe(404);
    expect((await other.agent.delete(`/api/birth-profiles/${id}`)).status).toBe(404);
    expect((await request(app).get(`/api/birth-profiles/${id}`)).status).toBe(401);

    const updated = await owner.agent.put(`/api/birth-profiles/${id}`).send({ ...PUNE_PROFILE, notes: "Hospital record" });
    expect(updated.body.profile.notes).toBe("Hospital record");

    expect((await owner.agent.post(`/api/birth-profiles/${second.body.profile.id}/primary`)).status).toBe(200);
    const primaries = await prisma.birthProfile.count({ where: { userId: owner.user.id, isPrimary: true } });
    expect(primaries).toBe(1);

    expect((await owner.agent.delete(`/api/birth-profiles/${second.body.profile.id}`)).status).toBe(204);
    // Deleting the primary promotes the remaining profile
    const remaining = await owner.agent.get("/api/birth-profiles");
    expect(remaining.body.items).toHaveLength(1);
    expect(remaining.body.items[0].isPrimary).toBe(true);
  });

  it("validates birth data", async () => {
    const { agent } = await registerAgent();
    const bad = await agent.post("/api/birth-profiles").send({ ...PUNE_PROFILE, dateOfBirth: "2002-02-30", timezone: "Nowhere/City" });
    expect(bad.status).toBe(400);
    const outOfRange = await agent.post("/api/birth-profiles").send({ ...PUNE_PROFILE, dateOfBirth: "1750-01-01" });
    expect(outOfRange.status).toBe(400);
  });
});

describe("kundli charts", () => {
  it("calculates, stores, reuses and serves a chart only to its owner", async () => {
    const owner = await registerAgent();
    const other = await registerAgent();
    const profile = (await owner.agent.post("/api/birth-profiles").send(PUNE_PROFILE)).body.profile;

    const first = await owner.agent.post("/api/charts/calculate").send({ birthProfileId: profile.id });
    expect(first.status).toBe(201);
    expect(first.body.reused).toBe(false);
    const chart = first.body.chart;
    expect(chart.planets).toHaveLength(9);
    expect(chart.houses).toHaveLength(12);
    expect(chart.metadata.ayanamsha).toBe("LAHIRI");
    expect(chart.metadata.ephemerisSource).toMatch(/Swiss Ephemeris/);
    expect(chart.metadata.utcDateTime).toBe("2002-09-20T04:45:00.000Z");

    const again = await owner.agent.post("/api/charts/calculate").send({ birthProfileId: profile.id });
    expect(again.status).toBe(200);
    expect(again.body.reused).toBe(true);
    expect(again.body.chart.id).toBe(chart.id);

    // Stored rows match the response
    expect(await prisma.planetaryPosition.count({ where: { chartId: chart.id } })).toBe(9);
    expect(await prisma.dashaPeriod.count({ where: { chartId: chart.id } })).toBe(90);

    expect((await other.agent.get(`/api/charts/${chart.id}`)).status).toBe(404);
    expect((await other.agent.post("/api/charts/calculate").send({ birthProfileId: profile.id })).status).toBe(404);

    const dashas = await owner.agent.get(`/api/charts/${chart.id}/dashas`);
    expect(dashas.body.mahadashas).toHaveLength(9);
    expect(dashas.body.current.mahadasha).not.toBeNull();

    const d9 = await owner.agent.get(`/api/charts/${chart.id}/divisional/D9`);
    expect(Object.values(d9.body.signs as Record<string, string[]>).flat()).toHaveLength(9);

    const transits = await owner.agent.get(`/api/charts/${chart.id}/transits`);
    expect(transits.body.transits.positions).toHaveLength(9);
  });

  it("returns labelled rule-based interpretations in English and Hindi", async () => {
    const { agent } = await registerAgent();
    const profile = (await agent.post("/api/birth-profiles").send(PUNE_PROFILE)).body.profile;
    const chart = (await agent.post("/api/charts/calculate").send({ birthProfileId: profile.id })).body.chart;

    const en = await agent.get(`/api/charts/${chart.id}/interpretations?lang=EN`);
    expect(en.status).toBe(200);
    expect(en.body.source).toBe("RULE_BASED");
    expect(en.body.sections.map((s: { section: string }) => s.section)).toEqual(
      expect.arrayContaining(["PERSONALITY", "CAREER_EDUCATION", "RELATIONSHIPS", "DASHA", "TRANSITS"]),
    );
    expect(en.body.disclaimer).toMatch(/not guarantees/);

    const hi = await agent.get(`/api/charts/${chart.id}/interpretations?lang=hi`);
    expect(hi.body.sections[0].paragraphs[0]).toMatch(/लग्न/);
  });
});

describe("free tools", () => {
  const birth = {
    date: "2002-09-20",
    time: "10:15",
    timezone: "Asia/Kolkata",
    latitude: 18.5089,
    longitude: 73.9259,
  };

  it("generates a kundli without storing birth data", async () => {
    const before = await prisma.birthProfile.count();
    const res = await request(app).post("/api/tools/kundli").send(birth);
    expect(res.status).toBe(200);
    expect(res.body.chart.planets).toHaveLength(9);
    expect(await prisma.birthProfile.count()).toBe(before);
    expect(await prisma.toolUsage.count({ where: { tool: "KUNDLI" } })).toBeGreaterThan(0);
  });

  it("scores kundli matching out of 36", async () => {
    const res = await request(app)
      .post("/api/tools/matching")
      .send({ boy: birth, girl: { ...birth, date: "2003-03-14", time: "06:40" } });
    expect(res.status).toBe(200);
    expect(res.body.result.max).toBe(36);
    expect(res.body.result.kootas).toHaveLength(8);
  });

  it("computes and caches the Panchang", async () => {
    const q = "/api/tools/panchang?date=2024-07-21&latitude=28.6139&longitude=77.209&timezone=Asia/Kolkata";
    const first = await request(app).get(q);
    expect(first.status).toBe(200);
    expect(first.body.panchang.tithi.name).toBe("Purnima");
    expect(await prisma.panchangEntry.count()).toBe(1);
    const second = await request(app).get(q);
    expect(second.body.panchang.tithi.endsAt).toBe(first.body.panchang.tithi.endsAt);
    expect(await prisma.panchangEntry.count()).toBe(1);
  });

  it("calculates numerology, nakshatra, rashi and transits", async () => {
    const num = await request(app).post("/api/tools/numerology").send({ dateOfBirth: "1990-08-15", name: "Asha" });
    expect(num.body.result.moolank.value).toBe(6);

    const nak = await request(app).post("/api/tools/nakshatra").send(birth);
    expect(nak.body.result.pada).toBeGreaterThanOrEqual(1);
    expect(nak.body.result.pada).toBeLessThanOrEqual(4);

    const rashi = await request(app).post("/api/tools/rashi").send(birth);
    expect(rashi.body.result.vedic.sunSign).toBe(6); // sidereal Virgo
    expect(rashi.body.result.western.sunSign).toBe(6); // tropical Virgo on 20 Sep

    const tr = await request(app).get("/api/tools/transits?date=2024-06-01T00:00:00Z&moonSign=11");
    expect(tr.body.transits.sadeSati.active).toBe(true);

    const sky = await request(app).get("/api/tools/sky");
    expect(sky.body.positions).toHaveLength(9);
  });

  it("returns 400 for invalid tool input", async () => {
    expect((await request(app).post("/api/tools/kundli").send({ ...birth, time: "25:00" })).status).toBe(400);
    expect((await request(app).post("/api/tools/kundli").send({ ...birth, date: "1700-01-01" })).status).toBe(400);
  });
});

describe("content, contact and account", () => {
  it("serves only published horoscopes", async () => {
    await prisma.horoscopeContent.createMany({
      data: [
        { sign: 1, period: "DAILY", periodStart: new Date("2026-01-05T00:00:00Z"), content: "Published text", status: "PUBLISHED" },
        { sign: 2, period: "DAILY", periodStart: new Date("2026-01-05T00:00:00Z"), content: "Draft text", status: "DRAFT" },
      ],
    });
    const res = await request(app).get("/api/content/horoscopes?period=DAILY&date=2026-01-05");
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].content).toBe("Published text");
  });

  it("stores contact messages and silently drops honeypot spam", async () => {
    const msg = { name: "Visitor", email: "visitor@example.test", subject: "Question", message: "How is the ayanamsha chosen?" };
    expect((await request(app).post("/api/contact").send(msg)).status).toBe(201);
    expect((await request(app).post("/api/contact").send({ ...msg, website: "spam.example" })).status).toBe(201);
    expect(await prisma.contactMessage.count()).toBe(1);
  });

  it("exports user data without secrets and records deletion requests", async () => {
    const { agent, user } = await registerAgent();
    await agent.post("/api/birth-profiles").send(PUNE_PROFILE);
    const exp = await agent.get("/api/users/me/export");
    expect(exp.status).toBe(200);
    expect(exp.body.birthProfiles).toHaveLength(1);
    expect(JSON.stringify(exp.body)).not.toMatch(/passwordHash|tokenHash/);

    expect((await agent.post("/api/users/me/deletion-request")).status).toBe(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).status).toBe("DELETION_REQUESTED");
    expect(await prisma.auditLog.count({ where: { actorId: user.id, action: "user.deletion_requested" } })).toBe(1);
  });

  it("builds the dashboard overview from real data", async () => {
    const { agent } = await registerAgent();
    const empty = await agent.get("/api/users/me/dashboard");
    expect(empty.body.primaryProfile).toBeNull();
    expect(empty.body.latestChart).toBeNull();

    const profile = (await agent.post("/api/birth-profiles").send(PUNE_PROFILE)).body.profile;
    await agent.post("/api/charts/calculate").send({ birthProfileId: profile.id });
    const full = await agent.get("/api/users/me/dashboard");
    expect(full.body.primaryProfile.id).toBe(profile.id);
    expect(full.body.latestChart.summary.moonSign).toBeGreaterThanOrEqual(1);
  });
});
