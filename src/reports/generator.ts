// Renders a report PDF from calculated chart data. No section ever invents positions:
// everything printed comes from the ChartResult, the transit engine or Guna Milan.
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { PLANET_LABELS, NAKSHATRAS, type PlanetName } from "../astrology/constants.js";
import { METHODOLOGY, type ChartResult } from "../astrology/chart.js";
import {
  INTERPRETATION_DISCLAIMER,
  houseLordSentence,
  interpretChart,
  occupantsSentence,
  type InterpretationSectionKey,
} from "../astrology/interpretation.js";
import { gunaMilan } from "../astrology/matching.js";
import { calculateTransits } from "../astrology/transit.js";
import {
  bulletList,
  coverPage,
  createReportDocument,
  finalizeWithFooters,
  formatDegrees,
  northIndianChart,
  paragraph,
  sectionHeading,
  signLabel,
  subHeading,
  table,
  type Pdf,
} from "./pdf-template.js";

export const REPORT_SECTIONS = [
  "summary",
  "chart_d1",
  "chart_d9",
  "planets",
  "houses",
  "personality",
  "career",
  "relationships",
  "finance",
  "spiritual",
  "strengths",
  "dasha_current",
  "dasha_timeline",
  "transits_now",
  "transits_year",
  "compatibility",
  "methodology",
] as const;
export type ReportSection = (typeof REPORT_SECTIONS)[number];

export type ReportSubject = {
  name: string;
  dateOfBirth: string;
  birthTime: string;
  birthTimeAccuracy: "EXACT" | "APPROXIMATE" | "UNKNOWN";
  placeName: string;
  timezone: string;
};

export type ReportContext = {
  title: string;
  description: string;
  sections: ReportSection[];
  subject: ReportSubject;
  chart: ChartResult;
  partner?: { subject: ReportSubject; chart: ChartResult };
  generatedAt: Date;
  sample?: boolean;
};

const pName = (p: PlanetName) => PLANET_LABELS[p].en;
const day = (d: Date) => d.toISOString().slice(0, 10);

const INTERP_MAP: Partial<Record<ReportSection, InterpretationSectionKey>> = {
  personality: "PERSONALITY",
  career: "CAREER_EDUCATION",
  relationships: "RELATIONSHIPS",
  spiritual: "SPIRITUAL",
  strengths: "STRENGTHS_CHALLENGES",
};

/** Sign ingresses and retrograde stations of the slow grahas over the next year (daily resolution). */
export function yearAhead(from: Date, moonSign: number) {
  const bodies: PlanetName[] = ["JUPITER", "SATURN", "RAHU", "MARS"];
  const events: { date: Date; text: string }[] = [];
  let prev = calculateTransits(from, "LAHIRI", moonSign);
  for (let i = 1; i <= 365; i++) {
    const at = new Date(from.getTime() + i * 86_400_000);
    const cur = calculateTransits(at, "LAHIRI", moonSign);
    for (const b of bodies) {
      const a = prev.positions.find((p) => p.planet === b)!;
      const c = cur.positions.find((p) => p.planet === b)!;
      if (a.sign !== c.sign) {
        events.push({
          date: at,
          text: `${pName(b)} enters ${signLabel(c.sign)} — house ${c.houseFromMoon} from your Moon`,
        });
      }
      if (b !== "RAHU" && Math.sign(a.speed) !== Math.sign(c.speed)) {
        events.push({ date: at, text: `${pName(b)} turns ${c.speed < 0 ? "retrograde" : "direct"} in ${signLabel(c.sign)}` });
      }
    }
    prev = cur;
  }
  return events;
}

