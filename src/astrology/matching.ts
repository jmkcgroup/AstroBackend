// Ashtakoota Guna Milan (36 points), from the Moon's sidereal sign and nakshatra of each person.
// Tables follow the commonly used North Indian Ashtakoota conventions. Dosha cancellation
// (parihara) rules are NOT applied automatically; the result reports raw koota scores.
import { NAKSHATRAS, SIGNS, type Gana, type PlanetName, type Yoni } from "./constants.js";

export type MoonPlacement = { moonLongitude: number };

type KootaResult = { koota: string; score: number; max: number; detail: string };

const signOf = (lon: number) => Math.floor(lon / 30) + 1;
const nakOf = (lon: number) => Math.floor(lon / (360 / 27)) + 1;

// ── Varna (1) ─────────────────────────────────────────────────
const VARNA_RANK: Record<number, number> = {
  4: 4, 8: 4, 12: 4, // Brahmin: water signs
  1: 3, 5: 3, 9: 3, // Kshatriya: fire signs
  2: 2, 6: 2, 10: 2, // Vaishya: earth signs
  3: 1, 7: 1, 11: 1, // Shudra: air signs
};
const VARNA_NAMES: Record<number, string> = { 4: "Brahmin", 3: "Kshatriya", 2: "Vaishya", 1: "Shudra" };

function varna(boySign: number, girlSign: number): KootaResult {
  const b = VARNA_RANK[boySign]!;
  const g = VARNA_RANK[girlSign]!;
  return {
    koota: "Varna",
    score: b >= g ? 1 : 0,
    max: 1,
    detail: `${VARNA_NAMES[b]} / ${VARNA_NAMES[g]}`,
  };
}

// ── Vashya (2) ────────────────────────────────────────────────
type VashyaGroup = "CHATUSHPADA" | "MANAVA" | "JALACHARA" | "VANACHARA" | "KEETA";

function vashyaGroup(lon: number): VashyaGroup {
  const sign = signOf(lon);
  const firstHalf = lon % 30 < 15;
  switch (sign) {
    case 1:
    case 2:
      return "CHATUSHPADA";
    case 3:
    case 6:
    case 7:
    case 11:
      return "MANAVA";
    case 4:
    case 12:
      return "JALACHARA";
    case 5:
      return "VANACHARA";
    case 8:
      return "KEETA";
    case 9:
      return firstHalf ? "MANAVA" : "CHATUSHPADA";
    case 10:
      return firstHalf ? "CHATUSHPADA" : "JALACHARA";
    default:
      throw new RangeError("invalid sign");
  }
}

// Row = boy, column = girl
const VASHYA_ORDER: VashyaGroup[] = ["CHATUSHPADA", "MANAVA", "JALACHARA", "VANACHARA", "KEETA"];
const VASHYA_TABLE = [
  [2, 1, 1, 0.5, 1],
  [1, 2, 0.5, 0, 1],
  [1, 0.5, 2, 1, 1],
  [0, 0, 1, 2, 0],
  [1, 1, 1, 0, 2],
];

function vashya(boyLon: number, girlLon: number): KootaResult {
  const b = vashyaGroup(boyLon);
  const g = vashyaGroup(girlLon);
  return {
    koota: "Vashya",
    score: VASHYA_TABLE[VASHYA_ORDER.indexOf(b)]![VASHYA_ORDER.indexOf(g)]!,
    max: 2,
    detail: `${b} / ${g}`,
  };
}

// ── Tara (3) ──────────────────────────────────────────────────
function taraAuspicious(fromNak: number, toNak: number): boolean {
  const count = ((toNak - fromNak + 27) % 27) + 1;
  const rem = count % 9;
  return ![3, 5, 7].includes(rem);
}

