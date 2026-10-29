// Reference data: report catalogue, templates, specializations, FAQs and default settings.
// Contains no people, ratings or reviews. Safe to run repeatedly (upserts).
import type { PrismaClient } from "../generated/prisma/client.js";
import { SETTINGS } from "../lib/settings.js";
import type { ReportSection } from "../reports/generator.js";

type ProductSeed = {
  slug: string;
  title: string;
  description: string;
  contents: string[];
  indicativePriceMinor: number;
  requiresPartnerProfile?: boolean;
  sections: ReportSection[];
};

export const REPORT_PRODUCTS: ProductSeed[] = [
  {
    slug: "complete-natal",
    title: "Complete Natal Report",
    description: "A full reading of your birth chart: D1 and D9 charts, every graha, all twelve houses, dashas and current transits.",
    contents: ["Birth chart summary", "D1 and Navamsha (D9) charts", "Planetary and house tables", "Personality, career, relationship and spiritual themes", "Planetary strengths and challenges", "Full Vimshottari timeline", "Current transits"],
    indicativePriceMinor: 149_900,
    sections: ["summary", "chart_d1", "chart_d9", "planets", "houses", "personality", "career", "relationships", "finance", "spiritual", "strengths", "dasha_current", "dasha_timeline", "transits_now"],
  },
  {
    slug: "career-education",
    title: "Career and Education Report",
    description: "Career, learning and professional themes from the 10th and 5th houses, Mercury, and your current dasha.",
    contents: ["10th house and its lord", "5th house of learning", "Mercury placement", "Planetary strengths", "Current dasha and transits"],
    indicativePriceMinor: 99_900,
    sections: ["summary", "chart_d1", "planets", "career", "strengths", "dasha_current", "transits_now"],
  },
  {
    slug: "marriage-relationship",
    title: "Marriage and Relationship Report",
    description: "Relationship themes from the 7th house, Venus and the Navamsha chart, with your current dasha.",
    contents: ["7th house and its lord", "Venus placement", "Navamsha (D9) chart", "Planetary strengths", "Current dasha"],
    indicativePriceMinor: 99_900,
    sections: ["summary", "chart_d1", "chart_d9", "relationships", "strengths", "dasha_current"],
  },
  {
    slug: "finance-wealth",
    title: "Finance and Wealth Themes Report",
    description: "Traditional wealth themes from the 2nd, 9th and 11th houses. Descriptive only, not financial advice.",
    contents: ["2nd house of resources", "11th house of gains", "9th house of fortune", "Planetary strengths", "Current dasha and transits"],
    indicativePriceMinor: 99_900,
    sections: ["summary", "chart_d1", "finance", "strengths", "dasha_current", "transits_now"],
  },
  {
    slug: "yearly",
    title: "Yearly Astrology Report",
    description: "The next twelve months: sign changes and stations of Jupiter, Saturn, Rahu and Mars from your Moon sign, with your running dasha.",
    contents: ["Current dasha and antardasha", "Current transits", "Dated 12-month transit calendar"],
    indicativePriceMinor: 149_900,
    sections: ["summary", "chart_d1", "dasha_current", "transits_now", "transits_year"],
  },
  {
    slug: "dasha-transit",
    title: "Dasha and Transit Report",
    description: "Your complete Vimshottari timeline with antardashas of the running period, current transits and the year ahead.",
    contents: ["Mahadasha timeline", "Antardashas of the current period", "Current transits", "12-month transit calendar"],
    indicativePriceMinor: 119_900,
    sections: ["summary", "dasha_current", "dasha_timeline", "transits_now", "transits_year"],
  },
  {
    slug: "kundli-compatibility",
    title: "Kundli Compatibility Report",
    description: "Ashtakoota Guna Milan between two birth profiles with each koota explained, plus relationship themes.",
    contents: ["Guna Milan out of 36", "All eight kootas explained", "Relationship themes", "Both birth charts"],
    indicativePriceMinor: 119_900,
    requiresPartnerProfile: true,
    sections: ["summary", "chart_d1", "compatibility", "relationships"],
  },
];

export const SPECIALIZATIONS = [
  ["vedic-astrology", "Vedic Astrology"],
  ["career", "Career"],
  ["marriage", "Marriage"],
  ["relationships", "Relationships"],
  ["finance", "Finance"],
  ["education", "Education"],
  ["kundli-matching", "Kundli Matching"],
  ["muhurta", "Muhurta"],
  ["vastu", "Vastu"],
  ["numerology", "Numerology"],
  ["prashna", "Prashna"],
  ["personal-growth", "Personal Growth"],
] as const;

type Faq = { category: string; question: string; answer: string; language: "EN" | "HI" };

