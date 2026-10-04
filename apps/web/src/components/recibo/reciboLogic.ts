// Lógica pura del módulo recibo: sin DOM, sin React, sin Supabase.
// Corre igual en el navegador y en Node (`node --experimental-strip-types --test reciboLogic.test.ts`),
// por eso: imports con extensión .ts, `import type` para tipos y nada de enums ni namespaces.

// ───────────────────────── Imagen ─────────────────────────

/** Lado mayor máximo de la foto que se envía al lector. */
export const MAX_SIDE = 1600;
/** Calidad JPEG de la foto reducida. */
export const JPEG_QUALITY = 0.8;

/**
 * Dimensiones de la foto reducida: el lado mayor no pasa de `maxSide`, se conserva la proporción
 * y nunca se amplía. Devuelve null si las medidas no son números positivos.
 */
export function fitWithin(
  width: number,
  height: number,
  maxSide: number = MAX_SIDE,
): { width: number; height: number } | null {
  if (![width, height, maxSide].every((n) => Number.isFinite(n) && n > 0)) return null;
  const longest = Math.max(width, height);
  if (longest <= maxSide) return { width: Math.round(width), height: Math.round(height) };
  const scale = maxSide / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

// ───────────────────────── Montos ─────────────────────────

export type Currency = 'PEN' | 'USD';

/** Tope de cordura: S/ 9,999,999.99. Atrapa un RUC o un DNI leído como total. */
export const MAX_AMOUNT_CENTS = 999999999;

const MONEY_SYMBOL: Record<Currency, string> = { PEN: 'S/', USD: 'US$' };

export const currencySymbol = (currency: Currency): string => MONEY_SYMBOL[currency];

/** Grupos de miles bien formados: "1,234,567" (primer grupo de 1 a 3 cifras, el resto de 3). */
function isGrouped(value: string, separator: string): boolean {
  const groups = value.split(separator);
  return groups.every((g, i) => (i === 0 ? /^\d{1,3}$/.test(g) : /^\d{3}$/.test(g)));
}

/**
 * Texto de monto -> centavos enteros, o null si no se puede leer sin adivinar.
 * Acepta "86.40", "86,40", "S/ 86.40", "1,234.50", "1.234,50", "1 234,50" y "86".
 * Rechaza más de 2 decimales, signos y el ambiguo "1.234" (punto + 3 cifras).
 * Con `strict` (salida del modelo) también es ambiguo "86,405" / "12,500" (coma + 3 cifras): null.
 * Puede devolver 0 ("0.00"): decidir si eso vale es cosa de quien llama.
 */
export function parseAmountToCents(input: unknown, opts: { strict?: boolean } = {}): number | null {
  if (typeof input !== 'string') return null;
  const s = input
    .replace(/[\s  ]/g, '')
    .replace(/^(?:s\/\.?|us\$|usd|pen|\$)/i, '')
    .replace(/(?:soles?|usd|pen)$/i, '');
  if (!/^[\d.,]+$/.test(s) || !/\d/.test(s)) return null;

  const dots = (s.match(/\./g) ?? []).length;
  const commas = (s.match(/,/g) ?? []).length;
  let whole: string;
  let frac = '';

  if (dots === 0 && commas === 0) {
    whole = s;
  } else if (dots > 0 && commas > 0) {
    // Mixto: el último separador marca los decimales y el otro agrupa miles.
    const at = Math.max(s.lastIndexOf('.'), s.lastIndexOf(','));
    const decimalSep = s.charAt(at);
    const thousandsSep = decimalSep === '.' ? ',' : '.';
    const left = s.slice(0, at);
    frac = s.slice(at + 1);
    if (left.includes(decimalSep) || !isGrouped(left, thousandsSep)) return null;
    whole = left.split(thousandsSep).join('');
  } else {
    const sep = dots > 0 ? '.' : ',';
    if (Math.max(dots, commas) > 1) {
      // Mismo separador repetido: solo puede ser agrupación de miles ("1,234,567").
      if (!isGrouped(s, sep)) return null;
      whole = s.split(sep).join('');
    } else {
      const at = s.indexOf(sep);
      const left = s.slice(0, at);
      const right = s.slice(at + 1);
      if (right.length <= 2) {
        whole = left; // "86.4", "86,40", ".5", "86."
        frac = right;
      } else if (right.length === 3 && sep === ',' && !opts.strict && /^[1-9]\d{0,2}$/.test(left)) {
        whole = left + right; // "1,234" = mil doscientos treinta y cuatro
      } else {
        return null; // "1.234" es ambiguo y "86.405" trae más de 2 decimales
      }
    }
  }

  if (whole === '') whole = '0';
  if (!/^\d{1,12}$/.test(whole) || !/^\d{0,2}$/.test(frac)) return null;
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}

/** Lo que devuelve el modelo (número o texto) -> centavos válidos (1 .. MAX), o null. */
export function coerceAmountCents(value: unknown): number | null {
  let cents: number | null = null;
  if (typeof value === 'number') {
    // 86.405 no es un monto: redondearlo en silencio cambiaría el centavo. 1e-6 absorbe el ruido de coma flotante.
    const raw = value * 100;
    cents = Number.isFinite(raw) && Math.abs(raw - Math.round(raw)) <= 1e-6 ? Math.round(raw) : null;
  } else if (typeof value === 'string') cents = parseAmountToCents(value, { strict: true });
  if (cents === null || cents <= 0 || cents > MAX_AMOUNT_CENTS) return null;
  return cents;
}

/** Centavos -> texto para el campo editable: "1234.50" (sin símbolo ni separador de miles). */
export function centsToInputText(cents: number): string {
  const abs = Math.abs(Math.trunc(cents));
  return `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** Centavos -> texto de lectura: "S/ 86.40", "S/ 1,234.50", "US$ 12.00". */
export function formatMoney(cents: number, currency: Currency = 'PEN'): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.trunc(cents));
  const whole = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}${MONEY_SYMBOL[currency]} ${whole}.${String(abs % 100).padStart(2, '0')}`;
}

// ───────────────────────── Fechas (America/Lima, UTC-5 todo el año) ─────────────────────────

const LIMA_OFFSET_MS = 5 * 60 * 60 * 1000;

/** "Hoy" en Lima como AAAA-MM-DD, sin importar la zona del dispositivo. */
export function limaToday(nowMs: number): string {
  return new Date(nowMs - LIMA_OFFSET_MS).toISOString().slice(0, 10);
}

/** AAAA-MM-DD que existe en el calendario (rechaza 2026-02-30 y 2026-13-01). */
export function isValidIsoDate(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

/**
 * Fecha que dice el modelo -> AAAA-MM-DD válida, o null.
 * Acepta AAAA-MM-DD y las boletas peruanas DD/MM/AAAA, DD-MM-AAAA y DD/MM/AA (día primero).
 */
export function normalizeReceiptDate(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  let y: number;
  let mo: number;
  let d: number;
  const iso = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)/.exec(s);
  if (iso) {
    y = Number(iso[1]);
    mo = Number(iso[2]);
    d = Number(iso[3]);
  } else {
    const dmy = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})(?!\d)/.exec(s);
    if (!dmy) return null;
    d = Number(dmy[1]);
    mo = Number(dmy[2]);
    y = Number(dmy[3]) + (dmy[3]?.length === 2 ? 2000 : 0);
  }
  const out = `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return isValidIsoDate(out) ? out : null;
}

const WEEKDAYS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

/**
 * La fecha en palabras, sin ambigüedad día/mes (el selector nativo la muestra según el idioma del
 * teléfono): "hoy · dom 4 oct", "ayer · sáb 3 oct", "mié 1 oct 2025". '' si la fecha no es válida.
 */
export function describeDate(date: string, today: string): string {
  if (!isValidIsoDate(date) || !isValidIsoDate(today)) return '';
  const at = (iso: string) => new Date(`${iso}T00:00:00Z`);
  const d = at(date);
  const base = `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  if (date === today) return `hoy · ${base}`;
  if (date === new Date(at(today).getTime() - 86400000).toISOString().slice(0, 10)) return `ayer · ${base}`;
  return d.getUTCFullYear() === at(today).getUTCFullYear() ? base : `${base} ${d.getUTCFullYear()}`;
}

