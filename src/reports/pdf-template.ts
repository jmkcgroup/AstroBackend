// Ivory-and-gold PDF building blocks for AstroVeda reports (pdfkit, built-in fonts).
// PDFs are English-only for now: pdfkit cannot shape Devanagari conjuncts correctly.
import PDFDocument from "pdfkit";
import { PLANET_LABELS, SIGNS, type PlanetName } from "../astrology/constants.js";

export const COLORS = {
  navy: "#071522",
  deepBlue: "#0C2133",
  gold: "#D9AD61",
  champagne: "#F0D49A",
  ivory: "#F8F3E8",
  card: "#FFFDF8",
  slate: "#68717B",
  border: "#E8DECA",
} as const;

const MARGIN = 50;
const FOOTER_SPACE = 50;

export type Pdf = InstanceType<typeof PDFDocument>;

export function createReportDocument(meta: { title: string; subject: string }): Pdf {
  const doc = new PDFDocument({
    size: "A4",
    margins: { top: MARGIN, bottom: MARGIN + FOOTER_SPACE, left: MARGIN, right: MARGIN },
    bufferPages: true,
    info: { Title: meta.title, Subject: meta.subject, Author: "AstroVeda", Creator: "AstroVeda" },
  });
  const paintBackground = () => {
    doc.save().rect(0, 0, doc.page.width, doc.page.height).fill(COLORS.ivory).restore();
    doc.fillColor(COLORS.deepBlue);
  };
  paintBackground();
  doc.on("pageAdded", paintBackground);
  return doc;
}

const contentWidth = (doc: Pdf) => doc.page.width - doc.page.margins.left - doc.page.margins.right;

function ensureSpace(doc: Pdf, height: number) {
  if (doc.y + height > doc.page.height - doc.page.margins.bottom) doc.addPage();
}

export function coverPage(
  doc: Pdf,
  opts: { title: string; subtitle: string; name: string; birthLine: string; placeLine: string; generatedAt: Date; sample?: boolean },
) {
  const w = doc.page.width;
  doc.save().rect(0, 0, w, 260).fill(COLORS.navy).restore();
  // Decorative orbit rings
  doc.save().lineWidth(0.6).strokeColor(COLORS.gold).opacity(0.35);
  for (const r of [70, 105, 140]) doc.circle(w - 90, 120, r).stroke();
  doc.restore();
  doc.save().circle(w - 90, 120, 18).fill(COLORS.gold).restore();

  doc.fillColor(COLORS.champagne).font("Times-Roman").fontSize(14).text("AstroVeda", MARGIN, 60);
  doc.fillColor(COLORS.card).font("Times-Bold").fontSize(30).text(opts.title, MARGIN, 110, { width: w - 220 });
  doc.fillColor(COLORS.champagne).font("Helvetica").fontSize(11).text(opts.subtitle, MARGIN, doc.y + 8, { width: w - 220 });

  if (opts.sample) {
    doc.save().roundedRect(MARGIN, 280, w - 2 * MARGIN, 34, 6).fill("#FBE9D0").restore();
    doc
      .fillColor("#8A5A12")
      .font("Helvetica-Bold")
      .fontSize(10)
      .text("SAMPLE REPORT — generated from fictional sample birth data for preview purposes only.", MARGIN + 12, 292, {
        width: w - 2 * MARGIN - 24,
      });
  }

  const top = opts.sample ? 340 : 300;
  doc.save().roundedRect(MARGIN, top, w - 2 * MARGIN, 120, 10).fillAndStroke(COLORS.card, COLORS.border).restore();
  doc.fillColor(COLORS.slate).font("Helvetica").fontSize(9).text("PREPARED FOR", MARGIN + 20, top + 18);
  doc.fillColor(COLORS.deepBlue).font("Times-Bold").fontSize(20).text(opts.name, MARGIN + 20, top + 32);
  doc.fillColor(COLORS.deepBlue).font("Helvetica").fontSize(11).text(opts.birthLine, MARGIN + 20, top + 64);
  doc.text(opts.placeLine, MARGIN + 20, top + 82);
  doc
    .fillColor(COLORS.slate)
    .fontSize(9)
    .text(`Generated ${opts.generatedAt.toISOString().slice(0, 16).replace("T", " ")} UTC`, MARGIN + 20, top + 100);

  doc.y = top + 150;
  doc.x = MARGIN;
}

