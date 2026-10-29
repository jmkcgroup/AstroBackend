// Reference tables for Vedic (sidereal) astrology.
// Signs are numbered 1–12 (Aries = 1); nakshatras 1–27 (Ashwini = 1).

export const PLANETS = [
  "SUN",
  "MOON",
  "MARS",
  "MERCURY",
  "JUPITER",
  "VENUS",
  "SATURN",
  "RAHU",
  "KETU",
] as const;
export type PlanetName = (typeof PLANETS)[number];

export const PLANET_LABELS: Record<PlanetName, { en: string; hi: string; abbr: string }> = {
  SUN: { en: "Sun", hi: "सूर्य", abbr: "Su" },
  MOON: { en: "Moon", hi: "चंद्र", abbr: "Mo" },
  MARS: { en: "Mars", hi: "मंगल", abbr: "Ma" },
  MERCURY: { en: "Mercury", hi: "बुध", abbr: "Me" },
  JUPITER: { en: "Jupiter", hi: "गुरु", abbr: "Ju" },
  VENUS: { en: "Venus", hi: "शुक्र", abbr: "Ve" },
  SATURN: { en: "Saturn", hi: "शनि", abbr: "Sa" },
  RAHU: { en: "Rahu", hi: "राहु", abbr: "Ra" },
  KETU: { en: "Ketu", hi: "केतु", abbr: "Ke" },
};

type SignInfo = { en: string; sanskrit: string; hi: string; lord: PlanetName };

export const SIGNS: readonly SignInfo[] = [
  { en: "Aries", sanskrit: "Mesha", hi: "मेष", lord: "MARS" },
  { en: "Taurus", sanskrit: "Vrishabha", hi: "वृषभ", lord: "VENUS" },
  { en: "Gemini", sanskrit: "Mithuna", hi: "मिथुन", lord: "MERCURY" },
  { en: "Cancer", sanskrit: "Karka", hi: "कर्क", lord: "MOON" },
  { en: "Leo", sanskrit: "Simha", hi: "सिंह", lord: "SUN" },
  { en: "Virgo", sanskrit: "Kanya", hi: "कन्या", lord: "MERCURY" },
  { en: "Libra", sanskrit: "Tula", hi: "तुला", lord: "VENUS" },
  { en: "Scorpio", sanskrit: "Vrishchika", hi: "वृश्चिक", lord: "MARS" },
  { en: "Sagittarius", sanskrit: "Dhanu", hi: "धनु", lord: "JUPITER" },
  { en: "Capricorn", sanskrit: "Makara", hi: "मकर", lord: "SATURN" },
  { en: "Aquarius", sanskrit: "Kumbha", hi: "कुंभ", lord: "SATURN" },
  { en: "Pisces", sanskrit: "Meena", hi: "मीन", lord: "JUPITER" },
];

export type Gana = "DEVA" | "MANUSHYA" | "RAKSHASA";
export type Nadi = "ADI" | "MADHYA" | "ANTYA";
export type Yoni =
  | "HORSE"
  | "ELEPHANT"
  | "SHEEP"
  | "SERPENT"
  | "DOG"
  | "CAT"
  | "RAT"
  | "COW"
  | "BUFFALO"
  | "TIGER"
  | "DEER"
  | "MONKEY"
  | "MONGOOSE"
  | "LION";

type NakshatraInfo = {
  en: string;
  hi: string;
  lord: PlanetName;
  gana: Gana;
  yoni: Yoni;
  nadi: Nadi;
};

