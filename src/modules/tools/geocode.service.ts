// Birthplace lookup via OpenStreetMap Nominatim (external service) and offline timezone
// resolution from coordinates. Nominatim's usage policy allows max 1 request/second with an
// identifying User-Agent, so requests are serialised and cached in memory.
import tzLookup from "@photostructure/tz-lookup";
import { env } from "../../config/env.js";
import { serviceUnavailable } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";

export type Place = { name: string; latitude: number; longitude: number; timezone: string | null };

const cache = new Map<string, { at: number; places: Place[] }>();
const CACHE_MS = 24 * 60 * 60 * 1000;
let queue: Promise<unknown> = Promise.resolve();
let lastCall = 0;

export function timezoneFor(latitude: number, longitude: number): string | null {
  try {
    return tzLookup(latitude, longitude);
  } catch {
    return null;
  }
}

async function throttled<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const wait = Math.max(0, lastCall + 1100 - Date.now());
    if (wait) await new Promise((r) => setTimeout(r, wait));
    lastCall = Date.now();
    return fn();
  });
  queue = run.catch(() => undefined);
  return run;
}

export async function searchPlaces(query: string, language: "en" | "hi" = "en"): Promise<Place[]> {
  const key = `${language}:${query.trim().toLowerCase()}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.places;

  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.search = new URLSearchParams({
    q: query,
    format: "jsonv2",
    limit: "6",
    addressdetails: "0",
    "accept-language": language,
  }).toString();

  let data: { display_name: string; lat: string; lon: string }[];
  try {
    data = await throttled(async () => {
      const res = await fetch(url, {
        headers: { "User-Agent": `AstroVeda/1.0 (+${env.FRONTEND_URL})` },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`Nominatim responded ${res.status}`);
      return (await res.json()) as typeof data;
    });
  } catch (err) {
    logger.warn({ err }, "Place search failed");
    throw serviceUnavailable("Place search is temporarily unavailable. You can enter coordinates manually.");
  }

  const places = data.map((d) => {
    const latitude = Number(d.lat);
    const longitude = Number(d.lon);
    return { name: d.display_name, latitude, longitude, timezone: timezoneFor(latitude, longitude) };
  });
  cache.set(key, { at: Date.now(), places });
  return places;
}