export function sectionHeading(doc: Pdf, title: string) {
  ensureSpace(doc, 60);
  doc.moveDown(0.6);
  doc.fillColor(COLORS.deepBlue).font("Times-Bold").fontSize(17).text(title, doc.page.margins.left);
  const y = doc.y + 3;
  doc.save().moveTo(doc.page.margins.left, y).lineTo(doc.page.margins.left + 60, y).lineWidth(2).strokeColor(COLORS.gold).stroke().restore();
  doc.moveDown(0.8);
}

export function subHeading(doc: Pdf, title: string) {
  ensureSpace(doc, 40);
  doc.moveDown(0.3);
  doc.fillColor(COLORS.deepBlue).font("Helvetica-Bold").fontSize(11.5).text(title, doc.page.margins.left);
  doc.moveDown(0.3);
}

export function paragraph(doc: Pdf, text: string, opts: { muted?: boolean; size?: number } = {}) {
  ensureSpace(doc, 30);
  doc
    .fillColor(opts.muted ? COLORS.slate : COLORS.deepBlue)
    .font("Helvetica")
    .fontSize(opts.size ?? 10.5)
    .text(text, doc.page.margins.left, doc.y, { width: contentWidth(doc), lineGap: 3, align: "left" });
  doc.moveDown(0.5);
}

export function bulletList(doc: Pdf, items: string[]) {
  for (const item of items) {
    ensureSpace(doc, 20);
    const y = doc.y;
    doc.save().circle(doc.page.margins.left + 4, y + 5, 2).fill(COLORS.gold).restore();
    doc.fillColor(COLORS.deepBlue).font("Helvetica").fontSize(10).text(item, doc.page.margins.left + 14, y, {
      width: contentWidth(doc) - 14,
      lineGap: 2,
    });
    doc.moveDown(0.25);
  }
  doc.moveDown(0.3);
}

export function table(doc: Pdf, headers: string[], rows: string[][], widths: number[]) {
  const total = widths.reduce((a, b) => a + b, 0);
  const scale = contentWidth(doc) / total;
  const cols = widths.map((w) => w * scale);
  const rowH = 20;
  const left = doc.page.margins.left;

  const drawHeader = () => {
    ensureSpace(doc, rowH * 2);
    const y = doc.y;
    doc.save().rect(left, y, contentWidth(doc), rowH).fill(COLORS.deepBlue).restore();
    let x = left;
    headers.forEach((h, i) => {
      doc.fillColor(COLORS.champagne).font("Helvetica-Bold").fontSize(8.5).text(h, x + 6, y + 6, { width: cols[i]! - 12, lineBreak: false });
      x += cols[i]!;
    });
    doc.y = y + rowH;
  };

  drawHeader();
  rows.forEach((row, r) => {
    if (doc.y + rowH > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
      drawHeader();
    }
    const y = doc.y;
    doc.save().rect(left, y, contentWidth(doc), rowH).fill(r % 2 === 0 ? COLORS.card : COLORS.ivory).restore();
    let x = left;
    row.forEach((cell, i) => {
      doc.fillColor(COLORS.deepBlue).font("Helvetica").fontSize(8.5).text(cell, x + 6, y + 6, { width: cols[i]! - 12, lineBreak: false, ellipsis: true });
      x += cols[i]!;
    });
    doc.y = y + rowH;
    doc.save().moveTo(left, doc.y).lineTo(left + contentWidth(doc), doc.y).lineWidth(0.4).strokeColor(COLORS.border).stroke().restore();
  });
  doc.x = left;
  doc.moveDown(0.8);
}

/**
 * North Indian (diamond) chart. House 1 is the top-centre diamond and houses run
 * counter-clockwise. Each house shows its sign number and the grahas it contains.
 */
