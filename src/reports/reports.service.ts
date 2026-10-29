import path from "node:path";
import { calculateChart, type ChartResult } from "../astrology/chart.js";
import { env } from "../config/env.js";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";
import type { Prisma } from "../generated/prisma/client.js";
import { getOwnedProfile } from "../modules/birth-profiles/birth-profiles.service.js";
import { calculateForProfile, getOwnedChartRow, rowToChartResult } from "../modules/charts/charts.service.js";
import { notify } from "../modules/notifications/notifications.service.js";
import { REPORT_SECTIONS, renderReportBuffer, writeReportPdf, type ReportContext, type ReportSection, type ReportSubject } from "./generator.js";

export const storageRoot = () => path.resolve(env.STORAGE_DIR);

const DEFAULT_SECTIONS: ReportSection[] = ["summary", "chart_d1", "planets", "personality", "dasha_current", "methodology"];

function sectionsFor(template: { sections: Prisma.JsonValue } | null): ReportSection[] {
  const raw = Array.isArray(template?.sections) ? template.sections : [];
  const valid = raw.filter((s): s is ReportSection => typeof s === "string" && (REPORT_SECTIONS as readonly string[]).includes(s));
  return valid.length ? valid : DEFAULT_SECTIONS;
}

// ── Catalogue ─────────────────────────────────────────────────

const productSelect = {
  id: true,
  slug: true,
  title: true,
  description: true,
  contents: true,
  indicativePriceMinor: true,
  currency: true,
  requiresPartnerProfile: true,
} as const;

export const listCatalogue = () =>
  prisma.reportProduct.findMany({ where: { isActive: true }, orderBy: { sortOrder: "asc" }, select: productSelect });

export async function getProduct(slug: string) {
  const p = await prisma.reportProduct.findFirst({ where: { slug, isActive: true }, select: { ...productSelect, template: true } });
  if (!p) throw notFound("Report not found");
  return p;
}

// ── Entitlements ──────────────────────────────────────────────

// A grant without a product (membership credits) is valid for any report.
const usableGrantWhere = (userId: string, productId: string): Prisma.ReportAccessGrantWhereInput => ({
  userId,
  revokedAt: null,
  AND: [
    { OR: [{ productId }, { productId: null }] },
    { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
    { OR: [{ usesRemaining: null }, { usesRemaining: { gt: 0 } }] },
  ],
});

export async function listEntitlements(userId: string) {
  const grants = await prisma.reportAccessGrant.findMany({
    where: { userId, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
    select: { id: true, source: true, usesRemaining: true, expiresAt: true, createdAt: true, product: { select: { slug: true, title: true } } },
    orderBy: { createdAt: "desc" },
  });
  return grants.filter((g) => g.usesRemaining === null || g.usesRemaining > 0);
}

// ── Requests ──────────────────────────────────────────────────

export async function requestReport(
  userId: string,
  input: { productId: string; birthProfileId: string; partnerProfileId?: string | null },
) {
  const product = await prisma.reportProduct.findFirst({ where: { id: input.productId, isActive: true } });
  if (!product) throw notFound("Report not found");

  await getOwnedProfile(userId, input.birthProfileId);
  if (product.requiresPartnerProfile) {
    if (!input.partnerProfileId) throw badRequest("This report needs a second birth profile");
    if (input.partnerProfileId === input.birthProfileId) throw badRequest("Choose two different birth profiles");
    await getOwnedProfile(userId, input.partnerProfileId);
  }

  // Make sure the chart(s) exist before accepting the request.
  const { chartId } = await calculateForProfile(userId, input.birthProfileId);
  if (product.requiresPartnerProfile) await calculateForProfile(userId, input.partnerProfileId!);

  const report = await prisma.$transaction(async (tx) => {
    // Spend a grant for this exact report before a general membership credit, oldest first.
    const grant = await tx.reportAccessGrant.findFirst({
      where: usableGrantWhere(userId, product.id),
      orderBy: [{ productId: { sort: "asc", nulls: "last" } }, { expiresAt: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }],
    });
    if (!grant) {
      throw forbidden("Buy this report or use a membership credit to generate it.");
    }
    if (grant.usesRemaining !== null) {
      // Conditional decrement: two concurrent requests cannot both spend the last use.
      const spent = await tx.reportAccessGrant.updateMany({
        where: { id: grant.id, usesRemaining: { gt: 0 } },
        data: { usesRemaining: { decrement: 1 } },
      });
      if (spent.count !== 1) throw conflict("This access grant has already been used");
    }
    return tx.report.create({
      data: {
        userId,
        productId: product.id,
        birthProfileId: input.birthProfileId,
        partnerProfileId: product.requiresPartnerProfile ? input.partnerProfileId! : null,
        chartId,
        accessGrantId: grant.id,
        status: "QUEUED",
        jobs: { create: { status: "PENDING" } },
      },
      select: { id: true, status: true, createdAt: true },
    });
  });

  kickWorker();
  return report;
}

const reportListSelect = {
  id: true,
  status: true,
  createdAt: true,
  generatedAt: true,
  errorMessage: true,
  product: { select: { slug: true, title: true } },
  birthProfile: { select: { id: true, name: true } },
  partnerProfile: { select: { id: true, name: true } },
} as const;

export async function listReports(userId: string, skip: number, take: number) {
  const [items, total] = await Promise.all([
    prisma.report.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, skip, take, select: reportListSelect }),
    prisma.report.count({ where: { userId } }),
  ]);
  return { items: items.map(publicReport), total };
}

