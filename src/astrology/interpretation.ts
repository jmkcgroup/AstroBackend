// Rule-based interpretation built only from calculated chart data. Every statement is
// traceable to a factor (house, lord, dignity, dasha, transit) listed alongside it.
// Wording is descriptive and non-deterministic: no guaranteed predictions about health,
// marriage, career or money.
import { PLANET_LABELS, SIGNS, type PlanetName } from "./constants.js";
import type { ChartResult } from "./chart.js";
import type { TransitResult } from "./transit.js";

export type Lang = "EN" | "HI";
type Text = { en: string; hi: string };
export type InterpretationSectionKey =
  | "PERSONALITY"
  | "CAREER_EDUCATION"
  | "RELATIONSHIPS"
  | "SPIRITUAL"
  | "STRENGTHS_CHALLENGES"
  | "DASHA"
  | "TRANSITS";

export type InterpretationBlock = {
  section: InterpretationSectionKey;
  title: string;
  paragraphs: string[];
  factors: string[];
};

const HOUSE_THEMES: Record<number, Text> = {
  1: { en: "self, temperament and physical vitality", hi: "स्वयं, स्वभाव और शारीरिक ऊर्जा" },
  2: { en: "family, speech, values and accumulated resources", hi: "परिवार, वाणी, मूल्य और संचित संसाधन" },
  3: { en: "courage, communication, siblings and initiative", hi: "साहस, संवाद, भाई-बहन और पहल" },
  4: { en: "home, mother, emotional security and property", hi: "घर, माता, भावनात्मक सुरक्षा और संपत्ति" },
  5: { en: "creativity, learning, children and intelligence", hi: "रचनात्मकता, शिक्षा, संतान और बुद्धि" },
  6: { en: "service, routine, competition and overcoming obstacles", hi: "सेवा, दिनचर्या, प्रतिस्पर्धा और बाधाओं पर विजय" },
  7: { en: "partnerships, marriage and public dealings", hi: "साझेदारी, विवाह और सार्वजनिक व्यवहार" },
  8: { en: "transformation, research, shared resources and the hidden", hi: "परिवर्तन, शोध, साझा संसाधन और गूढ़ विषय" },
  9: { en: "dharma, higher learning, teachers and fortune", hi: "धर्म, उच्च शिक्षा, गुरु और भाग्य" },
  10: { en: "career, reputation, authority and public role", hi: "करियर, प्रतिष्ठा, अधिकार और सार्वजनिक भूमिका" },
  11: { en: "gains, networks, aspirations and elder siblings", hi: "लाभ, संपर्क, आकांक्षाएँ और बड़े भाई-बहन" },
  12: { en: "spirituality, solitude, foreign lands and letting go", hi: "आध्यात्मिकता, एकांत, विदेश और त्याग" },
};

const PLANET_THEMES: Record<PlanetName, Text> = {
  SUN: { en: "purpose, confidence and leadership", hi: "उद्देश्य, आत्मविश्वास और नेतृत्व" },
  MOON: { en: "mind, emotions and nurturing", hi: "मन, भावनाएँ और पोषण" },
  MARS: { en: "energy, drive and decisiveness", hi: "ऊर्जा, प्रेरणा और निर्णय क्षमता" },
  MERCURY: { en: "intellect, communication and analysis", hi: "बुद्धि, संवाद और विश्लेषण" },
  JUPITER: { en: "wisdom, guidance and growth", hi: "ज्ञान, मार्गदर्शन और विकास" },
  VENUS: { en: "harmony, relationships and aesthetics", hi: "सामंजस्य, संबंध और सौंदर्य" },
  SATURN: { en: "discipline, patience and responsibility", hi: "अनुशासन, धैर्य और ज़िम्मेदारी" },
  RAHU: { en: "ambition, innovation and unconventional paths", hi: "महत्वाकांक्षा, नवाचार और अलग राहें" },
  KETU: { en: "detachment, insight and inner search", hi: "वैराग्य, अंतर्दृष्टि और आंतरिक खोज" },
};

