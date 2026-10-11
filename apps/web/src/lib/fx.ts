// Multimoneda de la web: Wabid maneja soles (PEN) y dólares (USD). Los totales se muestran en soles; cada cuenta y cada movimiento
// conserva su moneda. El tipo de cambio sale de la tabla fx_rates (migración 016), que llena la edge function `fx`
// (BCRP serie SBS venta; respaldo open.er-api.com; si ambas fallan, el último valor guardado).
//
// Lógica pura (sin React ni Supabase): se prueba con Node, ver fx.test.ts.
// Es copia de las reglas de supabase/functions/_shared/fx.ts (la web y las funciones son árboles separados): si cambia una, cambia la otra.

export const PAR_USD = 'USD/PEN'; // soles por 1 dólar
/** Pasadas estas horas desde la última consulta se vuelve a pedir a la función `fx`. */
export const VIGENCIA_HORAS = 6;
/** Un tipo de cambio de hace más de estos días se muestra con su fecha («TC 3.45 del 7 oct»). */
export const DIAS_FRESCO = 4;

export interface TipoCambio {
  valor: number;
  fecha: string; // AAAA-MM-DD del último día publicado
  fuente: string;
  obtenido_en: string; // ISO: cuándo lo trajo la función
}
export interface Punto {
  fecha: string;
  valor: number;
}

const plausible = (n: number) => Number.isFinite(n) && n >= 1 && n <= 20;

/** Fila de fx_rates (o respuesta de la función) -> TipoCambio. null si no es utilizable. */
export function leerTipoCambio(fila: unknown): TipoCambio | null {
  const f = fila as Partial<Record<keyof TipoCambio, unknown>> | null;
  const valor = Number(f?.valor);
  if (!f || !plausible(valor) || typeof f.fecha !== 'string') return null;
  return { valor, fecha: f.fecha, fuente: String(f.fuente ?? ''), obtenido_en: String(f.obtenido_en ?? '') };
}

export function hayQueRefrescar(tc: TipoCambio | null, ahora: Date): boolean {
  if (!tc) return true;
  const t = Date.parse(tc.obtenido_en);
  return !Number.isFinite(t) || ahora.getTime() - t > VIGENCIA_HORAS * 3_600_000;
}

export const redondear = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/** Monto en soles. PEN no cambia; USD se multiplica por el tipo de cambio; null si no se sabe convertir (sin tipo de cambio u otra moneda). */
export function aSoles(monto: number, moneda: string | null | undefined, tc: Pick<TipoCambio, 'valor'> | null | undefined): number | null {
  const m = (moneda ?? 'PEN').toUpperCase();
  if (m === 'PEN') return monto;
  if (m === 'USD' && tc && tc.valor > 0) return redondear(monto * tc.valor);
  return null;
}

/** «3.45»: hasta 3 decimales (la SBS publica 3) sin ceros de más. */
export const textoTc = (valor: number): string => String(Number(valor.toFixed(3)));

const DIA_MS = 86_400_000;
const MESES_CORTOS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
/** «7 oct» a partir de AAAA-MM-DD. */
export const fechaCorta = (iso: string): string => `${Number(iso.slice(8, 10))} ${MESES_CORTOS[Number(iso.slice(5, 7)) - 1] ?? ''}`;

/** AAAA-MM-DD de un instante en hora de Lima (igual que la base: (fecha AT TIME ZONE 'America/Lima')::date). */
export function diaLima(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  return new Date(d.getTime() - 5 * 3_600_000).toISOString().slice(0, 10); // Lima = UTC-5 todo el año
}

/** Tipo de cambio de un día: el último con fecha <= esa fecha; antes del primero conocido, el primero (igual que fx_tasa() en SQL). */
export function tasaDeFecha(historial: Punto[], fecha: string): number | null {
  if (!historial.length) return null;
  const ord = [...historial].sort((a, b) => a.fecha.localeCompare(b.fecha));
  let valor = ord[0]!.valor;
  for (const p of ord) {
    if (p.fecha > fecha) break;
    valor = p.valor;
  }
  return valor;
}

// ------------------------------------------------------------------------------------------------ saldos de cuentas

