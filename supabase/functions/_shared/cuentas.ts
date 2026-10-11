// Cuentas financieras por voz: validar una cuenta nueva, no duplicarla y encontrar una existente por nombre aproximado
// ("la de BCP", "mi Interbank"). Puro: sin globals de Deno; se prueba con Node (cuentas.test.ts).
//
// Esquema (001_initial_schema.sql): accounts(account_name ≤100, account_type, currency_code → currencies, current_balance,
// is_active). Los tipos y la moneda salen de ahí; la web (Accounts.tsx) crea cuentas con el mismo juego de campos.
import { type Cambio, patrimonio, redondear, textoTc } from "./fx.ts";
import { coincide, cubre, limpiarEspacios, norm } from "./texto.ts";
import { queCabe } from "./voz.ts";

export type TipoCuenta = "checking" | "savings" | "credit_card" | "cash" | "investment" | "loan" | "other";
export const TIPOS: TipoCuenta[] = ["checking", "savings", "credit_card", "cash", "investment", "loan", "other"];
export type Moneda = "PEN" | "USD";
export const MONEDAS: Moneda[] = ["PEN", "USD"];

/** Cómo se dice cada tipo (la web los llama "Cuenta corriente", "Ahorro", "Tarjeta de crédito"…). */
export const TIPO_HABLADO: Record<TipoCuenta, string> = {
  checking: "cuenta corriente",
  savings: "cuenta de ahorros",
  credit_card: "tarjeta de crédito",
  cash: "efectivo",
  investment: "inversión",
  loan: "préstamo",
  other: "cuenta",
};

export const MONEDA_HABLADA: Record<Moneda, string> = { PEN: "soles", USD: "dólares" };
export const SIMBOLO: Record<Moneda, string> = { PEN: "S/", USD: "US$" };

export const MAX_NOMBRE = 100; // VARCHAR(100)
export const MAX_SALDO = 1_000_000_000; // 18 dígitos caben, pero más de mil millones es un dictado equivocado

// Lo que el modelo (o David) puede decir para un tipo. El esquema de la tool ya manda el código inglés; esto cubre el resto.
const SINONIMOS_TIPO: [TipoCuenta, string[]][] = [
  ["credit_card", ["credit card", "tarjeta", "tarjeta de credito", "credito", "tc"]],
  ["savings", ["savings", "ahorro", "ahorros", "cuenta de ahorros", "cuenta de ahorro"]],
  ["cash", ["cash", "efectivo", "billetera", "caja"]],
  ["investment", ["investment", "inversion", "inversiones", "broker"]],
  ["loan", ["loan", "prestamo", "deuda"]],
  ["checking", ["checking", "corriente", "cuenta corriente", "bancaria", "cuenta bancaria", "banco", "debito", "sueldo"]],
];

/** "ahorros" → savings; null si no se parece a ningún tipo. */
export function tipoDesdeTexto(v: unknown): TipoCuenta | null {
  if (typeof v !== "string") return null;
  const t = norm(v).replace(/_/g, " ");
  if (!t) return null;
  const exacto = TIPOS.find((x) => x.replace(/_/g, " ") === t);
  if (exacto) return exacto;
  for (const [tipo, palabras] of SINONIMOS_TIPO) if (palabras.includes(t)) return tipo;
  return null;
}

/** "dólares" / "usd" / "$" → USD; "soles" / "pen" / "s/" → PEN; null si no se entiende. */
export function monedaDesdeTexto(v: unknown): Moneda | null {
  if (typeof v !== "string") return null;
  const t = norm(v);
  if (["pen", "sol", "soles", "s", "nuevos soles"].includes(t)) return "PEN";
  if (["usd", "dolar", "dolares", "us", "dollars", "dolar americano"].includes(t) || v.trim() === "$") return "USD";
  return null;
}

