// Agenda propia de Wabid por voz: guardar un contacto, encontrarlo por nombre ("Marco", "mi mamá", "Marco de Saya") y armar las
// frases. Misma filosofía que las cuentas (cuentas.ts) con una diferencia que importa: aquí un error manda un mensaje a OTRA
// persona, así que las palabras se comparan IGUALES (sin tildes ni mayúsculas) y nada más: «Juana» no es Juan, «Luisa» no es Luis,
// «Daniela» no es Daniel ni «Marcos» es Marco. Si hay dos candidatos se pregunta; si no hay ninguno se pide el número; nunca se
// adivina. Puro: sin globals de Deno (contactos.test.ts).
//
// PRIVACIDAD: lo que escribe este archivo para decir o mostrar (`message`, `voz`) vuelve al modelo en el historial del turno
// siguiente. Por eso ninguna frase lleva un teléfono, ni siquiera el que alguien guardó (o dictó) COMO nombre: eso se dice «ese
// número». El número solo viaja en la acción que recibe la app (tools/contactos.ts).
import { limpiarEspacios, norm } from "./texto.ts";
import { normalizarTelefono, numeroDelDictado } from "./telefono.ts";
import { cortoVoz, queCabe } from "./voz.ts";

export type Contacto = { contacto_id: string; nombre: string; alias: string[]; telefono: string; relacion: string | null };
export type ContactoNuevo = { nombre: string; alias: string[]; telefono: string; relacion: string | null };

// Los mismos topes que el esquema (018_contactos.sql) y que la web (apps/web/src/lib/contactos.ts).
export const MAX_NOMBRE = 100;
export const MAX_ALIAS = 10;
export const MAX_ALIAS_LARGO = 60;
export const MAX_RELACION = 100;
/**
 * Tope de contactos por usuario: 1000, el `max_rows` de PostgREST en producción. Así UNA lectura trae la agenda completa (un
 * `.limit(2000)` se recortaba en silencio a 1000). Lo hace cumplir un trigger de la base (018) y lo avisan la web y Wabid.
 */
export const MAX_CONTACTOS = 1000;

// Palabras que no distinguen a una persona de otra: "el contacto de Marco" = "Marco", "escríbele a mi mamá" = "mamá".
const RELLENO = new Set([
  "de", "del", "la", "el", "los", "las", "mi", "mis", "me", "a", "al", "con", "y", "un", "una", "por", "es", "ese", "esa",
  "contacto", "numero", "telefono", "celular", "whatsapp",
]);
export const palabrasContacto = (s: string): string[] => norm(s).split(" ").filter((t) => t && !RELLENO.has(t));

const mismasPalabras = (a: string[], b: string[]) => a.length > 0 && a.length === b.length && a.every((t) => b.includes(t));
/** Todas las palabras de la consulta están, IGUALES, en la bolsa. Sin prefijos ni plurales: «Juana» no cubre a «Juan». */
const cubreExacto = (consulta: string[], bolsa: string[]) => consulta.length > 0 && consulta.every((t) => bolsa.includes(t));

/** Mismas palabras (sin relleno) en cualquier orden: "Marco Roca" y "roca marco" son el mismo nombre. */
export const mismoNombre = (a: string, b: string): boolean => {
  const x = palabrasContacto(a);
  return x.length > 0 ? mismasPalabras(x, palabrasContacto(b)) : norm(a) === norm(b);
};

// --- Números que se cuelan como nombre ---------------------------------------------------------------------------------
/** ¿Trae 6 o más dígitos, con el separador que sea («999/888/777», «999_888_777»)? Un nombre así es un teléfono mal puesto: no se dice. */
export const tieneNumero = (s: string): boolean => (s.match(/\d/g) ?? []).length >= 6;
/**
 * El texto con cada tramo de 6 o más dígitos reemplazado por «[número]». Para frases que vuelven al modelo y repiten lo que David
 * escribió («llámame al 999 111 222»): el contenido se conserva, el teléfono no.
 */
