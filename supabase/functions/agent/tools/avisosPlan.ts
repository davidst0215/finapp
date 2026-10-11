// Recordatorios por voz: decidir CUÁNDO suena un aviso (fecha y hora de Lima), qué se dice y cuál recordatorio es el que David quiere
// cancelar. Todo puro y determinista (recibe `ahora`, no lee el reloj): se prueba sin red ni base. avisos.ts solo ejecuta el plan.
import { diaHablado, horaHablada } from "../../_shared/google/speech.ts";
import { addDays, limaDateTime, limaParts, parseTime } from "../../_shared/google/time.ts";
import { resolveDue } from "../../_shared/vault/fechas.ts";
import { corto } from "../../_shared/vault/speech.ts";
import type { ToolResult } from "../types.ts";

const str = (v: unknown) => (typeof v === "string" ? v : "");

/** Con solo el día ("recuérdame el jueves …") el aviso sale a esta hora. */
export const HORA_POR_DEFECTO = "09:00";
/** Un recordatorio más lejano que esto casi seguro es un error de fecha. */
export const MAX_DIAS = 366;
/** "en 5 días" se dice con fecha; "en N minutos" llega hasta una semana. */
export const MAX_MINUTOS = 7 * 24 * 60;
/** Tope de recordatorios pendientes (evita un bucle del modelo llenando la cola). */
export const MAX_PENDIENTES = 50;

export type PlanRecordatorio = {
  titulo: string;
  cuando: Date;
  /** Día y hora de Lima en que suena. */
  fecha: string;
  hora: string;
  /** Se pidió solo el día: sale a las 9:00. */
  horaPorDefecto: boolean;
  /** «mañana a las cinco de la tarde» / «en 20 minutos». */
  hablado: string;
};

const clarify = (message: string, voz?: string): { respuesta: ToolResult } => ({ respuesta: { action: "clarify", message, ...(voz ? { voz } : {}) } });