/**
 * Fecha elegida -> instante ISO para `transaction_date` (TIMESTAMPTZ).
 * Hoy conserva la hora real; otro día se guarda a las 12:00 de Lima para que ningún huso
 * lo corra de día. Precondición: `date` ya pasó por isValidIsoDate.
 */
export function dateToTimestamp(date: string, nowMs: number): string {
  if (date === limaToday(nowMs)) return new Date(nowMs).toISOString();
  return new Date(`${date}T12:00:00-05:00`).toISOString();
}

// ───────────────────────── Lectura de la boleta ─────────────────────────

export interface ReceiptReading {
  /** null si el modelo no devolvió un monto utilizable. */
  amountCents: number | null;
  currency: Currency;
  description: string;
  categoryId: string | null;
  categoryName: string | null;
  /** AAAA-MM-DD válida y no futura, o null si no se pudo leer. */
  date: string | null;
  /** 0 a 1, o null si el modelo no la dio. */
  confidence: number | null;
  itemsDetected: number | null;
}

/** Bajo este valor se le pide a David comparar el total con la foto. */
export const LOW_CONFIDENCE = 0.7;

const asRecord = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};

const tidyText = (v: unknown, max: number): string =>
  typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '';

const toNumber = (v: unknown): number =>
  typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN;