export const enmascararNumeros = (s: string): string =>
  s.replace(/[+(]?\d[\d\s().,/_–—-]*/g, (tramo) => ((tramo.match(/\d/g) ?? []).length >= 6 ? `[número]${/[\s().,/_–—-]*$/.exec(tramo)![0]}` : tramo));
/** Lo que se puede decir o mostrar de un nombre: si trae un número, «ese número». */
export const nombreDecible = (s: string): string => (tieneNumero(s) ? "ese número" : s);
const relacionDecible = (r: string | null): string | null => (r && !tieneNumero(r) ? r : null);

/** "Marco" o "Marco (de Saya)": cómo se nombra un contacto para distinguirlo de otro. */
export const etiqueta = (c: Pick<Contacto, "nombre" | "relacion">): string => {
  const rel = relacionDecible(c.relacion);
  return rel ? `${nombreDecible(c.nombre)} (${rel})` : nombreDecible(c.nombre);
};

export type Busqueda =
  | { kind: "one"; contacto: Contacto }
  | { kind: "many"; contactos: Contacto[] }
  | { kind: "none" };

/**
 * Contacto que David nombró. Todas las palabras de lo dicho deben estar, iguales, en el nombre o en algún apodo ("mamá"). Si hay varios:
 * 1. la `pista` (la relación que David dijo al contestar «¿cuál?»: "el de Saya") se compara con la relación de cada uno;
 * 2. si queda más de uno gana el de nombre o apodo exacto ("Marco" antes que "Marco Roca");
 * 3. si sigue habiendo más de uno, se devuelven para preguntar.
 * Sin coincidencia por nombre, las palabras que sobran pueden ser la relación ("Marco Saya"), pero solo si al menos una
 * palabra es del nombre: "Saya" a secas no elige a nadie, y "Marco Gómez" no se carga al único Marco.
 * Si David dio una relación (`pista`: «Marco del gimnasio») y el ÚNICO candidato tiene otra, no es él: «none» y se pide el número.
 */
export function buscarContacto(consulta: unknown, contactos: Contacto[], pista?: unknown): Busqueda {
  const q = palabrasContacto(typeof consulta === "string" ? consulta : "");
  if (!q.length) return { kind: "none" };
  const bolsa = (c: Contacto) => [...palabrasContacto(c.nombre), ...c.alias.flatMap(palabrasContacto)];

  let c = contactos.filter((x) => cubreExacto(q, bolsa(x)));
  if (!c.length) {
    c = contactos.filter((x) => {
      const nombres = bolsa(x);
      return q.some((t) => nombres.includes(t)) && cubreExacto(q, [...nombres, ...palabrasContacto(x.relacion ?? "")]);
    });
  }
  const clave = palabrasContacto(typeof pista === "string" ? pista : "");
  if (c.length <= 1) {
    if (!c.length) return { kind: "none" };
    // La relación que David dijo debe estar en la del contacto; si no, es otra persona con el mismo nombre que no tengo.
    if (clave.length && !cubreExacto(clave, palabrasContacto(c[0]!.relacion ?? ""))) return { kind: "none" };
    return { kind: "one", contacto: c[0]! };
  }

  if (clave.length) {
    const porRelacion = c.filter((x) => cubreExacto(clave, palabrasContacto(x.relacion ?? "")));
    if (porRelacion.length) c = porRelacion;
  }
  if (c.length > 1) {
    const exactos = c.filter((x) => mismasPalabras(q, palabrasContacto(x.nombre)) || x.alias.some((a) => mismasPalabras(q, palabrasContacto(a))));
    if (exactos.length) c = exactos;
  }
  return c.length === 1 ? { kind: "one", contacto: c[0]! } : { kind: "many", contactos: c };
}

// --- Entradas ---------------------------------------------------------------------------------------------------------
const str = (v: unknown) => (typeof v === "string" ? limpiarEspacios(v) : "");

/** "es de Saya." → "de Saya": la relación se guarda como una nota corta, sin el verbo con que David la dijo. */
export const limpiarRelacion = (v: unknown): string => str(v).replace(/^(?:es|son|era|eran)\s+/i, "").replace(/[.\s]+$/, "");

/** Apodos: lista o texto con comas. Sin repetidos, sin el propio nombre y sin vacíos. */
export function limpiarAlias(v: unknown, nombre: string): string[] {
  const crudos = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : [];
  const vistos = new Set([norm(nombre)]);
  const salida: string[] = [];
  for (const a of crudos) {
    const t = str(a);
    const k = norm(t);
    if (!t || !k || vistos.has(k)) continue;
    vistos.add(k);
    salida.push(t);
  }
  return salida;
}

export type ValidacionContacto =
  | { ok: true; contacto: ContactoNuevo }
  | { ok: false; error: string; pregunta?: boolean; duplicado?: Contacto };

/**
 * Valida lo que dictó David antes de tocar la base. Lo que se puede preguntar es `pregunta` (falta el nombre o el número, o
 * hay más de un número en lo dicho); lo demás es un error con una frase para decir. El teléfono que mandó el modelo tiene que
 * ser EL que David dictó (numeroDelDictado): en su mensaje `actual` o, si ese no trae ninguno, en el turno anterior más reciente
 * que sí lo traiga (`anteriores`), porque aquí el número pudo venir antes de aclarar la relación («¿quién es este Marco?» →
 * «es del gimnasio»). Con dos teléfonos distintos en lo dicho se pide confirmación en vez de elegir uno.
 */
export function validarContactoNuevo(args: Record<string, unknown>, existentes: Contacto[], actual: string, anteriores: readonly string[] = []): ValidacionContacto {
  const nombre = str(args.nombre);
  if (!nombre) return { ok: false, error: "¿Cómo se llama?", pregunta: true };
  if (nombre.length > MAX_NOMBRE) return { ok: false, error: `El nombre es muy largo: máximo ${MAX_NOMBRE} letras.` };
  if (!/\p{L}/u.test(nombre)) return { ok: false, error: "El nombre necesita letras." };
  if (tieneNumero(nombre)) return { ok: false, error: "El nombre no puede ser un número. ¿Cómo se llama?", pregunta: true };

  const tel = normalizarTelefono(args.telefono);
  if (!tel.ok) return { ok: false, error: tel.error, pregunta: tel.error === "¿Cuál es su número?" };
  const dictado = numeroDelDictado(tel.e164, actual, anteriores);
  if (!dictado.ok) {
    return dictado.motivo === "varios"
      ? { ok: false, pregunta: true, error: "Veo más de un número en lo que dijiste. Dime el nombre y el número de uno en uno." }
      : { ok: false, error: "No estoy segura del número que entendí. Dímelo otra vez, dígito por dígito." };
  }

  const relacion = limpiarRelacion(args.relacion);
  if (relacion.length > MAX_RELACION) return { ok: false, error: `La relación es muy larga: máximo ${MAX_RELACION} letras.` };
  if (tieneNumero(relacion)) return { ok: false, error: "La relación no puede llevar un número. ¿Quién es?", pregunta: true };
  const alias = limpiarAlias(args.alias, nombre);
  if (alias.length > MAX_ALIAS || alias.some((a) => a.length > MAX_ALIAS_LARGO)) {
    return { ok: false, error: `Máximo ${MAX_ALIAS} apodos, de ${MAX_ALIAS_LARGO} letras cada uno.` };
  }
  if (alias.some(tieneNumero)) return { ok: false, error: "Un apodo no puede ser un número." };

  if (existentes.length >= MAX_CONTACTOS) return { ok: false, error: `Llegaste al límite de ${MAX_CONTACTOS} contactos. Borra alguno desde Contactos.` };
  const mismoNumero = existentes.find((c) => c.telefono === tel.e164);
  if (mismoNumero) return { ok: false, error: `Ya tienes ese número guardado como ${etiqueta(mismoNumero)}.`, duplicado: mismoNumero };

  // Dos personas con el mismo nombre solo se distinguen por su relación: sin ella, «Marco» sería una pregunta sin respuesta.
  const homonimos = existentes.filter((c) => mismoNombre(c.nombre, nombre));
  if (homonimos.length) {
    if (!relacion) {
      return { ok: false, pregunta: true, error: `Ya tienes a ${etiqueta(homonimos[0]!)}. ¿Quién es este ${nombre}? Dime su relación, por ejemplo «del gimnasio».` };
    }
    const igual = homonimos.find((c) => norm(c.relacion ?? "") === norm(relacion));
    if (igual) return { ok: false, error: `Ya tienes a ${etiqueta(igual)} con otro número. Cámbialo desde Contactos.`, duplicado: igual };
  }

  return { ok: true, contacto: { nombre, alias, telefono: tel.e164, relacion: relacion || null } };
}

// Firma de Wabid en la MISMA línea del mensaje: «… — Wabid», «… (Wabid)», «… [Wabid]», «… | Wabid», «… ~ Wabid», «… - Wabid ✅»,
// «…, enviado por Wabid». Pide delante un guion, «|», «~», un paréntesis o corchete, o «enviado por»: una mención normal («prueba
// Wabid, la app») se respeta. Detrás admite el cierre, puntuación y emojis.
const FIRMA_AL_FINAL = /\s*(?:[-–—]+\s*|[|~]\s*|[(\[]\s*(?:(?:enviado|escrito)\s+por\s+|de parte de\s+)?|,?\s*(?:enviado|escrito)\s+por\s+|de parte de\s+)(?:wabid|tu asistente|la asistente|asistente de david)\s*[)\]]?[\s.!\p{Extended_Pictographic}️‍]*$/iu;
// Una línea que es solo la firma: «— Wabid», «Wabid», «[Wabid]», «Atentamente, Wabid ✅».
const FIRMA_EN_SU_LINEA = /^[\s\-–—_~*|(\[]*(?:(?:enviado|escrito|mensaje)\s+(?:por|de)|de parte de|atte\.?|atentamente|saludos)?[\s,:]*(?:wabid|tu asistente|la asistente|asistente de david)[\s.!)\]*\p{Extended_Pictographic}️‍]*$/iu;
const ENTRE_COMILLAS = /^[«“"]([^«»“”"]*)[»”"]$/;

/** Quita las líneas finales que son solo la firma y la firma que cierra la última línea. */
function sinFirma(texto: string): string {
  const lineas = texto.split("\n").map((l) => l.replace(/[ \t]+$/, ""));
  for (;;) {
    const ultima = lineas.at(-1);
    if (ultima === undefined) break;
    if (!ultima.trim() || FIRMA_EN_SU_LINEA.test(ultima)) { lineas.pop(); continue; }
    const limpia = ultima.replace(FIRMA_AL_FINAL, "");
    if (limpia === ultima) break;
    lineas[lineas.length - 1] = limpia.replace(/[ \t]+$/, "");
  }
  return lineas.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * El mensaje tal como lo enviaría David. Quita los saltos y caracteres de control, las comillas con que el modelo suele
 * envolverlo y la firma de Wabid, en su propia línea o al final de la última: Wabid no firma. La firma puede ir dentro o fuera de
 * las comillas («"Llego tarde — Wabid"», «"Llego tarde" — Wabid»), así que se repite hasta que no quede nada por quitar.
 * No agrega ni cambia palabras: que el texto sea fiel a lo que David dijo es trabajo de la tool (su descripción y sus reglas).
 */
export function limpiarMensaje(v: unknown): string {
  if (typeof v !== "string") return "";
  let t = v.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  for (let vuelta = 0; vuelta < 4; vuelta++) {
    const antes = t;
    t = sinFirma(t);
    const envuelto = ENTRE_COMILLAS.exec(t);
    if (envuelto) t = envuelto[1]!.trim();
    if (t === antes) break;
  }
  return t;
}

// --- Frases (pantalla y voz) -------------------------------------------------------------------------------------------
const corto = (s: string, max = 28) => cortoVoz(s, max);

export type Frase = { message: string; voz: string };

/** «¿Cuál?» cuando hay varios: «Marco (de Saya)» o «Marco (del gimnasio)». Sin teléfonos. */
export function preguntaCual(candidatos: Contacto[]): Frase {
  const cs = candidatos.map((c) => ({ ...c, nombre: nombreDecible(c.nombre), relacion: relacionDecible(c.relacion) }));
  const lista = cs.slice(0, 4);
  const mas = cs.length - lista.length;
  const etiquetas = lista.map(etiqueta);
  const juntas = (xs: string[], o = " y ") => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")}${o}${xs.at(-1)}` : (xs[0] ?? ""));
  const todasIguales = new Set(etiquetas.map(norm)).size < etiquetas.length;
  if (todasIguales) {
    const n = corto(cs[0]!.nombre);
    return {
      message: `Tienes ${cs.length} contactos llamados ${cs[0]!.nombre} y no los distingo. Ponle una relación a uno en Contactos.`,
      voz: queCabe([`Tienes ${cs.length} ${n} y no los distingo. Cámbialos en Contactos.`, `Tengo varios iguales. Cámbialos en Contactos.`]),
    };
  }
  const message = `Tengo a ${juntas(etiquetas)}${mas > 0 ? ` y ${mas} más` : ""}. ¿Cuál?`;
  const mismoNombreTodos = lista.every((c) => mismoNombre(c.nombre, lista[0]!.nombre)) && lista.every((c) => c.relacion);
  const opciones = mismoNombreTodos ? lista.map((c) => c.relacion!) : lista.map((c) => c.nombre);
  const cabeza = mismoNombreTodos ? `¿Cuál ${corto(lista[0]!.nombre)}: ` : "¿Cuál: ";
  return {
    message,
    voz: queCabe([
      `${cabeza}${juntas(opciones.map((o) => corto(o, 22)), " o ")}${mas > 0 ? " u otro" : ""}?`,
      `${cabeza}${juntas(opciones.slice(0, 2).map((o) => corto(o, 18)), " o ")}, u otro?`,
      "Tengo varios con ese nombre. ¿Cuál?",
    ]),
  };
}

export type Gestion = "buscar" | "escribir" | "llamar";
/** Sin coincidencia: se pide el número en vez de adivinar. Si lo dicho ya era un número, no se repite: «ese número». */
export function frasesNoEsta(nombre: string, para: Gestion): Frase {
  const pide = para === "buscar" ? "Si me dices su número, lo anoto." : para === "escribir" ? "Dime su número y te dejo el WhatsApp." : "Dime su número y te dejo la llamada.";
  const corta = para === "buscar" ? "¿Me dices su número?" : "Dime su número.";
  if (tieneNumero(nombre)) {
    return {
      message: `No encontré ese número en tus contactos. ${pide}`,
      voz: queCabe([`No encontré ese número en tus contactos. ${pide}`, `No encontré ese número. ${corta}`]),
    };
  }
  const n = nombre || "esa persona";
  return {
    message: `No tengo a ${n} guardado. ${pide}`,
    voz: queCabe([`No tengo a ${corto(n)} guardado. ${pide}`, `No tengo a ${corto(n)}. ${corta}`, `No lo tengo guardado. ${corta}`]),
  };
}

export const fraseCreado = (c: Pick<ContactoNuevo, "nombre" | "relacion">): Frase => ({
  message: `Guardé a ${etiqueta(c)}.`,
  voz: queCabe([`Listo, guardé a ${corto(nombreDecible(c.nombre))}.`, "Listo, lo guardé."]),
});

/**
 * El mensaje se muestra entre comillas para que el modelo sepa qué escribió (por si David pide cambiarlo), pero sin teléfonos:
 * lo que David dijo como contenido («llámame al 999 111 222») vuelve al historial como «llámame al [número]». La tarjeta de la
 * app lleva el texto completo en `accion.texto`.
 */
export const fraseWhatsapp = (nombre: string, texto: string): Frase => {
  const n = nombreDecible(nombre);
  return {
    message: texto ? `WhatsApp para ${n}: «${enmascararNumeros(texto)}»` : `Chat de WhatsApp con ${n}.`,
    voz: queCabe([`Listo, te dejo el WhatsApp de ${corto(n)}.`, "Listo, te dejo el WhatsApp."]),
  };
};

export const fraseLlamar = (nombre: string): Frase => {
  const n = nombreDecible(nombre);
  return { message: `Llamar a ${n}.`, voz: queCabe([`Listo, toca para llamar a ${corto(n)}.`, "Listo, toca para llamar."]) };
};

/** Sin el número: va en la tarjeta de la pantalla, no en la frase (que vuelve al modelo en el historial). */
export const fraseNumero = (c: Pick<Contacto, "nombre" | "relacion">): Frase => ({
  message: `Aquí está el contacto de ${etiqueta(c)}.`,
  voz: queCabe([`Te dejo el número de ${corto(nombreDecible(c.nombre))} en pantalla.`, "Te dejo el número en pantalla."]),
});
