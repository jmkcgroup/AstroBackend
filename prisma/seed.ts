// Development seed. Run with: npm run db:seed
// Creates the report catalogue and reference data. An admin account is created only when
// SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD are set (never with a default password).
import "dotenv/config";
import { prisma } from "../src/lib/prisma.js";
import { hashPassword, passwordSchema } from "../src/lib/password.js";
import { seedCatalogue } from "../src/seed/catalogue.js";

async function main() {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Refusing to run the development seed in production.");
  }

  await seedCatalogue(prisma);
  console.log("Seeded report catalogue, templates, specializations, FAQs and settings.");

  const email = process.env.SEED_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (email && password) {
    passwordSchema.parse(password);
    await prisma.user.upsert({
      where: { email },
      update: { role: "ADMIN" },
      create: {
        email,
        name: "AstroVeda Admin",
        role: "ADMIN",
        passwordHash: await hashPassword(password),
        emailVerifiedAt: new Date(),
      },
    });
    console.log(`Admin account ready: ${email}`);
  } else {
    console.log("No admin created (set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD to create one).");
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
