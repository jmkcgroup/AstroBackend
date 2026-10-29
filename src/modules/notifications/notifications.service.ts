import { env } from "../../config/env.js";
import { emails, sendMail } from "../../lib/email.js";
import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";

type Notice = { type: string; title: string; body: string; link?: string };

/** Creates an in-app notification and, when SMTP is configured, also emails it. */
export async function notify(userId: string, notice: Notice, opts: { email?: boolean } = {}) {
  const row = await prisma.notification.create({ data: { userId, ...notice, link: notice.link ?? null } });

  if (opts.email) {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, name: true } });
    if (user) {
      const link = notice.link ? `${env.FRONTEND_URL}${notice.link}` : undefined;
      await sendMail({ to: user.email, ...emails.notification(user.name, notice.title, notice.body, link) }).catch((err) =>
        logger.error({ err }, "Failed to send notification email"),
      );
    }
  }
  return row;
}
