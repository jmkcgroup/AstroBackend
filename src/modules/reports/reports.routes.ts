import { createReadStream } from "node:fs";
import { Router } from "express";
import { z } from "zod";
import { paged, paginationSchema, toSkipTake, type Pagination } from "../../lib/pagination.js";
import { currentUser, requireAuth } from "../../middleware/auth.js";
import { toolLimiter } from "../../middleware/rate-limit.js";
import { validate } from "../../middleware/validate.js";
import * as svc from "../../reports/reports.service.js";

export const reportsRouter = Router();

const id = z.string().min(1).max(40);

// Public catalogue
reportsRouter.get("/catalogue", async (_req, res) => {
  res.set("Cache-Control", "public, max-age=300");
  res.json({ items: await svc.listCatalogue() });
});

reportsRouter.get("/catalogue/:slug", validate({ params: z.object({ slug: z.string().max(80) }) }), async (req, res) => {
  const { template: _template, ...product } = await svc.getProduct(req.params.slug as string);
  res.json({ product });
});

reportsRouter.get("/catalogue/:slug/sample", toolLimiter, validate({ params: z.object({ slug: z.string().max(80) }) }), async (req, res) => {
  const pdf = await svc.samplePdf(req.params.slug as string);
  res.set("Content-Type", "application/pdf");
  res.set("Content-Disposition", `inline; filename="astroveda-sample-${req.params.slug}.pdf"`);
  res.set("Cache-Control", "public, max-age=3600");
  res.send(pdf);
});

// Authenticated
reportsRouter.get("/entitlements", requireAuth, async (req, res) => {
  res.json({ items: await svc.listEntitlements(currentUser(req).userId) });
});

reportsRouter.get("/", requireAuth, validate({ query: paginationSchema }), async (req, res) => {
  const p = res.locals.query as Pagination;
  const { skip, take } = toSkipTake(p);
  const { items, total } = await svc.listReports(currentUser(req).userId, skip, take);
  res.json(paged(items, total, p));
});

reportsRouter.post(
  "/",
  requireAuth,
  validate({ body: z.object({ productId: id, birthProfileId: id, partnerProfileId: id.nullish() }) }),
  async (req, res) => {
    res.status(201).json({ report: await svc.requestReport(currentUser(req).userId, req.body) });
  },
);

reportsRouter.get("/:id", requireAuth, validate({ params: z.object({ id }) }), async (req, res) => {
  res.json({ report: await svc.getReport(currentUser(req).userId, req.params.id as string) });
});

reportsRouter.get("/:id/download", requireAuth, validate({ params: z.object({ id }) }), async (req, res) => {
  const file = await svc.reportFileFor(currentUser(req).userId, req.params.id as string);
  res.set("Content-Type", "application/pdf");
  res.set("Content-Disposition", `attachment; filename="${file.filename}"`);
  res.set("Cache-Control", "private, no-store");
  createReadStream(file.path).on("error", () => res.destroy()).pipe(res);
});
