// Public, read-only editorial content. Only PUBLISHED rows are ever returned.
import { Router } from "express";
import { z } from "zod";
import { notFound } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import { validate } from "../../middleware/validate.js";

export const contentRouter = Router();

const lang = z.enum(["EN", "HI", "en", "hi"]).default("EN").transform((v) => v.toUpperCase() as "EN" | "HI");

/** Start of the period containing `date` (weeks start Monday). */
export function periodStart(period: "DAILY" | "WEEKLY" | "MONTHLY", date: string): Date {
  const d = new Date(`${date}T00:00:00Z`);
  if (period === "WEEKLY") d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  if (period === "MONTHLY") d.setUTCDate(1);
  return d;
}

contentRouter.get(
  "/horoscopes",
  validate({
    query: z.object({
      period: z.enum(["DAILY", "WEEKLY", "MONTHLY"]).default("DAILY"),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      sign: z.coerce.number().int().min(1).max(12).optional(),
      lang,
    }),
  }),
  async (req, res) => {
    const q = res.locals.query as { period: "DAILY" | "WEEKLY" | "MONTHLY"; date?: string; sign?: number; lang: "EN" | "HI" };
    const date = q.date ?? new Date().toISOString().slice(0, 10);
    const start = periodStart(q.period, date);
    const items = await prisma.horoscopeContent.findMany({
      where: { period: q.period, periodStart: start, language: q.lang, status: "PUBLISHED", ...(q.sign && { sign: q.sign }) },
      select: { sign: true, period: true, periodStart: true, language: true, content: true, updatedAt: true },
      orderBy: { sign: "asc" },
    });
    res.set("Cache-Control", "public, max-age=300");
    res.json({ period: q.period, periodStart: start.toISOString().slice(0, 10), items });
  },
);

contentRouter.get("/faqs", validate({ query: z.object({ lang, category: z.string().max(40).optional() }) }), async (req, res) => {
  const q = res.locals.query as { lang: "EN" | "HI"; category?: string };
  const items = await prisma.faqItem.findMany({
    where: { status: "PUBLISHED", language: q.lang, ...(q.category && { category: q.category }) },
    orderBy: [{ category: "asc" }, { sortOrder: "asc" }],
    select: { id: true, category: true, question: true, answer: true },
  });
  res.set("Cache-Control", "public, max-age=300");
  res.json({ items });
});

contentRouter.get("/banners", validate({ query: z.object({ lang }) }), async (req, res) => {
  const q = res.locals.query as { lang: "EN" | "HI" };
  const now = new Date();
  const items = await prisma.banner.findMany({
    where: {
      status: "PUBLISHED",
      language: q.lang,
      AND: [{ OR: [{ startsAt: null }, { startsAt: { lte: now } }] }, { OR: [{ endsAt: null }, { endsAt: { gt: now } }] }],
    },
    select: { id: true, title: true, body: true, linkUrl: true },
    orderBy: { createdAt: "desc" },
  });
  res.json({ items });
});

contentRouter.get("/articles", validate({ query: z.object({ lang }) }), async (req, res) => {
  const q = res.locals.query as { lang: "EN" | "HI" };
  const items = await prisma.article.findMany({
    where: { status: "PUBLISHED", language: q.lang },
    select: { slug: true, title: true, excerpt: true, publishedAt: true },
    orderBy: { publishedAt: "desc" },
    take: 50,
  });
  res.json({ items });
});

contentRouter.get("/articles/:slug", validate({ params: z.object({ slug: z.string().max(120) }) }), async (req, res) => {
  const article = await prisma.article.findFirst({ where: { slug: req.params.slug as string, status: "PUBLISHED" } });
  if (!article) throw notFound("Article not found");
  res.json({ article });
});

contentRouter.get("/seo", validate({ query: z.object({ path: z.string().max(200) }) }), async (req, res) => {
  const q = res.locals.query as { path: string };
  res.json({ seo: await prisma.seoMetadata.findUnique({ where: { path: q.path } }) });
});
