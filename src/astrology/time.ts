// Local wall-clock time ↔ UTC using the IANA tz database bundled with Node's ICU.
// Historical offsets are honoured (e.g. India used +06:30 war time in 1942–45).

export type LocalDateTime = {
  year: number;
  month: number; // 1–12
  day: number;
  hour: number;
  minute: number;
  second: number;
};

export type UtcResolution = {
  utc: Date;
  offsetMinutes: number;
  // "gap": the local time was skipped by a DST jump; "fold": it occurred twice.
  ambiguity: "none" | "gap" | "fold";
};

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string) {
  let f = formatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      era: "short",
    });
    formatterCache.set(timeZone, f);
  }
  return f;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock fields of a UTC instant in the given zone. */
export function toZonedParts(utcMs: number, timeZone: string): LocalDateTime {
  const parts = formatterFor(timeZone).formatToParts(new Date(utcMs));
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value);
  const era = parts.find((p) => p.type === "era")?.value;
  const year = era === "BC" ? 1 - get("year") : get("year");
  return {
    year,
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

function fieldsToMs(f: LocalDateTime): number {
  const d = new Date(0);
  d.setUTCFullYear(f.year, f.month - 1, f.day);
  d.setUTCHours(f.hour, f.minute, f.second, 0);
  return d.getTime();
}

/** UTC offset (ms) of the zone at a UTC instant. Second precision (covers LMT offsets). */
export function offsetAt(utcMs: number, timeZone: string): number {
  const wall = fieldsToMs(toZonedParts(utcMs, timeZone));
  return wall - Math.floor(utcMs / 1000) * 1000;
}

export function localToUtc(local: LocalDateTime, timeZone: string): UtcResolution {
  if (!isValidTimeZone(timeZone)) throw new RangeError(`Unknown time zone: ${timeZone}`);

  const wallMs = fieldsToMs(local);
  const DAY = 86_400_000;
  const offsets = new Set([offsetAt(wallMs - DAY, timeZone), offsetAt(wallMs + DAY, timeZone)]);

  const valid = [...offsets]
    .map((off) => wallMs - off)
    .filter((utc) => utc + offsetAt(utc, timeZone) === wallMs)
    .sort((a, b) => a - b);

  if (valid.length === 0) {
    // Nonexistent local time (spring-forward gap): interpret with the pre-transition offset.
    const off = offsetAt(wallMs - DAY, timeZone);
    return { utc: new Date(wallMs - off), offsetMinutes: off / 60_000, ambiguity: "gap" };
  }

  const utc = valid[0]!;
  return {
    utc: new Date(utc),
    offsetMinutes: offsetAt(utc, timeZone) / 60_000,
    ambiguity: valid.length > 1 ? "fold" : "none",
  };
}

export function parseDateString(date: string): { year: number; month: number; day: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new RangeError(`Invalid date "${date}", expected YYYY-MM-DD`);
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    throw new RangeError(`Invalid calendar date "${date}"`);
  }
  return { year, month, day };
}

export function parseTimeString(time: string): { hour: number; minute: number; second: number } {
  const m = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/.exec(time);
  if (!m) throw new RangeError(`Invalid time "${time}", expected HH:mm or HH:mm:ss`);
  return { hour: Number(m[1]), minute: Number(m[2]), second: Number(m[3] ?? 0) };
}

/** Julian Day (UT) for a JS Date, Gregorian calendar. */
export function dateToJulianDay(date: Date): number {
  return date.getTime() / 86_400_000 + 2_440_587.5;
}

export function julianDayToDate(jd: number): Date {
  return new Date(Math.round((jd - 2_440_587.5) * 86_400_000));
}