export interface CuentaSaldo {
  account_type: string;
  currency_code?: string | null;
  current_balance?: number | string | null;
}
export interface Patrimonio {
  /** Todo en soles: lo de soles + los dólares convertidos. Las tarjetas de crédito restan (su saldo es deuda). */
  soles: number;
  /** Solo las cuentas en soles. */
  pen: number;
  /** Solo las cuentas en dólares, en dólares. */
  usd: number;
  hayUsd: boolean;
  /** Los dólares convertidos; null si hay dólares y no hay tipo de cambio (entonces `soles` NO los incluye). */
  usdEnSoles: number | null;
  /** Hay cuentas en una moneda que no se convierte (ni PEN ni USD): no entran en `soles`. */
  otrasMonedas: boolean;
}

export function patrimonio(cuentas: CuentaSaldo[], tc: Pick<TipoCambio, 'valor'> | null | undefined): Patrimonio {
  let pen = 0;
  let usd = 0;
  let otras = false;
  for (const c of cuentas) {
    const signo = c.account_type === 'credit_card' ? -1 : 1;
    const saldo = signo * Number(c.current_balance ?? 0);
    const m = (c.currency_code ?? 'PEN').toUpperCase();
    if (m === 'PEN') pen += saldo;
    else if (m === 'USD') usd += saldo;
    else otras = true;
  }
  pen = redondear(pen);
  usd = redondear(usd);
  const usdEnSoles = usd === 0 ? 0 : aSoles(usd, 'USD', tc);
  return { soles: redondear(pen + (usdEnSoles ?? 0)), pen, usd, hayUsd: usd !== 0, usdEnSoles, otrasMonedas: otras };
}

// ------------------------------------------------------------------------------------------------ totales de movimientos

export interface Monto {
  monto: number;
  moneda: string | null | undefined;
  /** AAAA-MM-DD (Lima) del movimiento: con él se usa el tipo de cambio de ese día. Sin él, el último. */
  fecha?: string;
}
export interface TotalSoles {
  /** Suma en soles: soles + dólares convertidos. */
  soles: number;
  /** Cuántos dólares entraron (en dólares), ya incluidos en `soles`. */
  usd: number;
  /** Lo que valen esos dólares en soles. */
  usdEnSoles: number;
  /** Dólares que NO se pudieron convertir (no hay ningún tipo de cambio): no están en `soles`. */
  usdSinConvertir: number;
  /** Rango de tipos de cambio realmente usados (null si no se convirtió nada). */
  tcMin: number | null;
  tcMax: number | null;
}

/** Suma montos de distintas monedas en soles. Los dólares usan el tipo de su día (`historial`); sin día, el vigente (`tc`). */
export function totalEnSoles(items: Monto[], tc: Pick<TipoCambio, 'valor'> | null | undefined, historial: Punto[] = []): TotalSoles {
  const r: TotalSoles = { soles: 0, usd: 0, usdEnSoles: 0, usdSinConvertir: 0, tcMin: null, tcMax: null };
  for (const it of items) {
    const m = (it.moneda ?? 'PEN').toUpperCase();
    if (m === 'PEN') {
      r.soles += it.monto;
      continue;
    }
    if (m !== 'USD') continue; // otra moneda: no se suma como soles
    const valor = (it.fecha ? tasaDeFecha(historial, it.fecha) : null) ?? tc?.valor ?? null;
    if (valor === null) {
      r.usdSinConvertir += it.monto;
      continue;
    }
    const enSoles = redondear(it.monto * valor);
    r.soles += enSoles;
    r.usdEnSoles += enSoles;
    r.usd += it.monto;
    r.tcMin = r.tcMin === null ? valor : Math.min(r.tcMin, valor);
    r.tcMax = r.tcMax === null ? valor : Math.max(r.tcMax, valor);
  }
  return { ...r, soles: redondear(r.soles), usd: redondear(r.usd), usdEnSoles: redondear(r.usdEnSoles), usdSinConvertir: redondear(r.usdSinConvertir) };
}

