// Thin adapter around the Swiss Ephemeris (sweph). All astronomy goes through here.
// The engine refuses to silently fall back to the lower-precision Moshier theory:
// if the .se1 data files are missing, calculations fail with EphemerisUnavailableError.
import { existsSync } from "node:fs";
import path from "node:path";
import sweph from "sweph";
import type { PlanetName } from "./constants.js";

const c = sweph.constants;

export const ENGINE_VERSION = "astroveda-engine/1.0.0";
export const SUPPORTED_YEARS = { min: 1800, max: 2399 } as const;
const REQUIRED_FILES = ["sepl_18.se1", "semo_18.se1", "seas_18.se1"];

export class EphemerisUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EphemerisUnavailableError";
  }
}

export type AyanamshaName = "LAHIRI" | "RAMAN" | "KRISHNAMURTI";
export type NodeTypeName = "TRUE_NODE" | "MEAN_NODE";

const SID_MODES: Record<AyanamshaName, number> = {
  LAHIRI: c.SE_SIDM_LAHIRI,
  RAMAN: c.SE_SIDM_RAMAN,
  KRISHNAMURTI: c.SE_SIDM_KRISHNAMURTI,
};

const BODY_IDS: Record<Exclude<PlanetName, "RAHU" | "KETU">, number> = {
  SUN: c.SE_SUN,
  MOON: c.SE_MOON,
  MARS: c.SE_MARS,
  MERCURY: c.SE_MERCURY,
  JUPITER: c.SE_JUPITER,
  VENUS: c.SE_VENUS,
  SATURN: c.SE_SATURN,
};

let ephePath: string | null = null;

export function initEphemeris(dir: string | undefined): { ok: boolean; path: string | null; missing: string[] } {
  const resolved = dir ? path.resolve(dir) : null;
  const missing = resolved ? REQUIRED_FILES.filter((f) => !existsSync(path.join(resolved, f))) : REQUIRED_FILES;
  if (resolved && missing.length === 0) {
    sweph.set_ephe_path(resolved);
    ephePath = resolved;
  } else {
    ephePath = null;
  }
  return { ok: ephePath !== null, path: ephePath, missing };
}

export function ephemerisStatus() {
  return {
    available: ephePath !== null,
    source: ephePath ? `Swiss Ephemeris ${sweph.version()} (.se1 files)` : null,
    engineVersion: ENGINE_VERSION,
    supportedYears: SUPPORTED_YEARS,
  };
}

function assertReady() {
  if (!ephePath) {
    throw new EphemerisUnavailableError(
      "Astrology engine is not configured: Swiss Ephemeris data files were not found (set SWISSEPH_EPHE_PATH).",
    );
  }
}

export function ephemerisSource(): string {
  assertReady();
  return `Swiss Ephemeris ${sweph.version()}`;
}

export function assertSupportedDate(date: Date) {
  const y = date.getUTCFullYear();
  if (y < SUPPORTED_YEARS.min || y > SUPPORTED_YEARS.max) {
    throw new RangeError(`Dates must be between ${SUPPORTED_YEARS.min} and ${SUPPORTED_YEARS.max}.`);
  }
}

export type BodyPosition = { longitude: number; latitude: number; speed: number };

const norm360 = (x: number) => ((x % 360) + 360) % 360;

export function siderealPositions(
  jdUt: number,
  ayanamsha: AyanamshaName,
  nodeType: NodeTypeName,
): { ayanamshaValue: number; bodies: Record<PlanetName, BodyPosition> } {
  assertReady();
  sweph.set_sid_mode(SID_MODES[ayanamsha], 0, 0);
  const flags = c.SEFLG_SWIEPH | c.SEFLG_SIDEREAL | c.SEFLG_SPEED;

  const calc = (id: number): BodyPosition => {
    const r = sweph.calc_ut(jdUt, id, flags);
    if (r.flag < 0) throw new EphemerisUnavailableError(`Ephemeris calculation failed: ${r.error}`);
    if ((r.flag & c.SEFLG_SWIEPH) === 0) {
      throw new EphemerisUnavailableError(`Swiss Ephemeris data unavailable for this date: ${r.error}`);
    }
    const [lon, lat, , speed] = r.data;
    return { longitude: norm360(lon!), latitude: lat!, speed: speed! };
  };

  const bodies = {} as Record<PlanetName, BodyPosition>;
  for (const [name, id] of Object.entries(BODY_IDS) as [keyof typeof BODY_IDS, number][]) {
    bodies[name] = calc(id);
  }
  const rahu = calc(nodeType === "TRUE_NODE" ? c.SE_TRUE_NODE : c.SE_MEAN_NODE);
  bodies.RAHU = rahu;
  bodies.KETU = { longitude: norm360(rahu.longitude + 180), latitude: -rahu.latitude, speed: rahu.speed };

  const ay = sweph.get_ayanamsa_ex_ut(jdUt, c.SEFLG_SWIEPH);
  if (ay.flag < 0) throw new EphemerisUnavailableError(`Ayanamsha calculation failed: ${ay.error}`);

  return { ayanamshaValue: ay.data, bodies };
}

/** Sidereal ascendant (Lagna) for a geographic location. East longitude positive. */
export function siderealAscendant(jdUt: number, latitude: number, longitude: number, ayanamsha: AyanamshaName): number {
  assertReady();
  sweph.set_sid_mode(SID_MODES[ayanamsha], 0, 0);
  const h = sweph.houses_ex2(jdUt, c.SEFLG_SIDEREAL, latitude, longitude, "W");
  if (h.flag < 0) throw new EphemerisUnavailableError(`House calculation failed: ${h.error}`);
  return norm360(h.data.points[0]!);
}

/** Next sunrise or sunset after jdUt (upper limb, standard refraction). Null in polar day/night. */
export function nextSunEvent(
  jdUt: number,
  kind: "rise" | "set",
  latitude: number,
  longitude: number,
): number | null {
  assertReady();
  const rsmi = kind === "rise" ? c.SE_CALC_RISE : c.SE_CALC_SET;
  const r = sweph.rise_trans(jdUt, c.SE_SUN, null, c.SEFLG_SWIEPH, rsmi, [longitude, latitude, 0], 1013.25, 15);
  if (r.flag === -2) return null; // circumpolar
  if (r.flag < 0) throw new EphemerisUnavailableError(`Sunrise calculation failed: ${r.error}`);
  return r.data;
}

/** Tropical (Western) longitude, used only to contrast with the sidereal Rashi. */
export function tropicalLongitude(jdUt: number, body: keyof typeof BODY_IDS): number {
  assertReady();
  const r = sweph.calc_ut(jdUt, BODY_IDS[body], c.SEFLG_SWIEPH);
  if (r.flag < 0 || (r.flag & c.SEFLG_SWIEPH) === 0) {
    throw new EphemerisUnavailableError(`Ephemeris calculation failed: ${r.error}`);
  }
  return norm360(r.data[0]!);
}

/** Sidereal longitude of a single body (used by boundary searches in Panchang/transits). */
export function siderealLongitude(jdUt: number, body: keyof typeof BODY_IDS, ayanamsha: AyanamshaName): number {
  assertReady();
  sweph.set_sid_mode(SID_MODES[ayanamsha], 0, 0);
  const r = sweph.calc_ut(jdUt, BODY_IDS[body], c.SEFLG_SWIEPH | c.SEFLG_SIDEREAL);
  if (r.flag < 0 || (r.flag & c.SEFLG_SWIEPH) === 0) {
    throw new EphemerisUnavailableError(`Ephemeris calculation failed: ${r.error}`);
  }
  return norm360(r.data[0]!);
}