function toConfidence(v: unknown): number | null {
  const n = toNumber(v);
  if (!Number.isFinite(n) || n < 0) return null;
  if (n <= 1) return n;
  return n <= 100 ? n / 100 : null; // el modelo a veces responde 92 en vez de 0.92
}

/** Respuesta de `parse-receipt` (cualquier forma) -> lectura tipada. Nunca lanza. */
export function parseReading(raw: unknown, today: string): ReceiptReading {
  const r = asRecord(raw);
  const date = normalizeReceiptDate(r['date']);
  const items = toNumber(r['items_detected']);
  return {
    amountCents: coerceAmountCents(r['amount']),
    currency: String(r['currency_code'] ?? '').toUpperCase() === 'USD' ? 'USD' : 'PEN',
    description: tidyText(r['description'], 120),
    categoryId: typeof r['category_id'] === 'string' && r['category_id'] !== '' ? r['category_id'] : null,
    categoryName: tidyText(r['category_name'], 100) || null,
    date: date !== null && date <= today ? date : null, // una fecha futura es un error de lectura
    confidence: toConfidence(r['confidence']),
    itemsDetected: Number.isInteger(items) && items >= 0 ? items : null,
  };
}

export const needsDoubleCheck = (reading: ReceiptReading): boolean =>
  reading.confidence !== null && reading.confidence < LOW_CONFIDENCE;

/** Línea de contexto bajo el título de la revisión: qué se leyó y qué no. */
export function readingSummary(reading: ReceiptReading | null): string {
  if (!reading) return 'Entrada a mano; la foto queda de referencia.';
  const parts = [reading.date ? 'Leí el total y la fecha' : 'Leí el total, no vi la fecha'];
  if (reading.itemsDetected) {
    parts.push(`${reading.itemsDetected} ${reading.itemsDetected === 1 ? 'ítem' : 'ítems'}`);
  }
  return parts.join(' · ');
}

/** Nombre corriente de una moneda para frases ("soles", "dólares"); otros códigos pasan tal cual. */
export const currencyName = (code: string): string =>
  code === 'PEN' ? 'soles' : code === 'USD' ? 'dólares' : code;

// ───────────────────────── Categorías y cuentas ─────────────────────────

export interface CategoryLike {
  category_id: string;
  category_name: string;
  category_type: string;
}

export interface AccountLike {
  account_id: string;
  account_name: string;
  currency_code: string;
}

const fold = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase();

export const expenseCategories = <T extends CategoryLike>(categories: T[]): T[] =>
  categories.filter((c) => c.category_type === 'expense');

/** Categoría de gasto que corresponde a la pista del modelo (id primero, luego nombre sin tildes). */
export function resolveCategoryId(
  categories: CategoryLike[],
  hint: { id?: string | null; name?: string | null },
): string | null {
  const pool = expenseCategories(categories);
  if (hint.id) {
    const byId = pool.find((c) => c.category_id === hint.id);
    if (byId) return byId.category_id;
  }
  if (hint.name) {
    const wanted = fold(hint.name);
    const byName = pool.find((c) => fold(c.category_name) === wanted);
    if (byName) return byName.category_id;
  }
  return null;
}

/** "Otros gastos": donde cae un gasto cuando el modelo no supo categorizarlo. */
export function findOthersCategoryId(categories: CategoryLike[]): string | null {
  return resolveCategoryId(categories, { name: 'Otros gastos' });
}

