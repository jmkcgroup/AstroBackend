// Vedic / Chaldean numerology.
// - Moolank (root/psychic number): digit sum of the day of birth, reduced to 1–9.
// - Bhagyank (destiny/life-path number): digit sum of the full date DD+MM+YYYY, reduced to 1–9.
// - Namank (name number): Chaldean letter values summed and reduced to 1–9 (letters only).
// Each number is associated with a ruling graha in the Indian tradition.
import { parseDateString } from "./time.js";
import type { PlanetName } from "./constants.js";

export const reduceToDigit = (n: number): number => {
  let x = Math.abs(n);
  while (x > 9) x = String(x).split("").reduce((s, d) => s + Number(d), 0);
  return x;
};

const CHALDEAN: Record<string, number> = {
  A: 1, I: 1, J: 1, Q: 1, Y: 1,
  B: 2, K: 2, R: 2,
  C: 3, G: 3, L: 3, S: 3,
  D: 4, M: 4, T: 4,
  E: 5, H: 5, N: 5, X: 5,
  U: 6, V: 6, W: 6,
  O: 7, Z: 7,
  F: 8, P: 8,
};

export const NUMBER_RULERS: Record<number, PlanetName> = {
  1: "SUN",
  2: "MOON",
  3: "JUPITER",
  4: "RAHU",
  5: "MERCURY",
  6: "VENUS",
  7: "KETU",
  8: "SATURN",
  9: "MARS",
};

// Traditional associations; descriptive themes, not predictions.
export const NUMBER_THEMES: Record<number, { en: string; hi: string }> = {
  1: { en: "Leadership, independence and initiative.", hi: "नेतृत्व, स्वतंत्रता और पहल।" },
  2: { en: "Sensitivity, cooperation and imagination.", hi: "संवेदनशीलता, सहयोग और कल्पनाशीलता।" },
  3: { en: "Wisdom, teaching and optimism.", hi: "ज्ञान, शिक्षण और आशावाद।" },
  4: { en: "Unconventional thinking, discipline and hard work.", hi: "अलग सोच, अनुशासन और परिश्रम।" },
  5: { en: "Communication, adaptability and curiosity.", hi: "संवाद, अनुकूलन क्षमता और जिज्ञासा।" },
  6: { en: "Harmony, beauty, care and responsibility.", hi: "सामंजस्य, सौंदर्य, देखभाल और ज़िम्मेदारी।" },
  7: { en: "Introspection, spirituality and research.", hi: "आत्मचिंतन, आध्यात्मिकता और शोध।" },
  8: { en: "Patience, perseverance and structure.", hi: "धैर्य, दृढ़ता और व्यवस्था।" },
  9: { en: "Energy, courage and compassion.", hi: "ऊर्जा, साहस और करुणा।" },
};

const digitSum = (s: string) => s.replace(/\D/g, "").split("").reduce((a, d) => a + Number(d), 0);

export function calculateNumerology(input: { dateOfBirth: string; name?: string }) {
  const { year, month, day } = parseDateString(input.dateOfBirth);

  const moolank = reduceToDigit(day);
  const bhagyankRaw = digitSum(`${day}${month}${year}`);
  const bhagyank = reduceToDigit(bhagyankRaw);

  let namank: { value: number; compound: number; ruler: PlanetName; theme: { en: string; hi: string } } | null = null;
  if (input.name) {
    const letters = input.name.toUpperCase().replace(/[^A-Z]/g, "");
    if (letters.length > 0) {
      const compound = letters.split("").reduce((s, ch) => s + CHALDEAN[ch]!, 0);
      const value = reduceToDigit(compound);
      namank = { value, compound, ruler: NUMBER_RULERS[value]!, theme: NUMBER_THEMES[value]! };
    }
  }

  const describe = (v: number) => ({ value: v, ruler: NUMBER_RULERS[v]!, theme: NUMBER_THEMES[v]! });

  return {
    moolank: describe(moolank),
    bhagyank: { ...describe(bhagyank), compound: bhagyankRaw },
    namank,
    method: {
      moolank: "Sum of the digits of the birth day, reduced to a single digit",
      bhagyank: "Sum of all digits of the full birth date (DD MM YYYY), reduced to a single digit",
      namank: "Chaldean letter values (no letter has value 9), summed and reduced",
    },
  };
}
