// Fechas y horas en America/Lima. Lógica pura (sin Deno, sin red).
// Lima es UTC-5 todo el año (sin horario de verano), así que basta con un desfase fijo:
// es exacto, determinista y no depende de la zona horaria del servidor ni del dispositivo.

export const LIMA_TZ = "America/Lima";
export const LIMA_OFFSET = "-05:00";
const LIMA_OFFSET_MS = -5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const pad = (n: number) => String(n).padStart(2, "0");

export const DIAS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"] as const;
export const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"] as const;

// "AAAA-MM-DD" real del calendario (rechaza 2026-02-31).
export function isDateKey(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

// "HH:MM" en 24 h.
export function isHM(value: unknown): value is string {
  return typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

const utcOf = (key: string) => {
  const [y, m, d] = key.split("-").map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
};

const keyOfUtc = (ms: number) => {
  const t = new Date(ms);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
};

// Fecha y hora de pared en Lima para un instante.
export function limaParts(d: Date): { dateKey: string; hm: string; minutes: number } {
  const t = new Date(d.getTime() + LIMA_OFFSET_MS);
  const hh = t.getUTCHours();
  const mm = t.getUTCMinutes();
  return { dateKey: keyOfUtc(t.getTime()), hm: `${pad(hh)}:${pad(mm)}`, minutes: hh * 60 + mm };
}

export const limaDateKey = (d: Date) => limaParts(d).dateKey;
export const limaHM = (d: Date) => limaParts(d).hm;

export function addDays(key: string, n: number): string {
  return keyOfUtc(utcOf(key) + n * DAY_MS);
}

// 0 = domingo … 6 = sábado
export function weekdayOf(key: string): number {
  return new Date(utcOf(key)).getUTCDay();
}

// "2026-10-05T09:00:00-05:00" para una fecha y hora de pared de Lima.
export function limaDateTime(key: string, hm: string): string {
  return `${key}T${hm}:00${LIMA_OFFSET}`;
}

// Rango [00:00, 00:00 del día siguiente) de `days` días desde `key`, en formato RFC 3339 con desfase
// (Calendar exige el desfase en timeMin/timeMax).
export function limaRange(key: string, days = 1): { timeMin: string; timeMax: string } {
  return { timeMin: limaDateTime(key, "00:00"), timeMax: limaDateTime(addDays(key, Math.max(1, days)), "00:00") };
}

export const limaDayRange = (key: string) => limaRange(key, 1);

// Inicio + minutos → fecha y hora de pared (puede cruzar la medianoche).
export function addMinutes(key: string, hm: string, minutes: number): { dateKey: string; hm: string } {
  const [h, m] = hm.split(":").map(Number) as [number, number];
  const total = utcOf(key) + (h * 60 + m + minutes) * 60_000;
  const t = new Date(total);
  return { dateKey: keyOfUtc(total), hm: `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}` };
}

const strip = (s: string) =>
  s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();

// "16:30", "4:30 pm", "4pm", "16", "16h30", "mediodía" → "HH:MM". null si no se entiende.
export function parseTime(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const s = strip(input).replace(/\./g, "");
  if (s === "mediodia" || s === "medio dia") return "12:00";
  if (s === "medianoche") return "00:00";
  const m = /^(\d{1,2})(?:[:h](\d{2}))?\s*(am|pm)?$/.exec(s);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const ap = m[3];
  if (min > 59) return null;
  if (ap) {
    if (h < 1 || h > 12) return null;
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
  } else if (h > 23) {
    return null;
  }
  return `${pad(h)}:${pad(min)}`;
}

const WEEKDAY_NAMES: Record<string, number> = {
  domingo: 0, lunes: 1, martes: 2, miercoles: 3, jueves: 4, viernes: 5, sabado: 6,
};
const MONTH_NAMES: Record<string, number> = Object.fromEntries(
  MESES.map((name, i) => [strip(name), i + 1]),
);
MONTH_NAMES["setiembre"] = 9;

// Convierte lo que dice David ("hoy", "mañana", "el viernes", "7 de octubre", "2026-10-07") en AAAA-MM-DD de Lima.
// Un día de la semana es el próximo que llegue; si hoy es ese día, es el de la semana siguiente (salvo "este").
export function parseDayRef(input: unknown, now: Date): string | null {
  if (typeof input !== "string") return null;
  const today = limaDateKey(now);
  const raw = input.trim();
  if (isDateKey(raw)) return raw;

  let s = strip(raw);
  const este = /^este /.test(s);
  s = s.replace(/^(el|la|este|esta|proximo|proxima)\s+/, "").replace(/\s+(que viene|proximo|proxima)$/, "");

  if (s === "hoy") return today;
  if (s === "manana") return addDays(today, 1);
  if (s === "pasado manana") return addDays(today, 2);
  if (s === "ayer") return addDays(today, -1);
  if (s === "anteayer" || s === "antes de ayer") return addDays(today, -2);

  const en = /^en (\d{1,3}) dias?$/.exec(s);
  if (en) return addDays(today, Number(en[1]));

  const wd = WEEKDAY_NAMES[s];
  if (wd !== undefined) {
    let delta = (wd - weekdayOf(today) + 7) % 7;
    if (delta === 0 && !este) delta = 7;
    return addDays(today, delta);
  }

  const dm = /^(\d{1,2})(?: de)? ([a-z]+)(?: (?:de )?(\d{4}))?$/.exec(s);
  if (dm) {
    const month = MONTH_NAMES[dm[2] as string];
    if (!month) return null;
    const day = Number(dm[1]);
    const thisYear = Number(today.slice(0, 4));
    const explicitYear = dm[3] ? Number(dm[3]) : null;
    const build = (y: number) => `${y}-${pad(month)}-${pad(day)}`;
    const key = build(explicitYear ?? thisYear);
    if (!isDateKey(key)) return null;
    // Sin año y ya pasó: se entiende el del año siguiente.
    if (explicitYear === null && key < today) {
      const next = build(thisYear + 1);
      return isDateKey(next) ? next : null;
    }
    return key;
  }
  return null;
}