export const NAKSHATRAS: readonly NakshatraInfo[] = [
  { en: "Ashwini", hi: "अश्विनी", lord: "KETU", gana: "DEVA", yoni: "HORSE", nadi: "ADI" },
  { en: "Bharani", hi: "भरणी", lord: "VENUS", gana: "MANUSHYA", yoni: "ELEPHANT", nadi: "MADHYA" },
  { en: "Krittika", hi: "कृत्तिका", lord: "SUN", gana: "RAKSHASA", yoni: "SHEEP", nadi: "ANTYA" },
  { en: "Rohini", hi: "रोहिणी", lord: "MOON", gana: "MANUSHYA", yoni: "SERPENT", nadi: "ANTYA" },
  { en: "Mrigashira", hi: "मृगशिरा", lord: "MARS", gana: "DEVA", yoni: "SERPENT", nadi: "MADHYA" },
  { en: "Ardra", hi: "आर्द्रा", lord: "RAHU", gana: "MANUSHYA", yoni: "DOG", nadi: "ADI" },
  { en: "Punarvasu", hi: "पुनर्वसु", lord: "JUPITER", gana: "DEVA", yoni: "CAT", nadi: "ADI" },
  { en: "Pushya", hi: "पुष्य", lord: "SATURN", gana: "DEVA", yoni: "SHEEP", nadi: "MADHYA" },
  { en: "Ashlesha", hi: "आश्लेषा", lord: "MERCURY", gana: "RAKSHASA", yoni: "CAT", nadi: "ANTYA" },
  { en: "Magha", hi: "मघा", lord: "KETU", gana: "RAKSHASA", yoni: "RAT", nadi: "ANTYA" },
  { en: "Purva Phalguni", hi: "पूर्व फाल्गुनी", lord: "VENUS", gana: "MANUSHYA", yoni: "RAT", nadi: "MADHYA" },
  { en: "Uttara Phalguni", hi: "उत्तर फाल्गुनी", lord: "SUN", gana: "MANUSHYA", yoni: "COW", nadi: "ADI" },
  { en: "Hasta", hi: "हस्त", lord: "MOON", gana: "DEVA", yoni: "BUFFALO", nadi: "ADI" },
  { en: "Chitra", hi: "चित्रा", lord: "MARS", gana: "RAKSHASA", yoni: "TIGER", nadi: "MADHYA" },
  { en: "Swati", hi: "स्वाति", lord: "RAHU", gana: "DEVA", yoni: "BUFFALO", nadi: "ANTYA" },
  { en: "Vishakha", hi: "विशाखा", lord: "JUPITER", gana: "RAKSHASA", yoni: "TIGER", nadi: "ANTYA" },
  { en: "Anuradha", hi: "अनुराधा", lord: "SATURN", gana: "DEVA", yoni: "DEER", nadi: "MADHYA" },
  { en: "Jyeshtha", hi: "ज्येष्ठा", lord: "MERCURY", gana: "RAKSHASA", yoni: "DEER", nadi: "ADI" },
  { en: "Mula", hi: "मूल", lord: "KETU", gana: "RAKSHASA", yoni: "DOG", nadi: "ADI" },
  { en: "Purva Ashadha", hi: "पूर्वाषाढ़ा", lord: "VENUS", gana: "MANUSHYA", yoni: "MONKEY", nadi: "MADHYA" },
  { en: "Uttara Ashadha", hi: "उत्तराषाढ़ा", lord: "SUN", gana: "MANUSHYA", yoni: "MONGOOSE", nadi: "ANTYA" },
  { en: "Shravana", hi: "श्रवण", lord: "MOON", gana: "DEVA", yoni: "MONKEY", nadi: "ANTYA" },
  { en: "Dhanishta", hi: "धनिष्ठा", lord: "MARS", gana: "RAKSHASA", yoni: "LION", nadi: "MADHYA" },
  { en: "Shatabhisha", hi: "शतभिषा", lord: "RAHU", gana: "RAKSHASA", yoni: "HORSE", nadi: "ADI" },
  { en: "Purva Bhadrapada", hi: "पूर्व भाद्रपद", lord: "JUPITER", gana: "MANUSHYA", yoni: "LION", nadi: "ADI" },
  { en: "Uttara Bhadrapada", hi: "उत्तर भाद्रपद", lord: "SATURN", gana: "MANUSHYA", yoni: "COW", nadi: "MADHYA" },
  { en: "Revati", hi: "रेवती", lord: "MERCURY", gana: "DEVA", yoni: "ELEPHANT", nadi: "ANTYA" },
];