export function northIndianChart(
  doc: Pdf,
  opts: { title: string; houseSigns: number[]; occupants: Record<number, PlanetName[]>; size?: number },
) {
  const size = opts.size ?? 230;
  ensureSpace(doc, size + 40);
  subHeading(doc, opts.title);
  const x0 = doc.page.margins.left + (contentWidth(doc) - size) / 2;
  const y0 = doc.y + 4;
  const S = size;

  doc.save().rect(x0, y0, S, S).fillAndStroke(COLORS.card, COLORS.gold);
  doc.lineWidth(0.9).strokeColor(COLORS.gold);
  doc.moveTo(x0, y0).lineTo(x0 + S, y0 + S).stroke();
  doc.moveTo(x0 + S, y0).lineTo(x0, y0 + S).stroke();
  doc
    .moveTo(x0 + S / 2, y0)
    .lineTo(x0 + S, y0 + S / 2)
    .lineTo(x0 + S / 2, y0 + S)
    .lineTo(x0, y0 + S / 2)
    .closePath()
    .stroke();
  doc.restore();

  for (let h = 1; h <= 12; h++) {
    const [cx, cy] = NORTH_INDIAN_CENTERS[h]!;
    const px = x0 + cx * S;
    const py = y0 + cy * S;
    doc.fillColor(COLORS.slate).font("Helvetica").fontSize(7.5).text(String(opts.houseSigns[h - 1]), px - 15, py - 14, {
      width: 30,
      align: "center",
    });
    const names = (opts.occupants[h] ?? []).map((p) => PLANET_LABELS[p].abbr).join(" ");
    if (names) {
      doc.fillColor(COLORS.deepBlue).font("Helvetica-Bold").fontSize(8).text(names, px - 28, py - 3, { width: 56, align: "center" });
    }
  }
  doc.y = y0 + S + 14;
  doc.x = doc.page.margins.left;
  paragraph(doc, "Numbers show the sign in each house (1 = Aries … 12 = Pisces). House 1 is the top centre diamond.", {
    muted: true,
    size: 8.5,
  });
}

// Relative centres (0–1) of the 12 houses in the North Indian layout.
export const NORTH_INDIAN_CENTERS: Record<number, [number, number]> = {
  1: [0.5, 0.25],
  2: [0.25, 0.1],
  3: [0.1, 0.25],
  4: [0.25, 0.5],
  5: [0.1, 0.75],
  6: [0.25, 0.9],
  7: [0.5, 0.75],
  8: [0.75, 0.9],
  9: [0.9, 0.75],
  10: [0.75, 0.5],
  11: [0.9, 0.25],
  12: [0.75, 0.1],
};

export function finalizeWithFooters(doc: Pdf, footer: string) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const bottom = doc.page.height - MARGIN - 18;
    // Writing inside the bottom margin must not trigger an automatic page break.
    const savedBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.save().moveTo(MARGIN, bottom - 6).lineTo(doc.page.width - MARGIN, bottom - 6).lineWidth(0.5).strokeColor(COLORS.border).stroke().restore();
    doc.fillColor(COLORS.slate).font("Helvetica").fontSize(7.5).text(footer, MARGIN, bottom, {
      width: doc.page.width - 2 * MARGIN - 60,
      lineBreak: true,
    });
    doc.text(`${i - range.start + 1} / ${range.count}`, doc.page.width - MARGIN - 50, bottom, { width: 50, align: "right" });
    doc.page.margins.bottom = savedBottom;
  }
}

export const signLabel = (sign: number) => `${SIGNS[sign - 1]!.en} (${SIGNS[sign - 1]!.sanskrit})`;

export const formatDegrees = (deg: number) => {
  const d = Math.floor(deg);
  const mFloat = (deg - d) * 60;
  const m = Math.floor(mFloat);
  const s = Math.floor((mFloat - m) * 60);
  return `${d}°${String(m).padStart(2, "0")}'${String(s).padStart(2, "0")}"`;
};