// Palabras que no distinguen una cuenta de otra: "la de BCP" = "BCP", "mi cuenta Interbank" = "Interbank".
const RELLENO = new Set(["de", "del", "la", "el", "los", "las", "mi", "mis", "me", "en", "cuenta", "cuentas", "con", "a", "al", "y", "un", "una", "por", "es", "ese", "esa"]);
export const palabrasCuenta = (s: string): string[] => norm(s).split(" ").filter((t) => t && !RELLENO.has(t));

// Cada palabra que dice un tipo ("tarjeta", "credito", "ahorros", "efectivo"…) y de qué tipo es.
const PALABRAS_TIPO = new Map<string, TipoCuenta>(
  SINONIMOS_TIPO.flatMap(([tipo, frases]) => frases.flatMap((f) => f.split(" ")).filter((w) => !RELLENO.has(w)).map((w) => [w, tipo] as const)),
);

/** El tipo que nombra la consulta SOLO si todas sus palabras son de tipo: "la tarjeta" sí; "la tarjeta Falabella" no. */
function tipoPuro(q: string[]): TipoCuenta | null {
  const deTipo = (w: string): TipoCuenta | null => PALABRAS_TIPO.get(w) ?? [...PALABRAS_TIPO].find(([k]) => coincide(w, k))?.[1] ?? null; // plurales: "tarjetas"
  const tipos = new Set(q.map(deTipo));
  return tipos.size === 1 && !tipos.has(null) ? [...tipos][0] : null;
}

/** Mismas palabras (sin relleno), en cualquier orden: "Cuenta Interbank" y "interbank" son la misma cuenta. */
export function mismoNombre(a: string, b: string): boolean {
  const x = palabrasCuenta(a);
  const y = palabrasCuenta(b);
  if (!x.length || !y.length) return norm(a) === norm(b);
  return x.length === y.length && x.every((t) => y.includes(t));
}

export type CuentaMin = { account_id: string; account_name: string; account_type: string; currency_code?: string | null; current_balance?: number | string | null };

export type Busqueda<T extends CuentaMin = CuentaMin> =
  | { kind: "one"; cuenta: T }
  | { kind: "many"; cuentas: T[] }
  | { kind: "none" };

/**
 * Cuenta que David nombró, con tolerancia: tildes, mayúsculas, plurales y relleno ("la de BCP"). Todas las palabras de lo
 * dicho deben estar en el nombre. Si dos cuentas coinciden gana la de nombre exacto; si no, se devuelven para preguntar.
 * Sin coincidencia por nombre, "la tarjeta" o "efectivo" se resuelve por tipo cuando solo hay una de ese tipo, y SOLO si todas
 * las palabras de lo dicho son de tipo.
 */
export function buscarCuenta<T extends CuentaMin>(consulta: unknown, cuentas: T[]): Busqueda<T> {
  const texto = typeof consulta === "string" ? consulta : "";
  const q = palabrasCuenta(texto);
  if (!q.length) {
    // "Mi cuenta" son solo palabras de relleno: se compara el texto completo, para no dejar sin dirección a una cuenta así llamada.
    const t = norm(texto);
    const iguales = t ? cuentas.filter((c) => norm(c.account_name) === t) : [];
    return iguales.length === 1 ? { kind: "one", cuenta: iguales[0] } : iguales.length > 1 ? { kind: "many", cuentas: iguales } : { kind: "none" };
  }

  const aciertos = cuentas.filter((c) => cubre(q, palabrasCuenta(c.account_name)));
  if (aciertos.length === 1) return { kind: "one", cuenta: aciertos[0] };
  if (aciertos.length > 1) {
    const exactas = aciertos.filter((c) => mismoNombre(c.account_name, texto));
    return exactas.length === 1 ? { kind: "one", cuenta: exactas[0] } : { kind: "many", cuentas: aciertos };
  }

  // Sin coincidencia por nombre, solo vale el tipo "puro" ("la tarjeta", "el efectivo"). Si sobra una palabra ("la tarjeta Falabella",
  // "ahorros de Scotiabank") es una cuenta que no tengo: no se carga a la única tarjeta o a la única de ahorros; se pregunta.
  // Abreviaturas ("scotia" → Scotiabank, "inter" → Interbank): cada palabra dicha (3+ letras) es el comienzo de una palabra del nombre.
  // Solo se aceptan si el resultado es único; si no, se pregunta. (coincide() no lo permite a propósito: ver texto.ts.)
  const abreviadas = cuentas.filter((c) => {
    const bolsa = palabrasCuenta(c.account_name);
    return q.every((t) => t.length >= 3 && bolsa.some((b) => b.startsWith(t)));
  });
  if (abreviadas.length === 1) return { kind: "one", cuenta: abreviadas[0] };
  if (abreviadas.length > 1) return { kind: "many", cuentas: abreviadas };

  const tipo = tipoPuro(q);
  if (tipo) {
    const delTipo = cuentas.filter((c) => c.account_type === tipo);
    if (delTipo.length === 1) return { kind: "one", cuenta: delTipo[0] };
    if (delTipo.length > 1) return { kind: "many", cuentas: delTipo };
  }
  return { kind: "none" };
}