export const NAKSHATRA_SPAN = 360 / 27; // 13°20'
export const PADA_SPAN = NAKSHATRA_SPAN / 4; // 3°20'

// Vimshottari Mahadasha sequence and lengths in years (total 120).
export const VIMSHOTTARI: readonly { planet: PlanetName; years: number }[] = [
  { planet: "KETU", years: 7 },
  { planet: "VENUS", years: 20 },
  { planet: "SUN", years: 6 },
  { planet: "MOON", years: 10 },
  { planet: "MARS", years: 7 },
  { planet: "RAHU", years: 18 },
  { planet: "JUPITER", years: 16 },
  { planet: "SATURN", years: 19 },
  { planet: "MERCURY", years: 17 },
];

// Dignity by sidereal sign (nodes excluded: classical sources disagree).
export const EXALTATION: Partial<Record<PlanetName, number>> = {
  SUN: 1,
  MOON: 2,
  MARS: 10,
  MERCURY: 6,
  JUPITER: 4,
  VENUS: 12,
  SATURN: 7,
};

export const OWN_SIGNS: Partial<Record<PlanetName, number[]>> = {
  SUN: [5],
  MOON: [4],
  MARS: [1, 8],
  MERCURY: [3, 6],
  JUPITER: [9, 12],
  VENUS: [2, 7],
  SATURN: [10, 11],
};

// Graha drishti: houses counted from the planet (inclusive), beyond the universal 7th.
export const SPECIAL_ASPECTS: Partial<Record<PlanetName, number[]>> = {
  MARS: [4, 8],
  JUPITER: [5, 9],
  SATURN: [3, 10],
};

export const WEEKDAYS = [
  { en: "Sunday", sanskrit: "Ravivara", hi: "रविवार", lord: "SUN" },
  { en: "Monday", sanskrit: "Somavara", hi: "सोमवार", lord: "MOON" },
  { en: "Tuesday", sanskrit: "Mangalavara", hi: "मंगलवार", lord: "MARS" },
  { en: "Wednesday", sanskrit: "Budhavara", hi: "बुधवार", lord: "MERCURY" },
  { en: "Thursday", sanskrit: "Guruvara", hi: "गुरुवार", lord: "JUPITER" },
  { en: "Friday", sanskrit: "Shukravara", hi: "शुक्रवार", lord: "VENUS" },
  { en: "Saturday", sanskrit: "Shanivara", hi: "शनिवार", lord: "SATURN" },
] as const;

export const TITHIS = [
  "Pratipada",
  "Dwitiya",
  "Tritiya",
  "Chaturthi",
  "Panchami",
  "Shashthi",
  "Saptami",
  "Ashtami",
  "Navami",
  "Dashami",
  "Ekadashi",
  "Dwadashi",
  "Trayodashi",
  "Chaturdashi",
] as const;

export const YOGAS = [
  "Vishkambha",
  "Priti",
  "Ayushman",
  "Saubhagya",
  "Shobhana",
  "Atiganda",
  "Sukarma",
  "Dhriti",
  "Shula",
  "Ganda",
  "Vriddhi",
  "Dhruva",
  "Vyaghata",
  "Harshana",
  "Vajra",
  "Siddhi",
  "Vyatipata",
  "Variyana",
  "Parigha",
  "Shiva",
  "Siddha",
  "Sadhya",
  "Shubha",
  "Shukla",
  "Brahma",
  "Indra",
  "Vaidhriti",
] as const;

export const MOVABLE_KARANAS = ["Bava", "Balava", "Kaulava", "Taitila", "Gara", "Vanija", "Vishti"] as const;