/**
 * Cuenta por defecto: la última usada si calza con la moneda de la boleta, luego la primera de esa
 * moneda, luego la última usada, luego la primera. '' si no hay cuentas.
 */
export function pickAccountId(
  accounts: AccountLike[],
  currency: Currency,
  preferredId?: string | null,
): string {
  const preferred = preferredId ? accounts.find((a) => a.account_id === preferredId) : undefined;
  if (preferred && preferred.currency_code === currency) return preferred.account_id;
  const sameCurrency = accounts.find((a) => a.currency_code === currency);
  if (sameCurrency) return sameCurrency.account_id;
  return (preferred ?? accounts[0])?.account_id ?? '';
}

// ───────────────────────── Formulario ─────────────────────────

export interface ReceiptFormValues {
  description: string;
  /** Texto tal como lo escribe David; se interpreta con parseAmountToCents. */
  amountText: string;
  currency: Currency;
  /** AAAA-MM-DD */
  date: string;
  /** '' = sin categoría */
  categoryId: string;
  accountId: string;
}

export type FormField = 'description' | 'amount' | 'date' | 'account';
export type FormErrors = Partial<Record<FormField, string>>;

export interface ReceiptSubmission {
  description: string;
  amountCents: number;
  currency: Currency;
  date: string;
  categoryId: string | null;
  accountId: string;
}

/** Valores iniciales del formulario. Sin lectura (entrada a mano) el monto queda vacío. */
export function buildFormValues(
  reading: ReceiptReading | null,
  ctx: {
    today: string;
    categories: CategoryLike[];
    accounts: AccountLike[];
    preferredAccountId?: string | null;
  },
): ReceiptFormValues {
  const currency = reading?.currency ?? 'PEN';
  const categoryId =
    resolveCategoryId(ctx.categories, { id: reading?.categoryId, name: reading?.categoryName }) ??
    (reading ? findOthersCategoryId(ctx.categories) : null);
  return {
    description: reading?.description ?? '',
    amountText: reading?.amountCents ? centsToInputText(reading.amountCents) : '',
    currency,
    date: reading?.date ?? ctx.today,
    categoryId: categoryId ?? '',
    accountId: pickAccountId(ctx.accounts, currency, ctx.preferredAccountId),
  };
}

export function validateForm(
  values: ReceiptFormValues,
  ctx: { today: string; accounts: { account_id: string; currency_code: string }[] },
): { ok: true; value: ReceiptSubmission } | { ok: false; errors: FormErrors } {
  const errors: FormErrors = {};

  const cents = parseAmountToCents(values.amountText);
  if (cents === null) errors.amount = 'Escribe el monto con hasta 2 decimales, por ejemplo 86.40.';
  else if (cents <= 0) errors.amount = 'El monto debe ser mayor a cero.';
  else if (cents > MAX_AMOUNT_CENTS) errors.amount = 'Ese monto es demasiado alto. Revísalo con la boleta.';

  if (!isValidIsoDate(values.date)) errors.date = 'Elige una fecha válida.';
  else if (values.date > ctx.today) errors.date = 'La fecha no puede ser futura.';

  const account = ctx.accounts.find((a) => a.account_id === values.accountId);
  if (!account) errors.account = 'Elige la cuenta del gasto.';
  else if (account.currency_code !== values.currency) {
    errors.account = `La cuenta es en ${currencyName(account.currency_code)} y el gasto en ${currencyName(values.currency)}. Elige otra cuenta o cambia la moneda.`;
  }

  if (Object.keys(errors).length > 0 || cents === null) return { ok: false, errors };
  return {
    ok: true,
    value: {
      description: values.description.replace(/\s+/g, ' ').trim() || 'Boleta',
      amountCents: cents,
      currency: values.currency,
      date: values.date,
      categoryId: values.categoryId || null,
      accountId: values.accountId,
    },
  };
}