const publicReport = <T extends { errorMessage: string | null; status: string }>(r: T) => ({
  ...r,
  // Internal error details stay server-side.
  errorMessage: r.status === "FAILED" ? "Generation failed. Our team has been notified and can retry it." : null,
});

export async function getReport(userId: string, id: string) {
  const r = await prisma.report.findFirst({ where: { id, userId }, select: reportListSelect });
  if (!r) throw notFound("Report not found");
  return publicReport(r);
}

/** Resolves the PDF path for the owner, guarding against path traversal. */
export async function reportFileFor(userId: string, id: string) {
  const r = await prisma.report.findFirst({
    where: { id, userId },
    select: { status: true, storagePath: true, product: { select: { slug: true } } },
  });
  if (!r) throw notFound("Report not found");
  if (r.status !== "READY" || !r.storagePath) throw conflict("This report is not ready yet");
  const root = storageRoot();
  const full = path.resolve(root, r.storagePath);
  if (!full.startsWith(root + path.sep)) throw notFound("Report not found");
  return { path: full, filename: `astroveda-${r.product.slug}.pdf` };
}

// ── Generation ────────────────────────────────────────────────

const subjectOf = (p: Awaited<ReturnType<typeof getOwnedProfile>>): ReportSubject => ({
  name: p.name,
  dateOfBirth: p.dateOfBirth.toISOString().slice(0, 10),
  birthTime: p.birthTime,
  birthTimeAccuracy: p.birthTimeAccuracy,
  placeName: p.placeName,
  timezone: p.timezone,
});

async function generate(reportId: string) {
  const report = await prisma.report.findUniqueOrThrow({
    where: { id: reportId },
    include: { product: { include: { template: true } }, birthProfile: true, partnerProfile: true },
  });
  const chartId = report.chartId ?? (await calculateForProfile(report.userId, report.birthProfileId)).chartId;
  const chart = rowToChartResult(await getOwnedChartRow(report.userId, chartId));

  let partner: ReportContext["partner"];
  if (report.product.requiresPartnerProfile) {
    if (!report.partnerProfile) throw new Error("Partner profile was deleted");
    const pc = await calculateForProfile(report.userId, report.partnerProfile.id);
    partner = { subject: subjectOf(report.partnerProfile), chart: rowToChartResult(await getOwnedChartRow(report.userId, pc.chartId)) };
  }

  const relative = path.join("reports", report.userId, `${report.id}.pdf`);
  await writeReportPdf(
    {
      title: report.product.title,
      description: report.product.description,
      sections: sectionsFor(report.product.template),
      subject: subjectOf(report.birthProfile),
      chart,
      partner,
      generatedAt: new Date(),
    },
    path.join(storageRoot(), relative),
  );
  return relative;
}