function renderSection(doc: Pdf, section: ReportSection, ctx: ReportContext, interp: ReturnType<typeof interpretChart>) {
  const c = ctx.chart;
  switch (section) {
    case "summary": {
      sectionHeading(doc, "Birth chart summary");
      const moon = c.planets.find((p) => p.planet === "MOON")!;
      table(
        doc,
        ["Element", "Value"],
        [
          ["Lagna (Ascendant)", `${signLabel(c.ascendant.sign)} ${formatDegrees(c.ascendant.degreeInSign)}`],
          ["Janma Rashi (Moon sign)", signLabel(c.summary.moonSign)],
          ["Sun sign (sidereal)", signLabel(c.summary.sunSign)],
          ["Janma Nakshatra", `${NAKSHATRAS[moon.nakshatra - 1]!.en}, pada ${moon.pada}`],
          ["Ayanamsha", `${c.ayanamsha} ${formatDegrees(c.ayanamshaValue)}`],
          ["Birth moment (UTC)", c.utcDateTime.toISOString().replace("T", " ").slice(0, 19)],
        ],
        [1, 1.6],
      );
      if (ctx.subject.birthTimeAccuracy !== "EXACT") {
        paragraph(
          doc,
          `Note: the birth time is recorded as ${ctx.subject.birthTimeAccuracy.toLowerCase()}. The Lagna, houses and dasha dates depend on the exact time and may differ from what is shown.`,
          { muted: true },
        );
      }
      if (c.timeAmbiguity !== "none") {
        paragraph(
          doc,
          c.timeAmbiguity === "gap"
            ? "Note: the entered local time falls in a daylight-saving gap and did not exist on the clock; it was interpreted with the earlier offset."
            : "Note: the entered local time occurred twice because of a daylight-saving change; the earlier occurrence was used.",
          { muted: true },
        );
      }
      break;
    }
    case "chart_d1":
      northIndianChart(doc, {
        title: "Rashi chart (D1) — North Indian style",
        houseSigns: c.houses.map((h) => h.sign),
        occupants: c.d1,
      });
      break;
    case "chart_d9": {
      // D9 houses are counted from the navamsha lagna.
      const houseSigns = Array.from({ length: 12 }, (_, i) => ((c.d9.ascendantSign - 1 + i) % 12) + 1);
      const occupants: Record<number, PlanetName[]> = {};
      houseSigns.forEach((sign, i) => (occupants[i + 1] = c.d9.signs[sign] ?? []));
      northIndianChart(doc, { title: "Navamsha chart (D9)", houseSigns, occupants, size: 200 });
      break;
    }
    case "planets":
      sectionHeading(doc, "Planetary positions");
      table(
        doc,
        ["Graha", "Sign", "Degree", "House", "Nakshatra", "Pada", "D9", "Notes"],
        c.planets.map((p) => [
          pName(p.planet),
          signLabel(p.sign).split(" ")[0]!,
          formatDegrees(p.degreeInSign),
          String(p.house),
          NAKSHATRAS[p.nakshatra - 1]!.en,
          String(p.pada),
          signLabel(p.navamshaSign).split(" ")[0]!,
          [p.isRetrograde && p.planet !== "RAHU" && p.planet !== "KETU" ? "R" : "", p.dignity?.toLowerCase().replace("_", " ") ?? ""]
            .filter(Boolean)
            .join(", "),
        ]),
        [1, 1.1, 1, 0.6, 1.4, 0.5, 0.9, 1.1],
      );
      break;
    case "houses":
      sectionHeading(doc, "Houses (whole sign)");
      table(
        doc,
        ["House", "Sign", "Lord", "Lord placed in", "Occupants"],
        c.houses.map((h) => [
          String(h.house),
          signLabel(h.sign),
          pName(h.lord),
          `House ${c.planets.find((p) => p.planet === h.lord)!.house}`,
          (c.d1[h.house] ?? []).map(pName).join(", ") || "—",
        ]),
        [0.6, 1.6, 0.9, 1, 1.6],
      );
      break;
    case "finance": {
      sectionHeading(doc, "Finance and wealth themes");
      for (const h of [2, 11, 9]) {
        const s = houseLordSentence(c, h, "EN");
        paragraph(doc, s.text);
        const occ = occupantsSentence(c, h, "EN");
        if (occ) paragraph(doc, occ);
      }
      paragraph(doc, "These are traditional themes for the houses of resources (2nd), gains (11th) and fortune (9th); they are not financial advice.", { muted: true });
      break;
    }
    case "personality":
    case "career":
    case "relationships":
    case "spiritual":
    case "strengths": {
      const block = interp.find((b) => b.section === INTERP_MAP[section]);
      if (!block) break;
      sectionHeading(doc, block.title);
      for (const p of block.paragraphs) paragraph(doc, p);
      paragraph(doc, `Chart factors: ${block.factors.join("; ")}`, { muted: true, size: 8.5 });
      break;
    }
    case "dasha_current": {
      const block = interp.find((b) => b.section === "DASHA");
      sectionHeading(doc, "Current dasha period");
      for (const p of block?.paragraphs ?? []) paragraph(doc, p);
      break;
    }
    case "dasha_timeline": {
      sectionHeading(doc, "Vimshottari Mahadasha timeline");
      const now = ctx.generatedAt;
      table(
        doc,
        ["Mahadasha", "Starts", "Ends", ""],
        c.dashas
          .filter((d) => d.level === "MAHADASHA")
          .map((d) => [pName(d.planet), day(d.startsAt), day(d.endsAt), d.startsAt <= now && d.endsAt > now ? "current" : ""]),
        [1.2, 1, 1, 0.8],
      );
      const current = c.dashas.find((d) => d.level === "MAHADASHA" && d.startsAt <= now && d.endsAt > now);
      if (current) {
        subHeading(doc, `Antardashas within ${pName(current.planet)} Mahadasha`);
        table(
          doc,
          ["Antardasha", "Starts", "Ends"],
          c.dashas
            .filter((d) => d.level === "ANTARDASHA" && d.parentPlanet === current.planet)
            .map((d) => [`${pName(current.planet)} / ${pName(d.planet)}`, day(d.startsAt), day(d.endsAt)]),
          [1.6, 1, 1],
        );
      }
      break;
    }
    case "transits_now": {
      const block = interp.find((b) => b.section === "TRANSITS");
      sectionHeading(doc, "Current transits (gochar)");
      for (const p of block?.paragraphs ?? []) paragraph(doc, p);
      const t = calculateTransits(ctx.generatedAt, c.ayanamsha, c.summary.moonSign);
      table(
        doc,
        ["Graha", "Transit sign", "Degree", "House from Moon"],
        t.positions.map((p) => [
          `${pName(p.planet)}${p.isRetrograde && p.planet !== "RAHU" && p.planet !== "KETU" ? " (R)" : ""}`,
          signLabel(p.sign),
          formatDegrees(p.degreeInSign),
          String(p.houseFromMoon),
        ]),
        [1, 1.6, 1, 1],
      );
      break;
    }
    case "transits_year": {
      sectionHeading(doc, "The year ahead: major transits");
      const events = yearAhead(ctx.generatedAt, c.summary.moonSign);
      if (events.length === 0) paragraph(doc, "No sign changes or stations of Jupiter, Saturn, Rahu or Mars occur in the next 12 months.");
      else bulletList(doc, events.map((e) => `${day(e.date)} — ${e.text}`));
      paragraph(doc, "Dates are calculated at daily resolution for the Lahiri sidereal zodiac.", { muted: true, size: 8.5 });
      break;
    }
    case "compatibility": {
      if (!ctx.partner) break;
      sectionHeading(doc, `Guna Milan with ${ctx.partner.subject.name}`);
      const moon = (ch: ChartResult) => ch.planets.find((p) => p.planet === "MOON")!.longitude;
      const result = gunaMilan({ moonLongitude: moon(c) }, { moonLongitude: moon(ctx.partner.chart) });
      paragraph(doc, `Total: ${result.total} of ${result.max} points.`);
      table(
        doc,
        ["Koota", "Score", "Max", "Detail"],
        result.kootas.map((k) => [k.koota, String(k.score), String(k.max), k.detail]),
        [1, 0.5, 0.5, 2.2],
      );
      bulletList(doc, result.notes);
      break;
    }
    case "methodology":
      sectionHeading(doc, "Calculation methodology");
      bulletList(doc, [
        `Ephemeris: ${c.ephemerisSource} (${c.engineVersion})`,
        `Zodiac: ${METHODOLOGY.zodiac}; ayanamsha ${c.ayanamsha} = ${formatDegrees(c.ayanamshaValue)}`,
        `Houses: ${METHODOLOGY.houseSystem}`,
        `Lunar node: ${METHODOLOGY.lunarNode}`,
        `Divisional charts: ${METHODOLOGY.divisionalCharts}`,
        `Aspects: ${METHODOLOGY.aspects}`,
        `Dasha: ${METHODOLOGY.dasha}`,
        `Time zone: ${ctx.subject.timezone}; ${METHODOLOGY.timezone}`,
      ]);
      sectionHeading(doc, "Disclaimer");
      paragraph(doc, INTERPRETATION_DISCLAIMER.en);
      paragraph(
        doc,
        "Astrology is a traditional system of reflection. Please do not make medical, legal, financial or relationship decisions based solely on this report; consult a qualified professional where appropriate.",
      );
      break;
  }
}