/** ¿La fila ya guardada dice lo mismo que el formulario? (monto en céntimos, cuenta, categoría, moneda, día de Lima, texto). */
export function savedMatchesSubmission(
  saved: {
    amount: number | string;
    account_id: string;
    category_id: string | null;
    currency_code: string;
    transaction_date: string;
    description: string | null;
  },
  v: ReceiptSubmission,
): boolean {
  return (
    Math.round(Number(saved.amount) * 100) === v.amountCents &&
    saved.account_id === v.accountId &&
    (saved.category_id ?? null) === v.categoryId &&
    saved.currency_code === v.currency &&
    limaToday(Date.parse(saved.transaction_date)) === v.date &&
    (saved.description ?? '') === v.description
  );
}

// ───────────────────────── Errores y espera ─────────────────────────

/** Tiempo máximo de espera de `parse-receipt` en el cliente. */
export const READ_TIMEOUT_MS = 40000;

export type ProblemKind =
  | 'unreadable'
  | 'unavailable'
  | 'auth'
  | 'network'
  | 'timeout'
  | 'image'
  | 'too-large'
  | 'unknown';

export interface ReceiptProblem {
  kind: ProblemKind;
  title: string;
  hint: string;
  /** Tiene sentido reenviar la misma foto. */
  canRetry: boolean;
  /** Se puede seguir llenando el gasto a mano con la foto como referencia. */
  canWriteByHand: boolean;
}

const PROBLEMS: Record<ProblemKind, Omit<ReceiptProblem, 'kind'>> = {
  unreadable: {
    title: 'No pude leer la boleta',
    hint: 'Prueba con más luz, sin sombras ni reflejos, con la boleta plana y el total a la vista.',
    canRetry: false,
    canWriteByHand: true,
  },
  unavailable: {
    title: 'El lector de boletas no responde',
    hint: 'Es un problema de Wabid, no de tu foto. Inténtalo de nuevo en unos segundos.',
    canRetry: true,
    canWriteByHand: true,
  },
  auth: {
    title: 'Tu sesión venció',
    hint: 'Vuelve a entrar a Wabid y repite la foto.',
    canRetry: false,
    canWriteByHand: false,
  },
  network: {
    title: 'Sin conexión con Wabid',
    hint: 'Revisa tu internet e inténtalo de nuevo. La foto sigue aquí.',
    canRetry: true,
    canWriteByHand: false,
  },
  timeout: {
    title: 'La lectura tardó demasiado',
    hint: 'Revisa tu conexión e inténtalo de nuevo. La foto sigue aquí.',
    canRetry: true,
    canWriteByHand: true,
  },
  image: {
    title: 'No pude abrir esa foto',
    hint: 'Prueba con otra en formato JPG o PNG, o toma una nueva con la cámara.',
    canRetry: false,
    canWriteByHand: false,
  },
  'too-large': {
    title: 'La foto pesa demasiado',
    hint: 'Toma otra más cerca de la boleta o con menos zoom.',
    canRetry: false,
    canWriteByHand: false,
  },
  unknown: {
    title: 'No pude leer la boleta',
    hint: 'Prueba con más luz o inténtalo de nuevo.',
    canRetry: true,
    canWriteByHand: true,
  },
};

export const problemOf = (kind: ProblemKind): ReceiptProblem => ({ kind, ...PROBLEMS[kind] });

/** Fallo de `parse-receipt` (estado HTTP, mensaje del servidor o falla de red) -> mensaje para David. */
export function describeFailure(input: {
  status?: number | null;
  serverMessage?: string | null;
  network?: boolean;
  timedOut?: boolean;
}): ReceiptProblem {
  if (input.timedOut) return problemOf('timeout');
  if (input.network) return problemOf('network');
  const status = input.status ?? 0;
  const message = (input.serverMessage ?? '').toLowerCase();
  if (status === 401 || status === 403) return problemOf('auth');
  if (status === 413) return problemOf('too-large');
  if (status === 422) return problemOf('unreadable');
  if (status === 500 && message.includes('no se pudo leer')) return problemOf('unreadable');
  if (status === 500 || status === 502 || status === 503 || status === 504) return problemOf('unavailable');
  return problemOf('unknown');
}

/** Texto de espera según los segundos transcurridos: avanza para que no parezca colgado. */
export function readingMessage(elapsedSeconds: number): { text: string; slow: boolean } {
  if (elapsedSeconds < 6) return { text: 'Leyendo la boleta…', slow: false };
  if (elapsedSeconds < 15) return { text: 'Buscando el total y la fecha…', slow: false };
  return { text: 'Está tardando más de lo normal…', slow: true };
}