export type CuentaNueva = { account_name: string; account_type: TipoCuenta; currency_code: Moneda; current_balance: number };
export type ValidacionCuenta = { ok: true; cuenta: CuentaNueva } | { ok: false; error: string; duplicada?: CuentaMin; pregunta?: boolean };

/**
 * Número dictado como texto o cifra. La coma solo se acepta como separador de miles ("1,500" → 1500, "1,234,567.5") o como
 * decimal claro de 1 o 2 cifras ("1,5" → 1.5, "12,50" → 12.5). Un punto con exactamente 3 decimales ("1.500", "US$ 2.000") es
 * ambiguo. Cualquier otra cosa ("1,2345", "1,5,0", "0,500", "1e3", "abc") es null: nunca se adivina (1,5 jamás es 15). Con signo menos opcional y un prefijo de moneda ("S/ 500", "US$ 20", "$").
 */
export function numeroDictado(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const t = v.trim().replace(/^(-?)\s*(?:S\/|US\$|\$)\s*/i, "$1").replace(/\s+/g, "");
  // "1.500" o "2.000": con punto y exactamente 3 decimales puede ser 1,5 o mil quinientos (en español el punto separa miles).
  // No se adivina: null y se pide repetirlo. «0.500» sí es 0,5 (un grupo de miles no puede ir tras un 0) y «1500.250» también.
  if (/^-?[1-9]\d{0,2}\.\d{3}$/.test(t)) return null;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  // El primer grupo de miles no empieza en 0: «0,500» no es 500.
  if (/^-?[1-9]\d{0,2}(,\d{3})+(\.\d+)?$/.test(t)) return Number(t.replace(/,/g, ""));
  if (/^-?\d+,\d{1,2}$/.test(t)) return Number(t.replace(",", "."));
  return null;
}

/** Redondea a céntimos sin errores de coma flotante (500.1 + 0.2). */
export const aCentimos = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Valida lo que dictó David antes de tocar la base: nombre, tipo, moneda y saldo inicial. Todo lo que no se puede
 * corregir solo es un error con una frase para decir; los valores omitidos toman el valor por defecto (cuenta corriente,
 * soles, saldo cero). `existentes` son las cuentas activas: un nombre repetido no se crea.
 */
