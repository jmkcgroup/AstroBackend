import nodemailer from "nodemailer";
import { env, features } from "../config/env.js";
import { logger } from "./logger.js";

const transport = features.smtp
  ? nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_PORT === 465,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
    })
  : null;

export type MailMessage = { to: string; subject: string; text: string; html?: string; replyTo?: string };

/**
 * Sends an email when SMTP is configured. Without SMTP (development), the message is
 * written to the server log instead so links such as email verification can still be used.
 * Returns whether the message was actually delivered to an SMTP server.
 */
export async function sendMail(msg: MailMessage): Promise<boolean> {
  if (!transport) {
    logger.warn({ to: msg.to, subject: msg.subject }, "SMTP not configured; email not sent");
    if (env.NODE_ENV !== "production") logger.info(`\n--- email to ${msg.to} ---\n${msg.text}\n---`);
    return false;
  }
  await transport.sendMail({ from: env.EMAIL_FROM, ...msg });
  return true;
}

const layout = (title: string, body: string) => `<!doctype html>
<html><body style="margin:0;background:#F8F3E8;font-family:Arial,sans-serif;color:#0C2133">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table width="560" cellpadding="0" cellspacing="0" style="background:#FFFDF8;border:1px solid #E8DECA;border-radius:12px">
<tr><td style="background:#071522;padding:20px 28px;border-radius:12px 12px 0 0;color:#F0D49A;font-size:20px;font-family:Georgia,serif">AstroVeda</td></tr>
<tr><td style="padding:28px"><h1 style="font-family:Georgia,serif;font-size:22px;margin:0 0 16px">${title}</h1>${body}</td></tr>
</table></td></tr></table></body></html>`;

const button = (href: string, label: string) =>
  `<p style="margin:24px 0"><a href="${href}" style="background:#D9AD61;color:#071522;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:bold">${label}</a></p>`;

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

export const emails = {
  verifyEmail(name: string, link: string): Omit<MailMessage, "to"> {
    return {
      subject: "Verify your AstroVeda email",
      text: `Namaste ${name},\n\nPlease verify your email address by opening this link (valid for 24 hours):\n${link}\n\nIf you did not create an account, you can ignore this email.`,
      html: layout(
        "Verify your email",
        `<p>Namaste ${escapeHtml(name)},</p><p>Please confirm your email address to finish setting up your account. This link is valid for 24 hours.</p>${button(link, "Verify email")}<p style="color:#68717B;font-size:13px">If you did not create an account, you can ignore this email.</p>`,
      ),
    };
  },
  resetPassword(name: string, link: string): Omit<MailMessage, "to"> {
    return {
      subject: "Reset your AstroVeda password",
      text: `Namaste ${name},\n\nUse this link to set a new password (valid for 1 hour, single use):\n${link}\n\nIf you did not request this, you can ignore this email.`,
      html: layout(
        "Reset your password",
        `<p>Namaste ${escapeHtml(name)},</p><p>Use the button below to choose a new password. The link is valid for 1 hour and can be used once.</p>${button(link, "Reset password")}<p style="color:#68717B;font-size:13px">If you did not request a password reset, you can ignore this email.</p>`,
      ),
    };
  },
  notification(name: string, title: string, body: string, link?: string): Omit<MailMessage, "to"> {
    return {
      subject: title,
      text: `Namaste ${name},\n\n${body}${link ? `\n\n${link}` : ""}`,
      html: layout(
        escapeHtml(title),
        `<p>Namaste ${escapeHtml(name)},</p><p>${escapeHtml(body)}</p>${link ? button(link, "Open AstroVeda") : ""}`,
      ),
    };
  },
  escapeHtml,
};