const SIGN_TRAITS: Record<number, Text> = {
  1: { en: "direct, energetic and pioneering", hi: "स्पष्टवादी, ऊर्जावान और अग्रणी" },
  2: { en: "steady, practical and appreciative of comfort", hi: "स्थिर, व्यावहारिक और सुख-सुविधा प्रिय" },
  3: { en: "curious, communicative and adaptable", hi: "जिज्ञासु, संवादप्रिय और लचीला" },
  4: { en: "caring, intuitive and protective", hi: "देखभाल करने वाला, अंतर्ज्ञानी और रक्षक" },
  5: { en: "warm, expressive and dignified", hi: "स्नेही, अभिव्यक्तिपूर्ण और गरिमामय" },
  6: { en: "precise, analytical and service-minded", hi: "सटीक, विश्लेषणात्मक और सेवाभावी" },
  7: { en: "diplomatic, fair-minded and sociable", hi: "कूटनीतिक, न्यायप्रिय और मिलनसार" },
  8: { en: "intense, perceptive and resilient", hi: "गहन, सूक्ष्मदर्शी और दृढ़" },
  9: { en: "optimistic, principled and freedom-loving", hi: "आशावादी, सिद्धांतवादी और स्वतंत्रता प्रिय" },
  10: { en: "ambitious, disciplined and pragmatic", hi: "महत्वाकांक्षी, अनुशासित और व्यावहारिक" },
  11: { en: "independent, humanitarian and inventive", hi: "स्वतंत्र, मानवतावादी और आविष्कारशील" },
  12: { en: "compassionate, imaginative and spiritual", hi: "करुणामय, कल्पनाशील और आध्यात्मिक" },
};

const t = (x: Text, lang: Lang) => (lang === "HI" ? x.hi : x.en);
const pName = (p: PlanetName, lang: Lang) => (lang === "HI" ? PLANET_LABELS[p].hi : PLANET_LABELS[p].en);
const sName = (s: number, lang: Lang) => (lang === "HI" ? SIGNS[s - 1]!.hi : `${SIGNS[s - 1]!.en} (${SIGNS[s - 1]!.sanskrit})`);
const ord = (n: number, lang: Lang) => (lang === "HI" ? `${n}वें` : `${n}${n === 1 ? "st" : n === 2 ? "nd" : n === 3 ? "rd" : "th"}`);

export function placementSentence(chart: ChartResult, planet: PlanetName, lang: Lang): string {
  const p = chart.planets.find((x) => x.planet === planet)!;
  return lang === "HI"
    ? `${pName(planet, lang)} (${t(PLANET_THEMES[planet], lang)}) ${sName(p.sign, lang)} राशि में ${ord(p.house, lang)} भाव में है, जो ${t(HOUSE_THEMES[p.house]!, lang)} से जुड़ा है।`
    : `${pName(planet, lang)} (${t(PLANET_THEMES[planet], lang)}) sits in ${sName(p.sign, lang)} in the ${ord(p.house, lang)} house, linking it with ${t(HOUSE_THEMES[p.house]!, lang)}.`;
}

export function houseLordSentence(chart: ChartResult, house: number, lang: Lang): { text: string; factor: string } {
  const h = chart.houses[house - 1]!;
  const lordPos = chart.planets.find((p) => p.planet === h.lord)!;
  const text =
    lang === "HI"
      ? `${ord(house, lang)} भाव (${t(HOUSE_THEMES[house]!, lang)}) ${sName(h.sign, lang)} राशि का है; इसका स्वामी ${pName(h.lord, lang)} ${ord(lordPos.house, lang)} भाव में है, जो इन विषयों को ${t(HOUSE_THEMES[lordPos.house]!, lang)} से जोड़ता है।`
      : `The ${ord(house, lang)} house (${t(HOUSE_THEMES[house]!, lang)}) falls in ${sName(h.sign, lang)}; its lord ${pName(h.lord, lang)} occupies the ${ord(lordPos.house, lang)} house, connecting these themes with ${t(HOUSE_THEMES[lordPos.house]!, lang)}.`;
  return { text, factor: `H${house} ${SIGNS[h.sign - 1]!.en}, lord ${h.lord} in H${lordPos.house}` };
}