export function validarCuentaNueva(args: Record<string, unknown>, existentes: CuentaMin[]): ValidacionCuenta {
  const nombre = limpiarEspacios(typeof args.account_name === "string" ? args.account_name : "");
  if (!nombre) return { ok: false, error: "¿Cómo se llama la cuenta?", pregunta: true };
  if (nombre.length > MAX_NOMBRE) return { ok: false, error: `El nombre es muy largo: máximo ${MAX_NOMBRE} letras.` };
  if (!/[\p{L}\p{N}]/u.test(nombre)) return { ok: false, error: "El nombre de la cuenta necesita letras o números." };

  let tipo: TipoCuenta = "checking";
  if (args.account_type !== undefined && args.account_type !== null && args.account_type !== "") {
    const t = tipoDesdeTexto(args.account_type);
    if (!t) return { ok: false, error: "No entendí el tipo: dime banco, ahorros, tarjeta, efectivo, inversión o préstamo." };
    tipo = t;
  }

  let moneda: Moneda = "PEN";
  if (args.currency_code !== undefined && args.currency_code !== null && args.currency_code !== "") {
    const m = monedaDesdeTexto(args.currency_code);
    if (!m) return { ok: false, error: "Solo manejo soles o dólares. ¿En cuál es la cuenta?" };
    moneda = m;
  }

  let saldo = 0;
  const bruto = args.initial_balance;
  if (bruto !== undefined && bruto !== null && bruto !== "") {
    const n = numeroDictado(bruto);
    if (n === null) return { ok: false, error: "No entendí el saldo inicial. Dímelo en números, por ejemplo quinientos soles." };
    if (Math.abs(n) > MAX_SALDO) return { ok: false, error: "Ese saldo inicial es demasiado grande; repítelo." };
    // En una tarjeta el saldo es lo que se debe (la web lo resta del patrimonio): un negativo no tiene sentido ahí.
    if (n < 0 && tipo === "credit_card") return { ok: false, error: "En una tarjeta el saldo es lo que debes, sin signo. Repítelo." };
    saldo = aCentimos(n);
  }

  const repetida = existentes.find((c) => mismoNombre(c.account_name, nombre));
  if (repetida) return { ok: false, error: `Ya tienes una cuenta llamada «${repetida.account_name}».`, duplicada: repetida };

  return { ok: true, cuenta: { account_name: nombre, account_type: tipo, currency_code: moneda, current_balance: saldo } };
}

