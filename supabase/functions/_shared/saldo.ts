// Saldo de IA de Wabid: lo que queda en OpenRouter (modelo) y el consumo de ElevenLabs (voz).
// Lógica pura, sin globals de Deno: se prueba con Node (saldo.test.ts). Las llaves nunca salen de aquí:
// el resultado solo trae números y mensajes cortos, jamás la llave ni el cuerpo crudo de un tercero.
import { palabras } from "./voz.ts";

/** Debajo de este restante (US$) la app lo marca como alerta y la voz aconseja recargar. */
export const UMBRAL_BAJO_USD = 2;
const DIAS_MAX = 365; // más allá se dice "más de 12 meses"

/** Respuesta cruda de un tercero: `null` = no hubo respuesta (red, tiempo agotado). */
export type Cruda = { status: number; cuerpo: unknown } | null;

export type Proyeccion = { tipo: "dias"; dias: number } | { tipo: "mas_de_12_meses" } | { tipo: "agotado" };

export type SaldoOpenRouter =
  | {
    estado: "ok";
    restante: number;
    credito: number;
    usado: number;
    hoy: number;
    semana: number;
    mes: number;
    proyeccion: Proyeccion;
  }
  | { estado: "error"; mensaje: string };

export type SaldoVoz =
  | { estado: "ok"; usados: number; limite: number; renueva: string | null; plan: string | null }
  | { estado: "sin_permiso"; mensaje: string }
  | { estado: "sin_configurar"; mensaje: string }
  | { estado: "error"; mensaje: string };

export type Saldo = { openrouter: SaldoOpenRouter; elevenlabs: SaldoVoz; actualizado: string };

export const MSG_SIN_PERMISO = "Voz: activa el permiso 'User → Read' de la API key en ElevenLabs para ver el consumo";

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? v as Record<string, unknown> : {});
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

const DIA_MS = 86_400_000;

/**
 * Gasto diario estimado. `usage_weekly` y `usage_monthly` de OpenRouter son de la semana (desde el lunes) y del mes
 * calendario en UTC (https://openrouter.ai/docs/api-reference/limits), no de los últimos 7 o 30 días: se divide cada
 * uno entre los días transcurridos de su periodo (completos + fracción de hoy, mínimo 1 para que el primer rato del
 * día no dispare la cifra) y se toma el mayor, que es el estimado conservador.
 */
export function ritmoDiario(semana: number, mes: number, ahora: Date): number {
  const fraccionHoy = (ahora.getUTCHours() * 3600 + ahora.getUTCMinutes() * 60 + ahora.getUTCSeconds()) * 1000 / DIA_MS;
  const diasSemana = Math.max(1, (ahora.getUTCDay() + 6) % 7 + fraccionHoy); // lunes = 0
  const diasMes = Math.max(1, ahora.getUTCDate() - 1 + fraccionHoy);
  return Math.max(semana / diasSemana, mes / diasMes);
}

/** Días que alcanza el saldo al ritmo diario dado. Sin ritmo, o más de un año: "más de 12 meses". */
export function proyectar(restante: number, porDia: number): Proyeccion {
  if (!(restante > 0)) return { tipo: "agotado" };
  if (!(porDia > 0)) return { tipo: "mas_de_12_meses" };
  const dias = restante / porDia;
  return dias > DIAS_MAX ? { tipo: "mas_de_12_meses" } : { tipo: "dias", dias: Math.floor(dias) };
}

function errorOpenRouter(r: Cruda): string | null {
  if (!r) return "OpenRouter no respondió";
  if (r.status === 401 || r.status === 403) return "OpenRouter rechazó la llave";
  if (r.status === 429) return "OpenRouter pidió esperar un momento";
  if (r.status < 200 || r.status >= 300) return "OpenRouter respondió con un error";
  return null;
}

/**
 * `key` = GET /api/v1/key (tope y consumo de esta llave); `credits` = GET /api/v1/credits (cuenta).
 * Lo disponible es el menor de los dos topes: el que se acabe primero corta el servicio. Si solo
 * responde uno se usa ese; si ninguno, error.
 */
export function mapearOpenRouter(key: Cruda, credits: Cruda, ahora: Date = new Date()): SaldoOpenRouter {
  const dk = errorOpenRouter(key) === null ? obj(obj(key?.cuerpo).data) : null;
  const dc = errorOpenRouter(credits) === null ? obj(obj(credits?.cuerpo).data) : null;

  // Cada tope: restante y total. La llave sin límite (limit null) no aporta tope.
  const topes: { restante: number; total: number }[] = [];
  if (dk) {
    const limite = num(dk.limit), restante = num(dk.limit_remaining);
    if (limite !== null && restante !== null) topes.push({ restante, total: limite });
  }
  if (dc) {
    const total = num(dc.total_credits), usado = num(dc.total_usage);
    if (total !== null && usado !== null) topes.push({ restante: total - usado, total });
  }
  if (topes.length === 0) {
    return { estado: "error", mensaje: errorOpenRouter(key) ?? errorOpenRouter(credits) ?? "OpenRouter respondió datos que no entiendo" };
  }
  const tope = topes.reduce((a, b) => (b.restante < a.restante ? b : a));

  const semana = num(dk?.usage_weekly) ?? 0, mes = num(dk?.usage_monthly) ?? 0;
  const restante = Math.max(0, Math.round(tope.restante * 10000) / 10000);
  return {
    estado: "ok",
    restante,
    credito: tope.total,
    usado: num(dk?.usage) ?? (dc ? num(dc.total_usage) ?? 0 : 0),
    hoy: num(dk?.usage_daily) ?? 0,
    semana,
    mes,
    proyeccion: proyectar(restante, ritmoDiario(semana, mes, ahora)),
  };
}