export function occupantsSentence(chart: ChartResult, house: number, lang: Lang): string | null {
  const occ = chart.d1[house] ?? [];
  if (occ.length === 0) return null;
  const names = occ.map((p) => pName(p, lang)).join(lang === "HI" ? ", " : ", ");
  return lang === "HI"
    ? `इस भाव में ${names} स्थित ${occ.length > 1 ? "हैं" : "है"}, जो इसे विशेष महत्व देते हैं।`
    : `${names} ${occ.length > 1 ? "occupy" : "occupies"} this house, giving it added emphasis.`;
}

export function interpretChart(chart: ChartResult, lang: Lang, transits?: TransitResult, now = new Date()): InterpretationBlock[] {
  const blocks: InterpretationBlock[] = [];
  const L = (en: string, hi: string) => (lang === "HI" ? hi : en);

  // Personality
  {
    const lagna = chart.ascendant.sign;
    const moon = chart.planets.find((p) => p.planet === "MOON")!;
    const lord = houseLordSentence(chart, 1, lang);
    blocks.push({
      section: "PERSONALITY",
      title: L("Personality themes", "व्यक्तित्व"),
      paragraphs: [
        L(
          `With ${sName(lagna, lang)} rising, the chart describes a nature that is traditionally ${t(SIGN_TRAITS[lagna]!, lang)}.`,
          `${sName(lagna, lang)} लग्न होने से परंपरागत रूप से स्वभाव ${t(SIGN_TRAITS[lagna]!, lang)} बताया जाता है।`,
        ),
        lord.text,
        L(
          `The Moon in ${sName(moon.sign, lang)} (Janma Rashi) colours emotional life as ${t(SIGN_TRAITS[moon.sign]!, lang)}.`,
          `चंद्र ${sName(moon.sign, lang)} राशि (जन्म राशि) में होने से भावनात्मक जीवन ${t(SIGN_TRAITS[moon.sign]!, lang)} रहता है।`,
        ),
      ],
      factors: [`Lagna ${SIGNS[lagna - 1]!.en}`, lord.factor, `Moon in ${SIGNS[moon.sign - 1]!.en}`],
    });
  }

  // Career & education
  {
    const tenth = houseLordSentence(chart, 10, lang);
    const fifth = houseLordSentence(chart, 5, lang);
    const paragraphs = [tenth.text];
    const occ10 = occupantsSentence(chart, 10, lang);
    if (occ10) paragraphs.push(occ10);
    paragraphs.push(fifth.text, placementSentence(chart, "MERCURY", lang));
    blocks.push({
      section: "CAREER_EDUCATION",
      title: L("Career and education", "करियर और शिक्षा"),
      paragraphs,
      factors: [tenth.factor, fifth.factor, `Mercury in H${chart.planets.find((p) => p.planet === "MERCURY")!.house}`],
    });
  }

  // Relationships
  {
    const seventh = houseLordSentence(chart, 7, lang);
    const paragraphs = [seventh.text];
    const occ7 = occupantsSentence(chart, 7, lang);
    if (occ7) paragraphs.push(occ7);
    paragraphs.push(placementSentence(chart, "VENUS", lang));
    blocks.push({
      section: "RELATIONSHIPS",
      title: L("Relationships", "संबंध"),
      paragraphs,
      factors: [seventh.factor, `Venus in H${chart.planets.find((p) => p.planet === "VENUS")!.house}`],
    });
  }

  // Spiritual
  {
    const ninth = houseLordSentence(chart, 9, lang);
    blocks.push({
      section: "SPIRITUAL",
      title: L("Traditional spiritual guidance", "आध्यात्मिक मार्गदर्शन"),
      paragraphs: [ninth.text, placementSentence(chart, "JUPITER", lang), placementSentence(chart, "KETU", lang)],
      factors: [ninth.factor, "Jupiter placement", "Ketu placement"],
    });
  }

  // Strengths & challenges from dignity and retrogression
  {
    const paragraphs: string[] = [];
    const factors: string[] = [];
    for (const p of chart.planets) {
      if (p.dignity === "EXALTED") {
        paragraphs.push(L(`${pName(p.planet, lang)} is exalted in ${sName(p.sign, lang)}, traditionally a source of strength for ${t(PLANET_THEMES[p.planet], lang)}.`, `${pName(p.planet, lang)} ${sName(p.sign, lang)} में उच्च का है, जो परंपरागत रूप से ${t(PLANET_THEMES[p.planet], lang)} में बल देता है।`));
        factors.push(`${p.planet} exalted`);
      } else if (p.dignity === "OWN_SIGN") {
        paragraphs.push(L(`${pName(p.planet, lang)} is in its own sign ${sName(p.sign, lang)}, supporting steady expression of ${t(PLANET_THEMES[p.planet], lang)}.`, `${pName(p.planet, lang)} अपनी राशि ${sName(p.sign, lang)} में है, जिससे ${t(PLANET_THEMES[p.planet], lang)} की स्थिर अभिव्यक्ति होती है।`));
        factors.push(`${p.planet} own sign`);
      } else if (p.dignity === "DEBILITATED") {
        paragraphs.push(L(`${pName(p.planet, lang)} is debilitated in ${sName(p.sign, lang)}; tradition suggests conscious effort around ${t(PLANET_THEMES[p.planet], lang)}.`, `${pName(p.planet, lang)} ${sName(p.sign, lang)} में नीच का है; परंपरा के अनुसार ${t(PLANET_THEMES[p.planet], lang)} के क्षेत्र में सजग प्रयास की आवश्यकता होती है।`));
        factors.push(`${p.planet} debilitated`);
      }
      if (p.isRetrograde && p.planet !== "RAHU" && p.planet !== "KETU") {
        paragraphs.push(L(`${pName(p.planet, lang)} was retrograde at birth, often read as an inward, reflective expression of its themes.`, `जन्म के समय ${pName(p.planet, lang)} वक्री था, जिसे इसके विषयों की आंतरिक और चिंतनशील अभिव्यक्ति माना जाता है।`));
        factors.push(`${p.planet} retrograde`);
      }
    }
    if (paragraphs.length === 0) {
      paragraphs.push(L("No graha is exalted, debilitated or in its own sign; planetary strengths are evenly distributed.", "कोई ग्रह उच्च, नीच या स्वराशि में नहीं है; ग्रहों का बल संतुलित रूप से बँटा है।"));
    }
    blocks.push({ section: "STRENGTHS_CHALLENGES", title: L("Planetary strengths and challenges", "ग्रहों का बल और चुनौतियाँ"), paragraphs, factors });
  }

  // Current dasha
  {
    const maha = chart.dashas.find((d) => d.level === "MAHADASHA" && d.startsAt <= now && d.endsAt > now);
    const antar = chart.dashas.find((d) => d.level === "ANTARDASHA" && d.startsAt <= now && d.endsAt > now);
    const paragraphs: string[] = [];
    const factors: string[] = [];
    if (maha) {
      const pos = chart.planets.find((p) => p.planet === maha.planet)!;
      paragraphs.push(
        L(
          `The ${pName(maha.planet, lang)} Mahadasha runs until ${maha.endsAt.toISOString().slice(0, 10)}. ${pName(maha.planet, lang)} rules ${t(PLANET_THEMES[maha.planet], lang)} and sits in the ${ord(pos.house, lang)} house, so this period tends to highlight ${t(HOUSE_THEMES[pos.house]!, lang)}.`,
          `${pName(maha.planet, lang)} की महादशा ${maha.endsAt.toISOString().slice(0, 10)} तक है। ${pName(maha.planet, lang)} ${t(PLANET_THEMES[maha.planet], lang)} का कारक है और ${ord(pos.house, lang)} भाव में है, इसलिए यह अवधि ${t(HOUSE_THEMES[pos.house]!, lang)} को उभारती है।`,
        ),
      );
      factors.push(`Mahadasha ${maha.planet} (H${pos.house})`);
    }
    if (antar) {
      const pos = chart.planets.find((p) => p.planet === antar.planet)!;
      paragraphs.push(
        L(
          `Within it, the ${pName(antar.planet, lang)} Antardasha (until ${antar.endsAt.toISOString().slice(0, 10)}) adds themes of ${t(PLANET_THEMES[antar.planet], lang)} through the ${ord(pos.house, lang)} house.`,
          `इसके भीतर ${pName(antar.planet, lang)} की अंतर्दशा (${antar.endsAt.toISOString().slice(0, 10)} तक) ${ord(pos.house, lang)} भाव के माध्यम से ${t(PLANET_THEMES[antar.planet], lang)} के विषय जोड़ती है।`,
        ),
      );
      factors.push(`Antardasha ${antar.planet} (H${pos.house})`);
    }
    if (paragraphs.length === 0) paragraphs.push(L("The current date is outside the calculated dasha cycle.", "वर्तमान तिथि गणना की गई दशा अवधि से बाहर है।"));
    blocks.push({ section: "DASHA", title: L("Dasha period", "दशा"), paragraphs, factors });
  }

  // Transits relative to the natal Moon
  if (transits) {
    const paragraphs: string[] = [];
    const factors: string[] = [];
    const jup = transits.positions.find((p) => p.planet === "JUPITER")!;
    const sat = transits.positions.find((p) => p.planet === "SATURN")!;
    paragraphs.push(
      L(
        `Transiting Jupiter is in ${sName(jup.sign, lang)}, the ${ord(jup.houseFromMoon!, lang)} from your Moon, traditionally emphasising ${t(HOUSE_THEMES[jup.houseFromMoon!]!, lang)}.`,
        `गोचर में गुरु ${sName(jup.sign, lang)} में है, जो आपकी चंद्र राशि से ${ord(jup.houseFromMoon!, lang)} भाव है और परंपरागत रूप से ${t(HOUSE_THEMES[jup.houseFromMoon!]!, lang)} पर ज़ोर देता है।`,
      ),
      L(
        `Transiting Saturn is in ${sName(sat.sign, lang)}, the ${ord(sat.houseFromMoon!, lang)} from your Moon, asking for patience around ${t(HOUSE_THEMES[sat.houseFromMoon!]!, lang)}.`,
        `गोचर में शनि ${sName(sat.sign, lang)} में है, जो आपकी चंद्र राशि से ${ord(sat.houseFromMoon!, lang)} भाव है और ${t(HOUSE_THEMES[sat.houseFromMoon!]!, lang)} में धैर्य की माँग करता है।`,
      ),
    );
    factors.push(`Jupiter transit H${jup.houseFromMoon} from Moon`, `Saturn transit H${sat.houseFromMoon} from Moon`);
    if (transits.sadeSati?.active) {
      const phase = transits.sadeSati.phase!;
      paragraphs.push(
        L(
          `Saturn's Sade Sati is active (${phase.toLowerCase()} phase). Traditionally this is a period for steady effort and simplification rather than a cause for fear.`,
          `शनि की साढ़ेसाती चल रही है (${phase === "RISING" ? "प्रथम" : phase === "PEAK" ? "मध्य" : "अंतिम"} चरण)। परंपरा के अनुसार यह भय का नहीं, बल्कि निरंतर प्रयास और सरलता का समय है।`,
        ),
      );
      factors.push(`Sade Sati ${phase}`);
    }
    blocks.push({ section: "TRANSITS", title: L("Current transit themes", "वर्तमान गोचर"), paragraphs, factors });
  }

  return blocks;
}

export const INTERPRETATION_DISCLAIMER: Text = {
  en: "These interpretations are generated by rules from your calculated chart. They describe traditional themes and are not guarantees about health, relationships, career or finances.",
  hi: "ये व्याख्याएँ आपकी गणना की गई कुंडली से नियमों के आधार पर बनाई गई हैं। ये परंपरागत विषयों का वर्णन करती हैं और स्वास्थ्य, संबंध, करियर या धन के बारे में कोई गारंटी नहीं हैं।",
};