// --- Frases -------------------------------------------------------------------------------------------------------
/** "S/ 1,780.00" / "US$ 20.00": el sistema lo pasa a palabras para la voz (voz.ts). */
export function monto(n: number, moneda: string | null | undefined): string {
  const m: Moneda = moneda === "USD" ? "USD" : "PEN";
  const signo = n < 0 ? "-" : "";
  return `${signo}${SIMBOLO[m]} ${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const nombreCorto = (s: string, max = 30) => (s.length <= max ? s : s.slice(0, max).replace(/\s+\S*$/, ""));

/** Pantalla: la cuenta y su saldo inicial. Voz: lo mismo en una frase (con el saldo redondeado o sin él si no cabe). */
export function fraseCuentaCreada(c: CuentaNueva): { message: string; voz: string } {
  const esTarjeta = c.account_type === "credit_card";
  const con = (n: number) => (esTarjeta ? `, con deuda de ${monto(n, c.currency_code)}` : `, con ${monto(n, c.currency_code)}`);
  const detalle = c.current_balance ? con(c.current_balance) : "";
  const que = esTarjeta ? "la tarjeta" : "la cuenta";
  const base = `Creé ${que} ${nombreCorto(c.account_name)}`;
  const moneda = ` en ${MONEDA_HABLADA[c.currency_code]}`;
  return {
    message: `Creé ${que} «${c.account_name}» (${TIPO_HABLADO[c.account_type]} en ${MONEDA_HABLADA[c.currency_code]})${detalle}.`,
    voz: queCabe([
      `${base}${moneda}${detalle}.`,
      ...(c.current_balance ? [`${base}${moneda}${con(Math.round(c.current_balance))}.`] : []),
      `${base}${moneda}.`,
      `${base}.`,
    ]),
  };
}

/**
 * Pantalla: todas las cuentas con su saldo. Voz: cuántas hay y el total (las tarjetas restan: son deuda).
 * Con `tc` (tipo de cambio USD→PEN) y cuentas en dólares, el total va EN SOLES con los dólares convertidos y la voz solo menciona
 * los dólares, corto («incluye US$ 500»). Sin `tc`, o con otra moneda de por medio, el total va por moneda (nunca se suman dólares como soles).
 */
export function fraseCuentas(cuentas: CuentaMin[], tc?: Cambio): { message: string; voz: string } {
  if (!cuentas.length) {
    return { message: "No tienes cuentas todavía. Dime cómo se llama la primera.", voz: "No tienes cuentas todavía. ¿Cómo se llama la primera?" };
  }
  const saldo = (c: CuentaMin) => Number(c.current_balance ?? 0);
  const p = patrimonio(cuentas, tc);
  if (tc && p.hayUsd && !p.otrasMonedas) {
    const n = cuentas.length;
    const tienes = `Tienes ${n} ${n === 1 ? "cuenta" : "cuentas"}`;
    const deuda = (c: CuentaMin) => (c.account_type === "credit_card" ? "debes " : "");
    const linea = (c: CuentaMin) =>
      c.currency_code === "USD"
        ? `${c.account_name}: ${deuda(c)}${monto(saldo(c), "USD")} (≈ ${monto(redondear(saldo(c) * tc.valor), "PEN")})`
        : `${c.account_name}: ${deuda(c)}${monto(saldo(c), c.currency_code)}`;
    const incluye = p.usd === 0 ? "" : ` (incluye ${monto(p.usd, "USD")} a TC ${textoTc(tc.valor)})`;
    return {
      message: `${tienes}: ${cuentas.map(linea).join("; ")}. Total: ${monto(p.soles, "PEN")}${incluye}.`,
      voz: queCabe([
        ...(p.usd === 0 ? [] : [`${tienes}; en total ${monto(Math.round(p.soles), "PEN")}, incluye ${monto(Math.round(p.usd), "USD")}.`]),
        `${tienes}; en total ${monto(Math.round(p.soles), "PEN")}.`,
        `${tienes}.`,
      ]),
    };
  }
  const linea = (c: CuentaMin) => `${c.account_name}: ${c.account_type === "credit_card" ? "debes " : ""}${monto(saldo(c), c.currency_code)}`;
  const porMoneda = new Map<string, number>();
  for (const c of cuentas) {
    const m = c.currency_code === "USD" ? "USD" : "PEN";
    porMoneda.set(m, (porMoneda.get(m) ?? 0) + (c.account_type === "credit_card" ? -saldo(c) : saldo(c)));
  }
  const totales = [...porMoneda.entries()].map(([m, n]) => monto(aCentimos(n), m));
  // La voz dice cifras redondas, sin céntimos (cada monto dicho cuesta ~35 caracteres y el tope es 100): la pantalla lleva el exacto.
  const redondos = [...porMoneda.entries()].map(([m, n]) => monto(Math.round(n), m));
  const n = cuentas.length;
  const tienes = `Tienes ${n} ${n === 1 ? "cuenta" : "cuentas"}`;
  // Se dice lo más completo que quepa SIN cortarse: un monto cortado a medias ("…ocho mil setecientos.") es peor que no decirlo.
  const candidatas = [
    `${tienes}; en total ${redondos.join(" y ")}.`,
    ...(redondos.length > 1 ? [`${tienes}; en total ${redondos[0]}, y más en otra moneda.`] : []),
    `${tienes}.`,
  ];
  const voz = queCabe(candidatas);
  return {
    message: `${tienes}: ${cuentas.map(linea).join("; ")}. Total: ${totales.join(" y ")}.`,
    voz,
  };
}

/** Para preguntar cuál: "BCP soles o BCP dólares". */
export const opcionesHabladas = (cuentas: CuentaMin[], max = 3): string => {
  const nombres = cuentas.slice(0, max).map((c) => nombreCorto(c.account_name, 24));
  return nombres.length > 1 ? `${nombres.slice(0, -1).join(", ")} o ${nombres[nombres.length - 1]}` : (nombres[0] ?? "");
};