/** Claims and runs one pending job. Returns false when the queue is empty. */
export async function processNextJob(): Promise<boolean> {
  const job = await prisma.reportGenerationJob.findFirst({ where: { status: "PENDING" }, orderBy: { createdAt: "asc" } });
  if (!job) return false;

  const claimed = await prisma.reportGenerationJob.updateMany({
    where: { id: job.id, status: "PENDING" },
    data: { status: "RUNNING", startedAt: new Date() },
  });
  if (claimed.count !== 1) return true; // another worker took it

  await prisma.report.update({ where: { id: job.reportId }, data: { status: "GENERATING" } });
  try {
    const storagePath = await generate(job.reportId);
    const report = await prisma.$transaction(async (tx) => {
      await tx.reportGenerationJob.update({ where: { id: job.id }, data: { status: "SUCCEEDED", finishedAt: new Date() } });
      return tx.report.update({
        where: { id: job.reportId },
        data: { status: "READY", storagePath, generatedAt: new Date(), errorMessage: null },
        include: { product: { select: { title: true } } },
      });
    });
    await notify(
      report.userId,
      { type: "REPORT_READY", title: "Your report is ready", body: `${report.product.title} is ready to download.`, link: "/dashboard/reports" },
      { email: true },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, reportId: job.reportId }, "Report generation failed");
    await prisma.$transaction([
      prisma.reportGenerationJob.update({ where: { id: job.id }, data: { status: "FAILED", lastError: message.slice(0, 1000), finishedAt: new Date() } }),
      prisma.report.update({ where: { id: job.reportId }, data: { status: "FAILED", errorMessage: message.slice(0, 1000) } }),
    ]);
  }
  return true;
}

/** Queues a fresh attempt for a failed report (admin action). */
export async function retryReport(reportId: string) {
  const report = await prisma.report.findUnique({ where: { id: reportId }, include: { jobs: { orderBy: { attempt: "desc" }, take: 1 } } });
  if (!report) throw notFound("Report not found");
  if (report.status !== "FAILED") throw conflict("Only failed reports can be retried");
  await prisma.$transaction([
    prisma.report.update({ where: { id: reportId }, data: { status: "QUEUED", errorMessage: null } }),
    prisma.reportGenerationJob.create({ data: { reportId, status: "PENDING", attempt: (report.jobs[0]?.attempt ?? 0) + 1 } }),
  ]);
  kickWorker();
}

// ── Worker loop ───────────────────────────────────────────────

let running = false;
let timer: NodeJS.Timeout | null = null;

async function drain() {
  if (running) return;
  running = true;
  try {
    while (await processNextJob()) {
      /* keep draining */
    }
  } catch (err) {
    logger.error({ err }, "Report worker error");
  } finally {
    running = false;
  }
}

export function kickWorker() {
  if (env.NODE_ENV === "test") return; // tests drive processNextJob() explicitly
  setImmediate(() => void drain());
}

export async function startReportWorker() {
  // Jobs left RUNNING by a crash are re-queued.
  await prisma.reportGenerationJob.updateMany({ where: { status: "RUNNING" }, data: { status: "PENDING", startedAt: null } });
  timer = setInterval(() => void drain(), 5000);
  timer.unref();
  void drain();
}

// ── Samples ───────────────────────────────────────────────────

// Clearly fictional sample subjects used only for catalogue previews.
const SAMPLE_SUBJECT: ReportSubject & { latitude: number; longitude: number } = {
  name: "Sample Person (fictional)",
  dateOfBirth: "1990-01-15",
  birthTime: "06:30",
  birthTimeAccuracy: "EXACT",
  placeName: "New Delhi, India",
  timezone: "Asia/Kolkata",
  latitude: 28.6139,
  longitude: 77.209,
};
const SAMPLE_PARTNER: typeof SAMPLE_SUBJECT = {
  name: "Sample Partner (fictional)",
  dateOfBirth: "1992-06-10",
  birthTime: "18:45",
  birthTimeAccuracy: "EXACT",
  placeName: "Mumbai, India",
  timezone: "Asia/Kolkata",
  latitude: 19.076,
  longitude: 72.8777,
};

const sampleChart = (s: typeof SAMPLE_SUBJECT): ChartResult =>
  calculateChart({ date: s.dateOfBirth, time: s.birthTime, timezone: s.timezone, latitude: s.latitude, longitude: s.longitude });

const sampleCache = new Map<string, { day: string; pdf: Buffer }>();

export async function samplePdf(slug: string): Promise<Buffer> {
  const today = new Date().toISOString().slice(0, 10);
  const hit = sampleCache.get(slug);
  if (hit && hit.day === today) return hit.pdf;

  const product = await getProduct(slug);
  const pdf = await renderReportBuffer({
    title: product.title,
    description: product.description,
    sections: sectionsFor(product.template),
    subject: SAMPLE_SUBJECT,
    chart: sampleChart(SAMPLE_SUBJECT),
    partner: product.requiresPartnerProfile ? { subject: SAMPLE_PARTNER, chart: sampleChart(SAMPLE_PARTNER) } : undefined,
    generatedAt: new Date(),
    sample: true,
  });
  sampleCache.set(slug, { day: today, pdf });
  return pdf;
}
