import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app, prisma, registerAgent, resetDatabase } from "./helpers.js";

let admin: Awaited<ReturnType<typeof registerAgent>>;

beforeAll(async () => {
  await resetDatabase();
  admin = await registerAgent({ name: "Admin" });
  await prisma.user.update({ where: { id: admin.user.id }, data: { role: "ADMIN" } });
});

afterAll(async () => {
  await prisma.$disconnect();
});

const article = (over: object = {}) => ({
  slug: "what-is-a-kundli",
  title: "What is a Kundli?",
  excerpt: "A short introduction.",
  body: "A Kundli is a map of the sky at your birth.\n\n## Houses\n\nTwelve houses are counted from the Lagna.",
  language: "EN",
  status: "DRAFT",
  ...over,
});

describe("articles", () => {
  it("keeps drafts private and publishes with a timestamp", async () => {
    const created = await admin.agent.post("/api/admin/articles").send(article());
    expect(created.status).toBe(201);
    const id = created.body.article.id as string;
    expect((await request(app).get("/api/content/articles/what-is-a-kundli")).status).toBe(404);
    expect((await request(app).get("/api/content/articles?lang=EN")).body.items).toHaveLength(0);

    const published = await admin.agent.put(`/api/admin/articles/${id}`).send(article({ status: "PUBLISHED" }));
    expect(published.body.article.publishedAt).not.toBeNull();
    expect((await request(app).get("/api/content/articles/what-is-a-kundli")).status).toBe(200);
    expect((await request(app).get("/api/content/articles?lang=EN")).body.items).toHaveLength(1);
    expect((await request(app).get("/api/content/articles?lang=HI")).body.items).toHaveLength(0);
  });

  it("rejects duplicate slugs and non-admins, and deletes", async () => {
    expect((await admin.agent.post("/api/admin/articles").send(article())).status).toBeGreaterThanOrEqual(400);
    const user = await registerAgent();
    expect((await user.agent.post("/api/admin/articles").send(article({ slug: "other-article" }))).status).toBe(403);
    const row = await prisma.article.findUniqueOrThrow({ where: { slug: "what-is-a-kundli" } });
    expect((await admin.agent.delete(`/api/admin/articles/${row.id}`)).status).toBe(204);
    expect((await request(app).get("/api/content/articles/what-is-a-kundli")).status).toBe(404);
  });
});

describe("seo metadata", () => {
  it("upserts by path, serves it publicly and deletes it", async () => {
    const body = { path: "/tools", title: "Free Vedic Astrology Tools", description: "Kundli, Panchang, matching and more, calculated with the Swiss Ephemeris." };
    expect((await admin.agent.put("/api/admin/seo").send(body)).status).toBe(200);
    expect((await admin.agent.put("/api/admin/seo").send({ ...body, title: "Updated title for tools" })).status).toBe(200);
    expect(await prisma.seoMetadata.count()).toBe(1);
    expect((await request(app).get("/api/content/seo?path=/tools")).body.seo.title).toBe("Updated title for tools");
    expect((await admin.agent.delete("/api/admin/seo?path=/tools")).status).toBe(204);
    expect((await request(app).get("/api/content/seo?path=/tools")).body.seo).toBeNull();
  });

  it("validates paths", async () => {
    expect((await admin.agent.put("/api/admin/seo").send({ path: "tools", title: "Valid title here", description: "A long enough description." })).status).toBe(400);
  });
});
