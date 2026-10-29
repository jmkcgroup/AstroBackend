import { prisma } from "./prisma.js";

// Admin-editable numeric settings with their defaults.
export const SETTINGS = {
  "consultation.defaultCommissionBps": { default: 2000, min: 0, max: 10_000, label: "Default platform commission (basis points, 2000 = 20%)" },
  "consultation.refundCutoffHours": { default: 24, min: 0, max: 720, label: "Full refund when the user cancels at least this many hours before the start" },
  "consultation.unpaidHoldMinutes": { default: 30, min: 5, max: 1440, label: "Minutes an unpaid booking holds its slot before it is released" },
} as const;

export type SettingKey = keyof typeof SETTINGS;

export async function getNumberSetting(key: SettingKey): Promise<number> {
  const row = await prisma.adminSetting.findUnique({ where: { key } });
  return typeof row?.value === "number" ? row.value : SETTINGS[key].default;
}

export async function listSettings() {
  const rows = await prisma.adminSetting.findMany({ where: { key: { in: Object.keys(SETTINGS) } } });
  const stored = new Map(rows.map((r) => [r.key, r.value]));
  return (Object.keys(SETTINGS) as SettingKey[]).map((key) => ({
    key,
    ...SETTINGS[key],
    value: typeof stored.get(key) === "number" ? (stored.get(key) as number) : SETTINGS[key].default,
  }));
}
