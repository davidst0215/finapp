// Tipo de cambio PEN/USD de Wabid: de dónde sale, cómo se guarda (tabla fx_rates, migración 016) y cómo se convierte.
// Sin globals de Deno: se prueba con Node (fx.test.ts). Lo importan la función `fx`, el brief y el agente.
//
// FUENTE (verificada el 11-oct-2026, API pública, sin llave):
//   1. BCRP, serie PD04640PD «TC Sistema bancario SBS (S/ por US$) - Venta» — el tipo de cambio que la SBS publica y SUNAT usa como oficial.
//      https://estadisticas.bcrp.gob.pe/estadisticas/series/api/PD04640PD/json/AAAA-MM-DD/AAAA-MM-DD/esp
//      Publica solo días hábiles y con 1-3 días de demora (el 11-oct el último valor era el del 7); los días sin dato vienen «n.d.».
//      Tras unas 10 consultas seguidas su firewall (Imperva/Incapsula) contesta una página HTML con código 200 en vez del JSON:
//      parsearBcrp() la detecta y devuelve null.
//   2. Respaldo si BCRP no da ningún valor: open.er-api.com/v6/latest/USD (mercado, gratis, sin llave; se actualiza una vez al día).
//   3. Si ninguna responde: se sigue con el ÚLTIMO valor guardado (la conversión nunca se queda sin tipo de cambio una vez que hubo uno).

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

export const PAR_USD = "USD/PEN"; // soles por 1 dólar
export const BCRP_SERIE = "PD04640PD";
export const FUENTE_BCRP = "BCRP · SBS venta";
export const FUENTE_RESPALDO = "open.er-api.com";
export const RESPALDO_URL = "https://open.er-api.com/v6/latest/USD";
/** Pasadas estas horas desde la última consulta se vuelve a pedir. */
export const VIGENCIA_HORAS = 6;
/** La primera vez (tabla vacía) se trae un año: los gastos viejos en dólares se convierten con el tipo de SU día. */
export const DIAS_HISTORIAL = 400;
/** Cuántos días antes del último valor guardado se vuelve a pedir (por si BCRP publicó o corrigió algo atrasado). */
export const DIAS_SOLAPE = 7;
const INTERVALO_MIN_MS = 5 * 60 * 1000; // dentro de una instancia, tras un intento no se insiste antes de esto

export type Punto = { fecha: string; valor: number };
export type Tasa = { par: string; fecha: string; valor: number; fuente: string; obtenido_en: string };
/** Lo mínimo para convertir: el valor y de qué día es. */
export type Cambio = { valor: number; fecha: string } | null | undefined;

const MESES: Record<string, number> = {
  ene: 1, jan: 1, feb: 2, mar: 3, abr: 4, apr: 4, may: 5, jun: 6, jul: 7, ago: 8, aug: 8, set: 9, sep: 9, oct: 10, nov: 11, dic: 12, dec: 12,
};
// Un dólar vale entre 1 y 20 soles: fuera de ahí es un dato roto, no un tipo de cambio.
const plausible = (n: number) => Number.isFinite(n) && n >= 1 && n <= 20;
const dos = (n: number) => String(n).padStart(2, "0");

export const urlBcrp = (desde: string, hasta: string) =>
  `https://estadisticas.bcrp.gob.pe/estadisticas/series/api/${BCRP_SERIE}/json/${desde}/${hasta}/esp`;

/**
 * El primer objeto JSON de un texto, ignorando lo que venga después. La API de BCRP a veces pega tras el JSON un aviso de PHP en HTML
 * («<br /><font size='1'><table class='xdebug-error…»), y con eso JSON.parse del texto entero falla aunque los datos estén bien.
 */
export function primerJson(texto: string): string | null {
  const ini = texto.indexOf("{");
  if (ini < 0) return null;
  let prof = 0, enTexto = false, escape = false;
  for (let i = ini; i < texto.length; i++) {
    const c = texto[i]!;
    if (enTexto) {
      if (escape) escape = false;
      else if (c === "\\") escape = true;
      else if (c === '"') enTexto = false;
    } else if (c === '"') enTexto = true;
    else if (c === "{") prof++;
    else if (c === "}" && --prof === 0) return texto.slice(ini, i + 1);
  }
  return null;
}

