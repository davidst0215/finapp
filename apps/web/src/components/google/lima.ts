// Fechas y horas de Lima para las pantallas de agenda y correo.
// Intl con zona fija: se ve igual aunque el celular esté en otra zona horaria.

const TZ = 'America/Lima';

export const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'] as const;
export const DIAS_CORTOS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'] as const;
export const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'] as const;
const MESES_CORTOS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'] as const;

const keyFormat = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const hmFormat = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

const pad = (n: number) => String(n).padStart(2, '0');

/** "AAAA-MM-DD" del día de Lima en ese instante. */
export const limaDateKey = (d: Date = new Date()): string => keyFormat.format(d);

/** "HH:MM" (24 h) de la hora de Lima en ese instante. */
export const limaHM = (d: Date = new Date()): string => hmFormat.format(d);

const parseKey = (key: string): [number, number, number] => {
  const [y = 1970, m = 1, d = 1] = key.split('-').map(Number);
  return [y, m, d];
};

export function addDays(key: string, n: number): string {
  const [y, m, d] = parseKey(key);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** 0 = domingo … 6 = sábado */
export function weekdayOf(key: string): number {
  const [y, m, d] = parseKey(key);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** `count` días consecutivos desde `from`. */
export const dayKeys = (from: string, count: number): string[] => Array.from({ length: count }, (_, i) => addDays(from, i));

export const chipLabel = (key: string): string => `${DIAS_CORTOS[weekdayOf(key)]} ${parseKey(key)[2]}`;

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "Lunes 5 de octubre"; con el año solo si no es el actual. */
export function dayHeading(key: string, todayKey: string): string {
  const [y, m, d] = parseKey(key);
  const year = y === parseKey(todayKey)[0] ? '' : ` de ${y}`;
  return `${cap(DIAS[weekdayOf(key)] ?? '')} ${d} de ${MESES[m - 1]}${year}`;
}

/** "9:00" en vez de "09:00". */
export const shortHM = (hm: string): string => (hm.startsWith('0') ? hm.slice(1) : hm);

/** Minutos desde medianoche de un "HH:MM". */
export const minutesOf = (hm: string): number => {
  const [h = 0, m = 0] = hm.split(':').map(Number);
  return h * 60 + m;
};

/** "hoy 13:12", "ayer 22:14", "lun 5 oct". */
export function whenLabel(iso: string, now: Date = new Date()): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return '';
  const today = limaDateKey(now);
  const key = limaDateKey(t);
  if (key === today) return `hoy ${limaHM(t)}`;
  if (key === addDays(today, -1)) return `ayer ${limaHM(t)}`;
  const [, m, d] = parseKey(key);
  return `${(DIAS_CORTOS[weekdayOf(key)] ?? '').toLowerCase()} ${d} ${MESES_CORTOS[m - 1]}`;
}

/** Duración legible: "30 min", "1 h", "1 h 30". */
export function durationLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} h` : `${h} h ${m}`;
}