export const FAQS: Faq[] = [
  { category: "kundli", language: "EN", question: "What is a Kundli?", answer: "A Kundli (birth chart) is a map of where the Sun, Moon, planets and lunar nodes were in the sidereal zodiac at the moment and place of your birth, divided into twelve houses from your ascendant (Lagna)." },
  { category: "kundli", language: "EN", question: "Why do I need my exact birth time?", answer: "The ascendant changes sign roughly every two hours, and the Moon moves about 13° a day. An error of even a few minutes can change the Lagna, house placements and dasha dates. If you are unsure, mark the time as approximate when creating your profile." },
  { category: "birth-details", language: "EN", question: "How is my birth time converted to UTC?", answer: "We use the IANA time-zone database, which records historical changes such as India's +06:30 war time between 1942 and 1945, and daylight-saving rules for other countries." },
  { category: "methodology", language: "EN", question: "Which ayanamsha and house system do you use?", answer: "Lahiri (Chitrapaksha) ayanamsha by default, with whole-sign houses. Raman and Krishnamurti ayanamshas are available per birth profile. Positions come from the Swiss Ephemeris." },
  { category: "methodology", language: "EN", question: "Why is my Rashi different from my Western zodiac sign?", answer: "Vedic astrology uses the sidereal zodiac, which is currently about 24° behind the tropical zodiac used in Western astrology. Your Janma Rashi is also based on the Moon, not the Sun." },
  { category: "tools", language: "EN", question: "Are the free tools really free?", answer: "Yes. Kundli generation, matching, Panchang, numerology, Nakshatra and Rashi finders and the transit explorer are free. Free-tool inputs are not stored." },
  { category: "reports", language: "EN", question: "How are premium reports generated?", answer: "Reports are generated from your calculated chart using documented rules. Every statement is linked to a chart factor such as a house lord, dignity, dasha or transit." },
  { category: "reports", language: "EN", question: "Can I buy a report online?", answer: "Yes. Reports are paid securely through Razorpay (UPI, cards, net banking and wallets). As soon as the payment is confirmed you can generate the report from your saved birth profile." },
  { category: "consultations", language: "EN", question: "How does booking a consultation work?", answer: "Choose an astrologer and an available slot, send a request and complete the payment within 30 minutes to hold the slot. The astrologer then confirms it. If the request is declined or cancelled by the astrologer, the full amount is refunded." },
  { category: "payments", language: "EN", question: "What is your refund policy?", answer: "Consultations: a full refund if the astrologer declines or cancels, or if you cancel at least 24 hours before the start. Reports: generated instantly from your data, so they are refundable only if generation fails and we cannot fix it. Refunds reach your account in 5–7 working days." },
  { category: "privacy", language: "EN", question: "Who can see my birth details?", answer: "Only you. Birth profiles are private to your account, never appear in URLs or public pages, and are excluded from logs. You can export or request deletion of your data at any time." },
  { category: "kundli", language: "HI", question: "कुंडली क्या है?", answer: "कुंडली आपके जन्म के समय और स्थान पर सूर्य, चंद्र, ग्रहों और राहु-केतु की निरयन राशि चक्र में स्थिति का नक्शा है, जिसे लग्न से बारह भावों में बाँटा जाता है।" },
  { category: "kundli", language: "HI", question: "सही जन्म समय क्यों ज़रूरी है?", answer: "लग्न लगभग हर दो घंटे में राशि बदलता है और चंद्रमा प्रतिदिन लगभग 13° चलता है। कुछ मिनटों का अंतर भी लग्न, भाव और दशा की तिथियाँ बदल सकता है। समय पक्का न हो तो प्रोफ़ाइल में उसे अनुमानित चिह्नित करें।" },
  { category: "methodology", language: "HI", question: "आप कौन सा अयनांश उपयोग करते हैं?", answer: "डिफ़ॉल्ट रूप से लाहिरी (चित्रपक्ष) अयनांश और पूर्ण राशि भाव पद्धति। ग्रहों की स्थिति स्विस एफ़ेमेरिस से ली जाती है।" },
  { category: "privacy", language: "HI", question: "मेरी जन्म जानकारी कौन देख सकता है?", answer: "केवल आप। जन्म प्रोफ़ाइल आपके खाते तक निजी रहती है और कभी URL या सार्वजनिक पेज पर नहीं दिखती। आप कभी भी अपना डेटा निर्यात कर सकते हैं या हटाने का अनुरोध कर सकते हैं।" },
];

export async function seedCatalogue(prisma: PrismaClient) {
  for (const [i, p] of REPORT_PRODUCTS.entries()) {
    const template = await prisma.reportTemplate.upsert({
      where: { key_version: { key: p.slug, version: 1 } },
      update: { sections: p.sections, name: p.title },
      create: { key: p.slug, version: 1, name: p.title, sections: p.sections },
    });
    await prisma.reportProduct.upsert({
      where: { slug: p.slug },
      update: {},
      create: {
        slug: p.slug,
        title: p.title,
        description: p.description,
        contents: p.contents,
        indicativePriceMinor: p.indicativePriceMinor,
        requiresPartnerProfile: p.requiresPartnerProfile ?? false,
        sortOrder: i,
        templateId: template.id,
      },
    });
  }

  for (const [slug, name] of SPECIALIZATIONS) {
    await prisma.specialization.upsert({ where: { slug }, update: { name }, create: { slug, name } });
  }

  if ((await prisma.faqItem.count()) === 0) {
    await prisma.faqItem.createMany({ data: FAQS.map((f, i) => ({ ...f, sortOrder: i, status: "PUBLISHED" as const })) });
  }

  for (const [key, def] of Object.entries(SETTINGS)) {
    await prisma.adminSetting.upsert({ where: { key }, update: {}, create: { key, value: def.default } });
  }
}