/** Una línea, sin controles ni marcado, con mayúscula inicial y sin punto final; máx. 120 (el límite de la bandeja). */
export function limpiarTitulo(s: unknown): string {
  const t = str(s).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/[`*_#<>{}[\]]/g, "").replace(/\s+/g, " ").trim().replace(/[.,;:!?¡¿\s]+$/u, "");
  const corte = t.length > 120 ? `${t.slice(0, 119).trimEnd()}…` : t;
  return corte ? corte[0]!.toUpperCase() + corte.slice(1) : "";
}

/** «en 20 minutos», «en una hora», «en 3 horas». */
export function enMinutosHablado(n: number): string {
  if (n === 1) return "en un minuto";
  if (n === 60) return "en una hora";
  if (n % 60 === 0 && n < 1440) return `en ${n / 60} horas`;
  if (n % 1440 === 0) return n === 1440 ? "en un día" : `en ${n / 1440} días`;
  return `en ${n} minutos`;
}

/**
 * Convierte lo que pidió el modelo (create_reminder) en un plan o en una pregunta.
 *  - `en_minutos` (sin hora; un día suelto se ignora): ahora + N minutos.
 *  - día y hora: esa hora de Lima ese día. Solo el día: 9:00. Solo la hora: hoy si aún no pasó; si ya pasó, mañana.
 *  - Un instante que ya pasó o a más de un año se pregunta, no se adivina.
 * `ahora` es el instante real (no el corrido −5 h del agente).
 */
export function planearRecordatorio(args: Record<string, unknown>, ctx: { ahora: Date }): { plan: PlanRecordatorio } | { respuesta: ToolResult } {
  const titulo = limpiarTitulo(args.text);
  if (!titulo) return { respuesta: { action: "error", message: "No entendí qué recordarte." } };

  const { ahora } = ctx;
  const hoy = limaParts(ahora).dateKey;
  const dueDicho = str(args.due).trim();
  const horaDicha = str(args.time).trim();
  const minutosDichos = args.en_minutos === undefined || args.en_minutos === null || args.en_minutos === "" ? null : Number(args.en_minutos);

  // Relativo: "en 20 minutos". Gana siempre que no haya una hora dicha, aunque el modelo mande también un día (a veces pone due: "hoy"):
  // «en 20 minutos» ya es un instante exacto y el día sobra. Si hay hora, manda la hora.
  if (minutosDichos !== null && !horaDicha) {
    const n = Math.round(minutosDichos);
    if (!Number.isFinite(n) || n < 1 || n > MAX_MINUTOS) return clarify("Dime en cuántos minutos, hasta una semana.");
    const cuando = new Date(ahora.getTime() + n * 60_000);
    const p = limaParts(cuando);
    return { plan: { titulo, cuando, fecha: p.dateKey, hora: p.hm, horaPorDefecto: false, hablado: enMinutosHablado(n) } };
  }

  let hora: string | null = null;
  if (horaDicha) {
    hora = parseTime(horaDicha);
    if (!hora) return clarify("No entendí la hora. Dímela como las cinco de la tarde.");
  }
  let fecha: string | null = null;
  if (dueDicho) {
    fecha = resolveDue(dueDicho, hoy);
    if (!fecha) return clarify(`No entendí la fecha «${corto(dueDicho, 30)}». Dímela como mañana, el viernes o el 15 de octubre.`);
  }
  if (!fecha && !hora) return clarify("¿Cuándo te aviso? Dime el día o la hora.", "¿Cuándo te aviso?");

  const horaPorDefecto = !hora;
  hora ??= HORA_POR_DEFECTO;
  fecha ??= new Date(limaDateTime(hoy, hora)) > ahora ? hoy : addDays(hoy, 1); // la hora sola es la próxima vez que llega

  const cuando = new Date(limaDateTime(fecha, hora));
  if (cuando <= ahora) {
    return fecha === hoy && horaPorDefecto
      ? clarify("Las nueve de hoy ya pasaron. ¿A qué hora te aviso?", "Las nueve ya pasaron. ¿A qué hora?")
      : clarify("Esa hora ya pasó. ¿Para cuándo te aviso?", "Esa hora ya pasó. ¿Para cuándo?");
  }
  if ((cuando.getTime() - ahora.getTime()) / 86_400_000 > MAX_DIAS) return clarify("Eso queda a más de un año. Dime una fecha más cercana.");

  return { plan: { titulo, cuando, fecha, hora, horaPorDefecto, hablado: `${diaHablado(fecha, hoy)} a ${horaHablada(hora)}` } };
}

// ---- Frases ----------------------------------------------------------------------------------------------------

/** Pantalla: con el título. Voz: solo cuándo (David acaba de decir qué). */
export function fraseCreado(plan: PlanRecordatorio, yaEstaba = false): { message: string; voz: string } {
  const base = yaEstaba ? "Ya lo tenía anotado" : "Hecho";
  return { message: `${base}. Te aviso ${plan.hablado}: «${corto(plan.titulo, 60)}».`, voz: `${base}, te aviso ${plan.hablado}.` };
}

export type FilaAviso = { aviso_id: string; titulo: string; cuando: string; origen?: string; tarea_texto?: string | null };

/** Cuándo suena una fila, hablado (día de Lima respecto de `ahora`). */
export function cuandoDeFila(f: Pick<FilaAviso, "cuando">, ahora: Date): string {
  const p = limaParts(new Date(f.cuando));
  return `${diaHablado(p.dateKey, limaParts(ahora).dateKey)} a ${horaHablada(p.hm)}`;
}

/** Pantalla: todos (hasta 10). Voz: cuántos y el próximo. */
export function fraseLista(filas: FilaAviso[], ahora: Date): { message: string; voz: string } {
  if (filas.length === 0) return { message: "No tienes recordatorios pendientes.", voz: "No tienes recordatorios pendientes." };
  const n = filas.length;
  const primero = filas[0]!;
  const detalle = filas.map((f) => `«${corto(f.titulo, 50)}» ${cuandoDeFila(f, ahora)}`).join("; ");
  const proximo = `${corto(primero.titulo, 30)}, ${cuandoDeFila(primero, ahora)}`;
  return {
    message: `Tienes ${n} ${n === 1 ? "recordatorio" : "recordatorios"}: ${detalle}.`,
    voz: n === 1 ? `Tienes uno: ${proximo}.` : `Tienes ${n}. El próximo: ${proximo}.`,
  };
}

// ---- Cancelar: ¿cuál recordatorio es? --------------------------------------------------------------------------

const sinTildes = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const VACIAS = new Set(["el", "la", "los", "las", "un", "una", "de", "del", "al", "a", "que", "para", "por", "con", "en", "mi", "mis", "me", "te", "lo", "se", "recordatorio", "recordatorios", "aviso", "avisos", "recuerdame", "avisame"]);

/** Palabras con contenido de un texto: sin tildes, sin artículos ni la palabra «recordatorio». */
export function palabrasClave(s: string): string[] {
  return sinTildes(s).split(/[^a-z0-9ñ]+/).filter((w) => w.length >= 2 && !VACIAS.has(w));
}

export type Busqueda = { kind: "none" } | { kind: "one"; fila: FilaAviso } | { kind: "many"; filas: FilaAviso[] };

/**
 * Elige el recordatorio de entre los pendientes. Sin palabras: si hay uno solo es ese; si hay varios, se pregunta.
 * Con palabras: gana el que las contiene TODAS; si ninguno, el único que contiene la mitad o más. Empates → se pregunta.
 */
export function buscarRecordatorio(search: unknown, filas: FilaAviso[]): Busqueda {
  if (filas.length === 0) return { kind: "none" };
  const quiere = palabrasClave(str(search));
  if (quiere.length === 0) return filas.length === 1 ? { kind: "one", fila: filas[0]! } : { kind: "many", filas };

  const puntaje = filas.map((fila) => {
    const texto = sinTildes(`${fila.titulo} ${fila.tarea_texto ?? ""}`);
    return { fila, aciertos: quiere.filter((w) => texto.includes(w)).length };
  });
  const todas = puntaje.filter((p) => p.aciertos === quiere.length);
  const elegidas = todas.length > 0 ? todas : puntaje.filter((p) => p.aciertos > 0 && p.aciertos >= quiere.length / 2);
  if (elegidas.length === 0) return { kind: "none" };
  if (elegidas.length === 1) return { kind: "one", fila: elegidas[0]!.fila };
  return { kind: "many", filas: elegidas.map((p) => p.fila) };
}

/** «¿Cuál: «Llamar a Marco» o «Revisar el simulador»?» */
export function preguntaCual(filas: FilaAviso[]): { message: string; voz: string } {
  const visibles = filas.slice(0, 4);
  const lista = visibles.map((f) => `«${corto(f.titulo, 40)}»`);
  const unidos = lista.length > 1 ? `${lista.slice(0, -1).join(", ")} o ${lista.at(-1)}` : lista[0]!;
  const mas = filas.length > visibles.length ? ` (y ${filas.length - visibles.length} más)` : "";
  return {
    message: `¿Cuál recordatorio: ${unidos}${mas}?`,
    voz: `¿Cuál: ${visibles.slice(0, 2).map((f) => corto(f.titulo, 24)).join(" o ")}?`,
  };
}

// ---- Recordatorio que acompaña a una tarea (create_task con «recuérdame») ---------------------------------------

/** El aviso de una tarea recién creada: su título es el de la tarea. `pasado` si esa hora ya pasó (no se programa nada). */
export function planDeTarea(
  texto: string, cuandoSuena: { fecha: string; hora: string; porDefecto: boolean }, ahora: Date,
): { plan: PlanRecordatorio } | { pasado: true } {
  const cuando = new Date(limaDateTime(cuandoSuena.fecha, cuandoSuena.hora));
  if (cuando <= ahora) return { pasado: true };
  const hoy = limaParts(ahora).dateKey;
  return {
    plan: {
      titulo: limpiarTitulo(texto) || "Tarea pendiente", cuando, fecha: cuandoSuena.fecha, hora: cuandoSuena.hora, horaPorDefecto: cuandoSuena.porDefecto,
      hablado: `${diaHablado(cuandoSuena.fecha, hoy)} a ${horaHablada(cuandoSuena.hora)}`,
    },
  };
}

/** Lo que se añade a la frase de «Anoté…»: la tarea ya dijo el día y la hora, así que aquí solo se confirma el aviso (salvo la hora por defecto). */
export function fraseAvisoTarea(plan: PlanRecordatorio, estado: "creado" | "repetido" | "lleno" | "error"): { message: string; voz: string } {
  if (estado === "lleno") return { message: ` Tienes ${MAX_PENDIENTES} recordatorios pendientes; no agregué el aviso.`, voz: " Tienes demasiados avisos pendientes." };
  if (estado === "error") return { message: " No pude programar el aviso.", voz: " No pude programar el aviso." };
  const a = plan.horaPorDefecto ? ` Te aviso a ${horaHablada(plan.hora)}.` : " Te aviso a esa hora.";
  return { message: a, voz: plan.horaPorDefecto ? a : " Te aviso." };
}
