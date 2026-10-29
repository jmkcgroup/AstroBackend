import { existsSync } from "node:fs";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { processNextJob, retryReport } from "../src/reports/reports.service.js";
import { seedCatalogue } from "../src/seed/catalogue.js";
import { PUNE_PROFILE, app, prisma, registerAgent, resetDatabase } from "./helpers.js";

const binary = (res: request.Response, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on("data", (c: Buffer) => chunks.push(c));
  res.on("end", () => cb(null, Buffer.concat(chunks)));
};

let productIds: Record<string, string> = {};

async function grant(userId: string, slug: string, usesRemaining: number | null = 1) {
  return prisma.reportAccessGrant.create({
    data: { userId, productId: productIds[slug]!, source: "DEVELOPMENT", reason: "test", usesRemaining },
  });
}

async function drainQueue() {
  while (await processNextJob()) {
    /* run all pending jobs */
  }
}

beforeAll(async () => {
  await resetDatabase();
  await seedCatalogue(prisma);
  const products = await prisma.reportProduct.findMany({ select: { id: true, slug: true } });
  productIds = Object.fromEntries(products.map((p) => [p.slug, p.id]));
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("report catalogue", () => {
  it("lists the seven report types with indicative prices", async () => {
    const res = await request(app).get("/api/reports/catalogue");
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(7);
    expect(res.body.items[0]).toMatchObject({ slug: "complete-natal", indicativePriceMinor: 149_900, currency: "INR" });
  });

  it("serves clearly labelled sample PDFs, including the two-person compatibility report", async () => {
    for (const slug of ["complete-natal", "kundli-compatibility", "yearly"]) {
      const res = await request(app).get(`/api/reports/catalogue/${slug}/sample`).buffer(true).parse(binary);
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toBe("application/pdf");
      const body = res.body as Buffer;
      expect(body.subarray(0, 5).toString()).toBe("%PDF-");
      expect(body.length).toBeGreaterThan(5_000);
    }
  });

  it("returns 404 for unknown report types", async () => {
    expect((await request(app).get("/api/reports/catalogue/nope")).status).toBe(404);
  });
});

describe("report requests", () => {
  it("refuses a request without an access grant", async () => {
    const { agent } = await registerAgent();
    const profile = (await agent.post("/api/birth-profiles").send(PUNE_PROFILE)).body.profile;
    const res = await agent.post("/api/reports").send({ productId: productIds["career-education"], birthProfileId: profile.id });
    expect(res.status).toBe(403);
    expect(await prisma.report.count({ where: { birthProfileId: profile.id } })).toBe(0);
  });

  it("generates, notifies and serves a report only to its owner", async () => {
    const owner = await registerAgent();
    const other = await registerAgent();
    const profile = (await owner.agent.post("/api/birth-profiles").send(PUNE_PROFILE)).body.profile;
    await grant(owner.user.id, "complete-natal", 1);

    const created = await owner.agent.post("/api/reports").send({ productId: productIds["complete-natal"], birthProfileId: profile.id });
    expect(created.status).toBe(201);
    expect(created.body.report.status).toBe("QUEUED");
    const reportId = created.body.report.id as string;

    // The single use is spent
    const again = await owner.agent.post("/api/reports").send({ productId: productIds["complete-natal"], birthProfileId: profile.id });
    expect(again.status).toBe(403);

    // Not downloadable before generation
    expect((await owner.agent.get(`/api/reports/${reportId}/download`)).status).toBe(409);

    await drainQueue();

    const status = await owner.agent.get(`/api/reports/${reportId}`);
    expect(status.body.report.status).toBe("READY");
    const row = await prisma.report.findUniqueOrThrow({ where: { id: reportId } });
    expect(row.storagePath).toBeTruthy();
    expect(existsSync(`${process.env.STORAGE_DIR}/${row.storagePath}`)).toBe(true);
    expect(await prisma.notification.count({ where: { userId: owner.user.id, type: "REPORT_READY" } })).toBe(1);

    const dl = await owner.agent.get(`/api/reports/${reportId}/download`).buffer(true).parse(binary);
    expect(dl.status).toBe(200);
    expect(dl.headers["content-disposition"]).toMatch(/attachment/);
    expect((dl.body as Buffer).subarray(0, 5).toString()).toBe("%PDF-");

    expect((await other.agent.get(`/api/reports/${reportId}`)).status).toBe(404);
    expect((await other.agent.get(`/api/reports/${reportId}/download`)).status).toBe(404);
    expect((await request(app).get(`/api/reports/${reportId}/download`)).status).toBe(401);

    const list = await owner.agent.get("/api/reports");
    expect(list.body.items).toHaveLength(1);
    expect(list.body.pagination.total).toBe(1);
  });

  it("lets only one of two concurrent requests spend a single-use grant", async () => {
    const { agent, user } = await registerAgent();
    const profile = (await agent.post("/api/birth-profiles").send(PUNE_PROFILE)).body.profile;
    await grant(user.id, "dasha-transit", 1);
    const body = { productId: productIds["dasha-transit"], birthProfileId: profile.id };
    const [a, b] = await Promise.all([agent.post("/api/reports").send(body), agent.post("/api/reports").send(body)]);
    // The loser sees either "no grant" (403) or "grant already spent" (409), depending on timing.
    const statuses = [a.status, b.status].sort();
    expect(statuses[0]).toBe(201);
    expect([403, 409]).toContain(statuses[1]);
    expect(await prisma.report.count({ where: { userId: user.id } })).toBe(1);
  });

  it("allows unlimited grants and lists entitlements", async () => {
    const { agent, user } = await registerAgent();
    const profile = (await agent.post("/api/birth-profiles").send(PUNE_PROFILE)).body.profile;
    await grant(user.id, "career-education", null);
    const body = { productId: productIds["career-education"], birthProfileId: profile.id };
    expect((await agent.post("/api/reports").send(body)).status).toBe(201);
    expect((await agent.post("/api/reports").send(body)).status).toBe(201);
    const ent = await agent.get("/api/reports/entitlements");
    expect(ent.body.items).toHaveLength(1);
    expect(ent.body.items[0].usesRemaining).toBeNull();
  });

  it("requires two of the caller's own profiles for the compatibility report", async () => {
    const owner = await registerAgent();
    const stranger = await registerAgent();
    const mine = (await owner.agent.post("/api/birth-profiles").send(PUNE_PROFILE)).body.profile;
    const theirs = (await stranger.agent.post("/api/birth-profiles").send(PUNE_PROFILE)).body.profile;
    await grant(owner.user.id, "kundli-compatibility", null);
    const productId = productIds["kundli-compatibility"];

    expect((await owner.agent.post("/api/reports").send({ productId, birthProfileId: mine.id })).status).toBe(400);
    expect((await owner.agent.post("/api/reports").send({ productId, birthProfileId: mine.id, partnerProfileId: mine.id })).status).toBe(400);
    expect((await owner.agent.post("/api/reports").send({ productId, birthProfileId: mine.id, partnerProfileId: theirs.id })).status).toBe(404);

    const partner = (await owner.agent.post("/api/birth-profiles").send({ ...PUNE_PROFILE, name: "Partner", dateOfBirth: "2001-04-02" })).body.profile;
    const ok = await owner.agent.post("/api/reports").send({ productId, birthProfileId: mine.id, partnerProfileId: partner.id });
    expect(ok.status).toBe(201);
    await drainQueue();
    expect((await owner.agent.get(`/api/reports/${ok.body.report.id}`)).body.report.status).toBe("READY");
  });

  it("records failures without leaking details, and an admin retry re-queues the job", async () => {
    const { agent, user } = await registerAgent();
    const mine = (await agent.post("/api/birth-profiles").send(PUNE_PROFILE)).body.profile;
    const partner = (await agent.post("/api/birth-profiles").send({ ...PUNE_PROFILE, name: "Partner" })).body.profile;
    await grant(user.id, "kundli-compatibility", null);
    const created = await agent
      .post("/api/reports")
      .send({ productId: productIds["kundli-compatibility"], birthProfileId: mine.id, partnerProfileId: partner.id });
    const reportId = created.body.report.id as string;

    // Partner profile deleted before the worker runs → generation must fail
    await agent.delete(`/api/birth-profiles/${partner.id}`);
    await drainQueue();

    const failed = await agent.get(`/api/reports/${reportId}`);
    expect(failed.body.report.status).toBe("FAILED");
    expect(failed.body.report.errorMessage).not.toMatch(/Partner profile/);
    const job = await prisma.reportGenerationJob.findFirstOrThrow({ where: { reportId } });
    expect(job.status).toBe("FAILED");
    expect(job.lastError).toMatch(/Partner profile/);

    await retryReport(reportId);
    const jobs = await prisma.reportGenerationJob.findMany({ where: { reportId }, orderBy: { attempt: "asc" } });
    expect(jobs.map((j) => [j.attempt, j.status])).toEqual([
      [1, "FAILED"],
      [2, "PENDING"],
    ]);
    expect((await prisma.report.findUniqueOrThrow({ where: { id: reportId } })).status).toBe("QUEUED");
  });
});
