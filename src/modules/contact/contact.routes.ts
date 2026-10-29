import { Router } from "express";
import { z } from "zod";
import { env } from "../../config/env.js";
import { emails, sendMail } from "../../lib/email.js";
import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";
import { formLimiter } from "../../middleware/rate-limit.js";
import { validate } from "../../middleware/validate.js";

export const contactRouter = Router();

const contactSchema = z.object({
  name: z.string().trim().min(2).max(80),
  email: z.email().max(254),
  subject: z.string().trim().min(3).max(150),
  message: z.string().trim().min(10).max(4000),
  // Spam protection: a hidden field humans leave empty, and the time the form was opened.
  website: z.string().max(500).optional(),
  formStartedAt: z.coerce.number().int().optional(),
});

contactRouter.post("/contact", formLimiter, validate({ body: contactSchema }), async (req, res) => {
  const body = req.body as z.infer<typeof contactSchema>;
  const tooFast = body.formStartedAt !== undefined && Date.now() - body.formStartedAt < 3000;
  if (body.website || tooFast) {
    // Pretend success so bots learn nothing.
    res.status(201).json({ ok: true });
    return;
  }

  const msg = await prisma.contactMessage.create({
    data: { name: body.name, email: body.email.toLowerCase(), subject: body.subject, message: body.message },
    select: { id: true },
  });

  if (env.CONTACT_INBOX) {
    await sendMail({
      to: env.CONTACT_INBOX,
      replyTo: body.email,
      subject: `[AstroVeda contact] ${body.subject}`,
      text: `From: ${body.name} <${body.email}>\n\n${body.message}`,
      html: `<p><strong>From:</strong> ${emails.escapeHtml(body.name)} &lt;${emails.escapeHtml(body.email)}&gt;</p><p>${emails.escapeHtml(body.message).replace(/\n/g, "<br>")}</p>`,
    }).catch((err) => logger.error({ err }, "Failed to forward contact message"));
  }

  res.status(201).json({ ok: true, id: msg.id });
});

contactRouter.post(
  "/newsletter",
  formLimiter,
  validate({ body: z.object({ email: z.email().max(254) }) }),
  async (req, res) => {
    const email = (req.body.email as string).toLowerCase();
    await prisma.newsletterSubscription.upsert({
      where: { email },
      update: { unsubscribedAt: null },
      create: { email },
    });
    res.status(201).json({ ok: true });
  },
);