/** JSON de BCRP → puntos {fecha, valor}. null si no es el JSON de BCRP (p. ej. la página del firewall); [] si no trae valores. */
export function parsearBcrp(texto: string): Punto[] | null {
  let j: { periods?: unknown };
  try {
    j = JSON.parse(primerJson(texto) ?? "");
  } catch {
    return null;
  }
  if (!j || !Array.isArray(j.periods)) return null;
  const out: Punto[] = [];
  for (const p of j.periods as { name?: unknown; values?: unknown[] }[]) {
    const m = /^(\d{1,2})\.([A-Za-z]{3})\.(\d{2})$/.exec(String(p?.name ?? "")); // «07.Oct.26»; setiembre viene como «Set»
    const valor = Number(p?.values?.[0]); // «n.d.» → NaN
    const mes = m ? MESES[m[2]!.toLowerCase()] : undefined;
    if (!m || !mes || !plausible(valor)) continue;
    out.push({ fecha: `20${m[3]}-${dos(mes)}-${dos(Number(m[1]))}`, valor });
  }
  return out;
}

/** Respuesta de open.er-api.com → soles por dólar, o null. */
export function parsearRespaldo(j: unknown): number | null {
  const r = j as { result?: string; rates?: { PEN?: unknown } } | null;
  if (!r || r.result !== "success") return null;
  const v = Number(r.rates?.PEN);
  return plausible(v) ? v : null;
}

type Fetch = typeof fetch;
const TOPE_MS = 5000;
const PAUSA_REINTENTO_MS = 300;

/**
 * Puntos publicados entre dos fechas (AAAA-MM-DD). null si no hubo respuesta usable (red, firewall, error).
 * El firewall de BCRP es intermitente (la misma consulta da el JSON y un minuto después la página de desafío): se reintenta una vez.
 */
export async function traerBcrp(desde: string, hasta: string, f: Fetch = fetch, ms = TOPE_MS, intentos = 2): Promise<Punto[] | null> {
  for (let i = 0; i < intentos; i++) {
    if (i > 0) await new Promise((ok) => setTimeout(ok, PAUSA_REINTENTO_MS));
    try {
      const r = await f(urlBcrp(desde, hasta), { signal: AbortSignal.timeout(ms), headers: { Accept: "application/json" } });
      const puntos = r.ok ? parsearBcrp(await r.text()) : null;
      if (puntos) return puntos;
    } catch {
      // red caída o plazo vencido: se reintenta
    }
  }
  return null;
}

export async function traerRespaldo(f: Fetch = fetch, ms = TOPE_MS): Promise<number | null> {
  try {
    const r = await f(RESPALDO_URL, { signal: AbortSignal.timeout(ms), headers: { Accept: "application/json" } });
    return r.ok ? parsearRespaldo(await r.json()) : null;
  } catch {
    return null;
  }
}

export const restarDias = (iso: string, dias: number): string => new Date(Date.parse(`${iso}T00:00:00Z`) - dias * 86_400_000).toISOString().slice(0, 10);

// --------------------------------------------------------------------------------------------- conversión (pura)