/** `null` = sin llave configurada. 401 `missing_permissions` = la llave existe pero no puede leer el usuario. */
export function mapearElevenLabs(r: Cruda | "sin_configurar"): SaldoVoz {
  if (r === "sin_configurar") return { estado: "sin_configurar", mensaje: "Voz: falta la API key de ElevenLabs" };
  if (!r) return { estado: "error", mensaje: "ElevenLabs no respondió" };
  if (r.status === 401) {
    const detalle = obj(obj(r.cuerpo).detail);
    return detalle.status === "missing_permissions"
      ? { estado: "sin_permiso", mensaje: MSG_SIN_PERMISO }
      : { estado: "error", mensaje: "ElevenLabs rechazó la llave" };
  }
  if (r.status === 429) return { estado: "error", mensaje: "ElevenLabs pidió esperar un momento" };
  if (r.status < 200 || r.status >= 300) return { estado: "error", mensaje: "ElevenLabs respondió con un error" };

  const c = obj(r.cuerpo);
  const usados = num(c.character_count), limite = num(c.character_limit);
  if (usados === null || limite === null) return { estado: "error", mensaje: "ElevenLabs respondió datos que no entiendo" };
  const reinicio = num(c.next_character_count_reset_unix);
  return {
    estado: "ok",
    usados,
    limite,
    renueva: reinicio !== null && reinicio > 0 ? new Date(reinicio * 1000).toISOString() : null,
    plan: typeof c.tier === "string" ? c.tier : null,
  };
}

export type Llaves = { openrouter?: string; elevenlabs?: string };
type Pedir = (url: string, llave: { cabecera: string; valor: string }) => Promise<Cruda>;

/** Tres GET de consulta en paralelo; ninguno gasta crédito. `pedir` aísla la red (y las llaves) para probar. */
export async function consultarSaldo(llaves: Llaves, pedir: Pedir, ahora: Date = new Date()): Promise<Saldo> {
  const or = llaves.openrouter ? { cabecera: "Authorization", valor: `Bearer ${llaves.openrouter}` } : null;
  const el = llaves.elevenlabs ? { cabecera: "xi-api-key", valor: llaves.elevenlabs } : null;
  const [key, credits, voz] = await Promise.all([
    or ? pedir("https://openrouter.ai/api/v1/key", or) : null,
    or ? pedir("https://openrouter.ai/api/v1/credits", or) : null,
    el ? pedir("https://api.elevenlabs.io/v1/user/subscription", el) : null,
  ]);
  return {
    openrouter: or ? mapearOpenRouter(key, credits, ahora) : { estado: "error", mensaje: "Falta la API key de OpenRouter" },
    elevenlabs: mapearElevenLabs(el ? voz : "sin_configurar"),
    actualizado: ahora.toISOString(),
  };
}

/** Caché en memoria de un valor asíncrono: pedidos concurrentes comparten la misma consulta; los fallos no se guardan. */
export function conCache<T>(cargar: () => Promise<T>, vigente: (v: T) => boolean, ttlMs: number, reloj: () => number = Date.now) {
  let guardado: { en: number; valor: T } | null = null;
  let enCurso: Promise<T> | null = null;
  return (): Promise<T> => {
    if (guardado && reloj() - guardado.en < ttlMs) return Promise.resolve(guardado.valor);
    enCurso ??= cargar().then((valor) => {
      if (vigente(valor)) guardado = { en: reloj(), valor };
      return valor;
    }).finally(() => {
      enCurso = null;
    });
    return enCurso;
  };
}

/** Se guarda en caché si algo salió bien: un error pasajero no debe quedar fijo 60 s. */
export const saldoVigente = (s: Saldo) => s.openrouter.estado === "ok";

// --- Frase para la voz ---------------------------------------------------------------------------------------------

export const usd = (n: number) => `US$ ${n.toFixed(2)}`;

/** "unos nueve meses", "unos once días". Los números van en palabras: la voz los lee igual y el texto queda limpio. */
export function duracion(dias: number): string {
  if (dias < 30) return dias <= 1 ? "un día" : `unos ${palabras(dias)} días`;
  const meses = Math.round(dias / 30);
  return meses === 1 ? "un mes" : `unos ${palabras(meses)} meses`;
}

/** Respuesta hablada corta. Montos en cifras con formato US$ 9.73: el sistema los convierte a palabras. */
export function mensajeVoz(s: Saldo): string {
  const o = s.openrouter;
  if (o.estado !== "ok") return "No pude consultar tu saldo de OpenRouter ahora. Inténtalo en un momento.";

  let frase: string;
  if (o.proyeccion.tipo === "agotado") frase = "Se te acabó el saldo de OpenRouter.";
  else {
    const alcance = o.proyeccion.tipo === "dias" ? `te alcanza para ${duracion(o.proyeccion.dias)}` : "te dura más de doce meses";
    frase = `Te quedan ${usd(o.restante)} en OpenRouter; a este ritmo ${alcance}.`;
  }
  frase += ` Hoy llevas ${usd(o.hoy)} y este mes ${usd(o.mes)}.`;
  if (o.restante < UMBRAL_BAJO_USD) frase += " Conviene recargar pronto.";
  if (s.elevenlabs.estado === "ok") {
    const v = s.elevenlabs;
    frase += ` En voz usaste ${v.usados} de ${v.limite} caracteres.`;
  }
  return frase;
}