function tara(boyNak: number, girlNak: number): KootaResult {
  const a = taraAuspicious(girlNak, boyNak);
  const b = taraAuspicious(boyNak, girlNak);
  return {
    koota: "Tara",
    score: (a ? 1.5 : 0) + (b ? 1.5 : 0),
    max: 3,
    detail: `girl to boy ${a ? "auspicious" : "inauspicious"}, boy to girl ${b ? "auspicious" : "inauspicious"}`,
  };
}

// ── Yoni (4) ──────────────────────────────────────────────────
const YONI_ORDER: Yoni[] = [
  "HORSE", "ELEPHANT", "SHEEP", "SERPENT", "DOG", "CAT", "RAT",
  "COW", "BUFFALO", "TIGER", "DEER", "MONKEY", "MONGOOSE", "LION",
];
const YONI_TABLE = [
  [4, 2, 2, 3, 2, 2, 2, 1, 0, 1, 3, 3, 2, 1],
  [2, 4, 3, 3, 2, 2, 2, 2, 3, 1, 2, 3, 2, 0],
  [2, 3, 4, 2, 1, 2, 1, 3, 3, 1, 2, 0, 3, 1],
  [3, 3, 2, 4, 2, 1, 1, 1, 1, 2, 2, 2, 0, 2],
  [2, 2, 1, 2, 4, 2, 1, 2, 2, 1, 0, 2, 1, 1],
  [2, 2, 2, 1, 2, 4, 0, 2, 2, 1, 3, 3, 2, 1],
  [2, 2, 1, 1, 1, 0, 4, 2, 2, 2, 2, 2, 1, 2],
  [1, 2, 3, 1, 2, 2, 2, 4, 3, 0, 3, 2, 2, 1],
  [0, 3, 3, 1, 2, 2, 2, 3, 4, 1, 2, 2, 2, 1],
  [1, 1, 1, 2, 1, 1, 2, 0, 1, 4, 1, 1, 2, 1],
  [3, 2, 2, 2, 0, 3, 2, 3, 2, 1, 4, 2, 2, 1],
  [3, 3, 0, 2, 2, 3, 2, 2, 2, 1, 2, 4, 3, 2],
  [2, 2, 3, 0, 1, 2, 1, 2, 2, 2, 2, 3, 4, 2],
  [1, 0, 1, 2, 1, 1, 2, 1, 1, 1, 1, 2, 2, 4],
];

function yoni(boyNak: number, girlNak: number): KootaResult {
  const b = NAKSHATRAS[boyNak - 1]!.yoni;
  const g = NAKSHATRAS[girlNak - 1]!.yoni;
  return {
    koota: "Yoni",
    score: YONI_TABLE[YONI_ORDER.indexOf(b)]![YONI_ORDER.indexOf(g)]!,
    max: 4,
    detail: `${b} / ${g}`,
  };
}

// ── Graha Maitri (5) ──────────────────────────────────────────
type Relation = "FRIEND" | "NEUTRAL" | "ENEMY";
const FRIENDS: Partial<Record<PlanetName, PlanetName[]>> = {
  SUN: ["MOON", "MARS", "JUPITER"],
  MOON: ["SUN", "MERCURY"],
  MARS: ["SUN", "MOON", "JUPITER"],
  MERCURY: ["SUN", "VENUS"],
  JUPITER: ["SUN", "MOON", "MARS"],
  VENUS: ["MERCURY", "SATURN"],
  SATURN: ["MERCURY", "VENUS"],
};
const ENEMIES: Partial<Record<PlanetName, PlanetName[]>> = {
  SUN: ["VENUS", "SATURN"],
  MOON: [],
  MARS: ["MERCURY"],
  MERCURY: ["MOON"],
  JUPITER: ["MERCURY", "VENUS"],
  VENUS: ["SUN", "MOON"],
  SATURN: ["SUN", "MOON", "MARS"],
};

export function naturalRelation(of: PlanetName, toward: PlanetName): Relation {
  if (FRIENDS[of]?.includes(toward)) return "FRIEND";
  if (ENEMIES[of]?.includes(toward)) return "ENEMY";
  return "NEUTRAL";
}