/** Junta dos totales (p. ej. ingresos y gastos de un período) para hablar de los dólares de ambos en una sola línea. */
export function juntarTotales(a: TotalSoles, b: TotalSoles): TotalSoles {
  const min = (x: number | null, y: number | null) => (x === null ? y : y === null ? x : Math.min(x, y));
  const max = (x: number | null, y: number | null) => (x === null ? y : y === null ? x : Math.max(x, y));
  return {
    soles: redondear(a.soles + b.soles),
    usd: redondear(a.usd + b.usd),
    usdEnSoles: redondear(a.usdEnSoles + b.usdEnSoles),
    usdSinConvertir: redondear(a.usdSinConvertir + b.usdSinConvertir),
    tcMin: min(a.tcMin, b.tcMin),
    tcMax: max(a.tcMax, b.tcMax),
  };
}

// ------------------------------------------------------------------------------------------------ texto de la conversión

const dolares = (n: number) =>
  `US$ ${Math.abs(n).toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const soles = (n: number) => `S/ ${n.toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** «TC 3.45», «TC 3.43–3.45» o, si el valor es viejo, «TC 3.45 del 7 oct». */
export function textoRangoTc(min: number, max: number, fecha?: string, hoy?: string): string {
  const base = min === max ? `TC ${textoTc(min)}` : `TC ${textoTc(min)}–${textoTc(max)}`;
  if (fecha && hoy && (Date.parse(`${hoy}T00:00:00Z`) - Date.parse(`${fecha}T00:00:00Z`)) / DIA_MS > DIAS_FRESCO) return `${base} del ${fechaCorta(fecha)}`;
  return base;
}

export interface Conversion {
  /** Dólares que van dentro del total (en dólares; negativo si son deuda neta). */
  usd: number;
  /** Lo que valen en soles; null si no hay tipo de cambio (los dólares NO están sumados). */
  enSoles: number | null;
  tcMin: number | null;
  tcMax: number | null;
  /** Día del tipo de cambio vigente (para avisar si es viejo). */
  fecha?: string;
}

/**
 * La línea que acompaña a un total en soles que incluye dólares: «Incluye US$ 500.00 ≈ S/ 1,725.00 (TC 3.45)».
 * Sin tipo de cambio dice que los dólares NO están sumados. null si no hay dólares.
 */
export function notaConversion(c: Conversion, hoy: string, etiqueta = 'Incluye'): string | null {
  if (c.usd === 0) return null;
  if (c.enSoles === null || c.tcMin === null || c.tcMax === null) return `${dolares(c.usd)} sin sumar: falta el tipo de cambio`;
  return `${etiqueta} ${c.usd < 0 ? '−' : ''}${dolares(c.usd)} ≈ ${c.enSoles < 0 ? '−' : ''}${soles(Math.abs(c.enSoles))} (${textoRangoTc(c.tcMin, c.tcMax, c.fecha, hoy)})`;
}

/** La conversión de un Patrimonio con el tipo de cambio vigente. */
export const conversionDePatrimonio = (p: Patrimonio, tc: TipoCambio | null): Conversion => ({
  usd: p.usd, enSoles: p.usdEnSoles, tcMin: tc?.valor ?? null, tcMax: tc?.valor ?? null, fecha: tc?.fecha,
});

/** La conversión de un TotalSoles; los dólares sin convertir tienen prioridad (el total está incompleto). */
export const conversionDeTotal = (t: TotalSoles, fecha?: string): Conversion =>
  t.usdSinConvertir !== 0
    ? { usd: t.usdSinConvertir, enSoles: null, tcMin: null, tcMax: null }
    : { usd: t.usd, enSoles: t.usdEnSoles, tcMin: t.tcMin, tcMax: t.tcMax, fecha };

/** «≈ S/ 1,725.00 (TC 3.45)» para el saldo de UNA cuenta en dólares. null si no hay tipo de cambio. */
export function equivalenteEnSoles(monto: number, moneda: string | null | undefined, tc: TipoCambio | null, hoy: string): string | null {
  if ((moneda ?? 'PEN').toUpperCase() === 'PEN' || !tc) return null;
  const s = aSoles(Math.abs(monto), moneda, tc);
  return s === null ? null : `≈ ${soles(s)} (${textoRangoTc(tc.valor, tc.valor, tc.fecha, hoy)})`;
}