export const redondear = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/** Monto en soles. PEN no cambia; USD se multiplica por el tipo de cambio; null si no se sabe convertir (sin tipo de cambio u otra moneda). */
export function aSoles(monto: number, moneda: string | null | undefined, tc: Cambio): number | null {
  const m = (moneda ?? "PEN").toUpperCase();
  if (m === "PEN") return monto;
  if (m === "USD" && tc && tc.valor > 0) return redondear(monto * tc.valor);
  return null;
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

export type CuentaSaldo = { account_type: string; currency_code?: string | null; current_balance?: number | string | null };
export type Patrimonio = {
  /** Todo en soles: lo de soles + los dólares convertidos. Las tarjetas de crédito restan (su saldo es deuda). */
  soles: number;
  /** Solo las cuentas en soles. */
  pen: number;
  /** Solo las cuentas en dólares, en dólares. */
  usd: number;
  /** Hay saldo en dólares. */
  hayUsd: boolean;
  /** Los dólares convertidos a soles; null si hay dólares y no hay tipo de cambio (entonces `soles` NO los incluye). */
  usdEnSoles: number | null;
  /** Hay cuentas en una moneda que no se convierte (ni PEN ni USD): no entran en `soles`. */
  otrasMonedas: boolean;
};

export function patrimonio(cuentas: CuentaSaldo[], tc: Cambio): Patrimonio {
  let pen = 0, usd = 0, otras = false;
  for (const c of cuentas) {
    const signo = c.account_type === "credit_card" ? -1 : 1;
    const saldo = signo * Number(c.current_balance ?? 0);
    const m = (c.currency_code ?? "PEN").toUpperCase();
    if (m === "PEN") pen += saldo;
    else if (m === "USD") usd += saldo;
    else otras = true;
  }
  pen = redondear(pen);
  usd = redondear(usd);
  const usdEnSoles = usd === 0 ? 0 : aSoles(usd, "USD", tc);
  return { soles: redondear(pen + (usdEnSoles ?? 0)), pen, usd, hayUsd: usd !== 0, usdEnSoles, otrasMonedas: otras };
}

/** «3.45»: el valor con hasta 3 decimales (la SBS publica 3) sin ceros de más. */
export const textoTc = (valor: number): string => String(Number(valor.toFixed(3)));

// --------------------------------------------------------------------------------------------- caché en fx_rates

// Lo único que se usa del cliente de Supabase: encadenar consultas. Tipado suelto a propósito para que lo cumplan los falsos de las pruebas.
export type Db = Pick<SupabaseClient, "from">;
const COLS = "par, fecha, valor, fuente, obtenido_en";

/** El valor más reciente guardado (por fecha). null si la tabla está vacía o no se pudo leer. */
export async function ultimaTasa(db: Db): Promise<Tasa | null> {
  const { data, error } = await db.from("fx_rates").select(COLS).eq("par", PAR_USD).order("fecha", { ascending: false }).limit(1);
  const f = data?.[0] as Record<string, unknown> | undefined;
  if (error || !f) return null;
  return { par: String(f.par), fecha: String(f.fecha), valor: Number(f.valor), fuente: String(f.fuente), obtenido_en: String(f.obtenido_en) };
}

/** Valores desde una fecha (para convertir un mes entero con el tipo de cambio de cada día). Incluye el último anterior a `desde`. */
export async function historial(db: Db, desde: string): Promise<Punto[]> {
  const [dentro, antes] = await Promise.all([
    db.from("fx_rates").select("fecha, valor").eq("par", PAR_USD).gte("fecha", desde).order("fecha", { ascending: true }),
    db.from("fx_rates").select("fecha, valor").eq("par", PAR_USD).lt("fecha", desde).order("fecha", { ascending: false }).limit(1),
  ]);
  const filas = [...(antes.data ?? []), ...(dentro.data ?? [])] as { fecha: unknown; valor: unknown }[];
  return filas.map((r) => ({ fecha: String(r.fecha), valor: Number(r.valor) })).filter((p) => plausible(p.valor));
}

/** ¿Hace falta volver a pedirlo? Sí si no hay nada guardado o la última consulta pasó de VIGENCIA_HORAS. */
export function hayQueRefrescar(ultima: Tasa | null, ahora: Date): boolean {
  if (!ultima) return true;
  const t = Date.parse(ultima.obtenido_en);
  return !Number.isFinite(t) || ahora.getTime() - t > VIGENCIA_HORAS * 3_600_000;
}

/**
 * Pide el tipo de cambio y lo guarda (upsert por par+fecha). `db` debe ser el cliente de SERVICIO: authenticated no escribe fx_rates.
 * BCRP primero; si no trae ningún valor, el respaldo (un solo valor, el de hoy). null si ninguna fuente respondió: queda lo guardado.
 */
export async function refrescar(db: Db, o: { ahora: Date; hoy: string; f?: Fetch }): Promise<{ fuente: string; filas: number } | null> {
  const ultima = await ultimaTasa(db);
  const desde = restarDias(ultima ? ultima.fecha : o.hoy, ultima ? DIAS_SOLAPE : DIAS_HISTORIAL);
  let puntos = await traerBcrp(desde, o.hoy, o.f);
  let fuente = FUENTE_BCRP;
  if (!puntos?.length) {
    const v = await traerRespaldo(o.f);
    if (v === null) return null;
    puntos = [{ fecha: o.hoy, valor: v }];
    fuente = FUENTE_RESPALDO;
  }
  const filas = puntos.map((p) => ({ par: PAR_USD, fecha: p.fecha, valor: p.valor, fuente, obtenido_en: o.ahora.toISOString() }));
  const { error } = await db.from("fx_rates").upsert(filas, { onConflict: "par,fecha" });
  return error ? null : { fuente, filas: filas.length };
}

let ultimoIntento = 0;
/** Solo para las pruebas. */
export const reiniciarIntentos = () => { ultimoIntento = 0; };

/**
 * El tipo de cambio vigente: lo guardado, refrescado si ya venció. Si el refresco falla se devuelve lo que había (nunca peor que antes).
 * Un intento fallido no se repite dentro de la misma instancia antes de 5 minutos (no se golpea a BCRP en cada pedido).
 */
export async function tipoCambioVigente(db: Db, o: { ahora: Date; hoy: string; f?: Fetch }): Promise<{ tasa: Tasa | null; actualizado: boolean }> {
  let tasa = await ultimaTasa(db);
  let actualizado = false;
  if (hayQueRefrescar(tasa, o.ahora) && o.ahora.getTime() - ultimoIntento > INTERVALO_MIN_MS) {
    ultimoIntento = o.ahora.getTime();
    if (await refrescar(db, o)) {
      tasa = await ultimaTasa(db);
      actualizado = true;
    }
  }
  return { tasa, actualizado };
}