function grahaMaitri(boySign: number, girlSign: number): KootaResult {
  const bl = SIGNS[boySign - 1]!.lord;
  const gl = SIGNS[girlSign - 1]!.lord;
  let score: number;
  if (bl === gl) {
    score = 5;
  } else {
    const r = [naturalRelation(bl, gl), naturalRelation(gl, bl)].sort().join("+");
    const table: Record<string, number> = {
      "FRIEND+FRIEND": 5,
      "FRIEND+NEUTRAL": 4,
      "NEUTRAL+NEUTRAL": 3,
      "ENEMY+FRIEND": 1,
      "ENEMY+NEUTRAL": 0.5,
      "ENEMY+ENEMY": 0,
    };
    score = table[r]!;
  }
  return { koota: "Graha Maitri", score, max: 5, detail: `${bl} / ${gl}` };
}

// ── Gana (6) ──────────────────────────────────────────────────
const GANA_TABLE: Record<Gana, Record<Gana, number>> = {
  DEVA: { DEVA: 6, MANUSHYA: 6, RAKSHASA: 1 },
  MANUSHYA: { DEVA: 5, MANUSHYA: 6, RAKSHASA: 0 },
  RAKSHASA: { DEVA: 1, MANUSHYA: 0, RAKSHASA: 6 },
};

function gana(boyNak: number, girlNak: number): KootaResult {
  const b = NAKSHATRAS[boyNak - 1]!.gana;
  const g = NAKSHATRAS[girlNak - 1]!.gana;
  return { koota: "Gana", score: GANA_TABLE[b][g], max: 6, detail: `${b} / ${g}` };
}

// ── Bhakoot (7) ───────────────────────────────────────────────
function bhakoot(boySign: number, girlSign: number): KootaResult {
  // Position of each Moon sign counted from the other (inclusive), e.g. 2/12, 5/9, 6/8.
  const boyFromGirl = ((boySign - girlSign + 12) % 12) + 1;
  const girlFromBoy = ((girlSign - boySign + 12) % 12) + 1;
  const inauspicious = [2, 12, 5, 9, 6, 8].includes(boyFromGirl);
  return {
    koota: "Bhakoot",
    score: inauspicious ? 0 : 7,
    max: 7,
    detail: `${boyFromGirl}/${girlFromBoy} sign relationship`,
  };
}

// ── Nadi (8) ──────────────────────────────────────────────────
function nadi(boyNak: number, girlNak: number): KootaResult {
  const b = NAKSHATRAS[boyNak - 1]!.nadi;
  const g = NAKSHATRAS[girlNak - 1]!.nadi;
  return { koota: "Nadi", score: b === g ? 0 : 8, max: 8, detail: `${b} / ${g}` };
}

export function gunaMilan(boy: MoonPlacement, girl: MoonPlacement) {
  const bs = signOf(boy.moonLongitude);
  const gs = signOf(girl.moonLongitude);
  const bn = nakOf(boy.moonLongitude);
  const gn = nakOf(girl.moonLongitude);

  const kootas = [
    varna(bs, gs),
    vashya(boy.moonLongitude, girl.moonLongitude),
    tara(bn, gn),
    yoni(bn, gn),
    grahaMaitri(bs, gs),
    gana(bn, gn),
    bhakoot(bs, gs),
    nadi(bn, gn),
  ];
  const total = kootas.reduce((s, k) => s + k.score, 0);

  return {
    total,
    max: 36,
    kootas,
    boy: { moonSign: bs, nakshatra: bn },
    girl: { moonSign: gs, nakshatra: gn },
    // Traditional guidance bands; presented as indicative, never as a verdict.
    band: total >= 28 ? "VERY_GOOD" : total >= 18 ? "ACCEPTABLE" : "BELOW_TRADITIONAL_THRESHOLD",
    notes: [
      "Dosha cancellation (parihara) rules are not applied automatically.",
      "Guna Milan is one traditional input among many and does not predict the outcome of a relationship.",
    ],
  };
}