export function renderReport(ctx: ReportContext): Pdf {
  const doc = createReportDocument({ title: ctx.title, subject: ctx.description });
  const accuracy = ctx.subject.birthTimeAccuracy === "EXACT" ? "" : ` (${ctx.subject.birthTimeAccuracy.toLowerCase()})`;
  coverPage(doc, {
    title: ctx.title,
    subtitle: ctx.description,
    name: ctx.subject.name,
    birthLine: `Born ${ctx.subject.dateOfBirth} at ${ctx.subject.birthTime}${accuracy} (${ctx.subject.timezone})`,
    placeLine: ctx.subject.placeName,
    generatedAt: ctx.generatedAt,
    sample: ctx.sample,
  });

  const transits = calculateTransits(ctx.generatedAt, ctx.chart.ayanamsha, ctx.chart.summary.moonSign);
  const interp = interpretChart(ctx.chart, "EN", transits, ctx.generatedAt);
  const sections = ctx.sections.includes("methodology") ? ctx.sections : [...ctx.sections, "methodology" as const];
  for (const s of sections) renderSection(doc, s, ctx, interp);

  finalizeWithFooters(
    doc,
    `AstroVeda${ctx.sample ? " — SAMPLE" : ""} · Generated ${day(ctx.generatedAt)} · For reflection only; not a guarantee of outcomes.`,
  );
  return doc;
}

/** Writes the PDF to disk and resolves once it is fully flushed. */
export async function writeReportPdf(ctx: ReportContext, filePath: string) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const doc = renderReport(ctx);
  const out = createWriteStream(filePath);
  const done = new Promise<void>((resolve, reject) => {
    out.on("finish", resolve);
    out.on("error", reject);
    doc.on("error", reject);
  });
  doc.pipe(out);
  doc.end();
  await done;
}

export async function renderReportBuffer(ctx: ReportContext): Promise<Buffer> {
  const doc = renderReport(ctx);
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((resolve, reject) => {
    doc.on("end", resolve);
    doc.on("error", reject);
  });
  doc.end();
  await done;
  return Buffer.concat(chunks);
}
