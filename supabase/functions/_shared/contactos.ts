// Agenda propia de Wabid por voz: guardar un contacto, encontrarlo por nombre aproximado ("Marco", "mi mamá", "Marco de Saya")
// y armar las frases. Misma filosofía que las cuentas (cuentas.ts): tolera tildes, mayúsculas, plurales y relleno; si hay dos
// candidatos se pregunta; si no hay ninguno se pide el número; nunca se adivina. Puro: sin globals de Deno (contactos.test.ts).
//
// PRIVACIDAD: lo que escribe este archivo para decir o mostrar (`message`, `voz`) vuelve al modelo en el historial del turno
// siguiente. Por eso ninguna frase lleva un teléfono; el número solo viaja en la acción que recibe la app (tools/contactos.ts).
import { cubre, norm } from "./texto.ts";
import { coincideConDictado, normalizarTelefono } from "./telefono.ts";
import { cortoVoz, paraVoz, VOZ_MAX } from "./voz.ts";

export type Contacto = { contacto_id: string; nombre: string; alias: string[]; telefono: string; relacion: string | null };
export type ContactoNuevo = { nombre: string; alias: string[]; telefono: string; relacion: string | null };

// Los mismos topes que el esquema (018_contactos.sql).
export const MAX_NOMBRE = 100;
export const MAX_ALIAS = 10;
export const MAX_ALIAS_LARGO = 60;
export const MAX_RELACION = 100;
export const MAX_CONTACTOS = 1000;

// Palabras que no distinguen a una persona de otra: "el contacto de Marco" = "Marco", "escríbele a mi mamá" = "mamá".
const RELLENO = new Set([
  "de", "del", "la", "el", "los", "las", "mi", "mis", "me", "a", "al", "con", "y", "un", "una", "por", "es", "ese", "esa",
  "contacto", "numero", "telefono", "celular", "whatsapp",
]);
export const palabrasContacto = (s: string): string[] => norm(s).split(" ").filter((t) => t && !RELLENO.has(t));

const mismasPalabras = (a: string[], b: string[]) => a.length > 0 && a.length === b.length && a.every((t) => b.includes(t));

/** Mismas palabras (sin relleno) en cualquier orden: "Marco Roca" y "roca marco" son el mismo nombre. */
export const mismoNombre = (a: string, b: string): boolean => {
  const x = palabrasContacto(a);
  return x.length > 0 ? mismasPalabras(x, palabrasContacto(b)) : norm(a) === norm(b);
};

/** "Marco" o "Marco (de Saya)": cómo se nombra un contacto para distinguirlo de otro. */
export const etiqueta = (c: Pick<Contacto, "nombre" | "relacion">): string => (c.relacion ? `${c.nombre} (${c.relacion})` : c.nombre);

export type Busqueda =
  | { kind: "one"; contacto: Contacto }
  | { kind: "many"; contactos: Contacto[] }
  | { kind: "none" };

/**
 * Contacto que David nombró. Todas las palabras de lo dicho deben estar en el nombre o en algún apodo ("mamá"). Si hay varios:
 * 1. la `pista` (la relación que David dijo al contestar «¿cuál?»: "el de Saya") se compara con la relación de cada uno;
 * 2. si queda más de uno gana el de nombre o apodo exacto ("Marco" antes que "Marco Roca");
 * 3. si sigue habiendo más de uno, se devuelven para preguntar.
 * Sin coincidencia por nombre, las palabras que sobran pueden ser la relación ("Marco Saya"), pero solo si al menos una
 * palabra es del nombre: "Saya" a secas no elige a nadie, y "Marco Gómez" no se carga al único Marco.
 */
export function buscarContacto(consulta: unknown, contactos: Contacto[], pista?: unknown): Busqueda {
  const q = palabrasContacto(typeof consulta === "string" ? consulta : "");
  if (!q.length) return { kind: "none" };
  const bolsa = (c: Contacto) => [...palabrasContacto(c.nombre), ...c.alias.flatMap(palabrasContacto)];

  let c = contactos.filter((x) => cubre(q, bolsa(x)));
  if (!c.length) {
    c = contactos.filter((x) => {
      const nombres = bolsa(x);
      return q.some((t) => nombres.includes(t)) && cubre(q, [...nombres, ...palabrasContacto(x.relacion ?? "")]);
    });
  }
  if (c.length <= 1) return c.length ? { kind: "one", contacto: c[0]! } : { kind: "none" };

  const clave = palabrasContacto(typeof pista === "string" ? pista : "");
  if (clave.length) {
    const porRelacion = c.filter((x) => cubre(clave, palabrasContacto(x.relacion ?? "")));
    if (porRelacion.length) c = porRelacion;
  }
  if (c.length > 1) {
    const exactos = c.filter((x) => mismasPalabras(q, palabrasContacto(x.nombre)) || x.alias.some((a) => mismasPalabras(q, palabrasContacto(a))));
    if (exactos.length) c = exactos;
  }
  return c.length === 1 ? { kind: "one", contacto: c[0]! } : { kind: "many", contactos: c };
}

// --- Entradas ---------------------------------------------------------------------------------------------------------
const sinControl = (s: string) => s.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
const str = (v: unknown) => (typeof v === "string" ? sinControl(v) : "");

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
 * Valida lo que dictó David antes de tocar la base. `dictado` es lo que David dijo en este turno: el teléfono que mandó el
 * modelo tiene que ser el que aparece ahí (un dígito de más o de menos mandaría los mensajes a un desconocido). Lo que se
 * puede preguntar es `pregunta` (falta el nombre o el número); lo demás es un error con una frase para decir.
 * `dictado` junta lo de este turno y lo que David dijo antes (el número pudo venir en un turno anterior).
 */
export function validarContactoNuevo(args: Record<string, unknown>, existentes: Contacto[], dictado: string): ValidacionContacto {
  const nombre = str(args.nombre);
  if (!nombre) return { ok: false, error: "¿Cómo se llama?", pregunta: true };
  if (nombre.length > MAX_NOMBRE) return { ok: false, error: `El nombre es muy largo: máximo ${MAX_NOMBRE} letras.` };
  if (!/\p{L}/u.test(nombre)) return { ok: false, error: "El nombre necesita letras." };

  const tel = normalizarTelefono(args.telefono);
  if (!tel.ok) return { ok: false, error: tel.error, pregunta: tel.error === "¿Cuál es su número?" };
  if (!coincideConDictado(tel.e164, dictado)) return { ok: false, error: "No estoy segura del número que entendí. Dímelo otra vez, dígito por dígito." };

  const relacion = limpiarRelacion(args.relacion);
  if (relacion.length > MAX_RELACION) return { ok: false, error: `La relación es muy larga: máximo ${MAX_RELACION} letras.` };
  const alias = limpiarAlias(args.alias, nombre);
  if (alias.length > MAX_ALIAS || alias.some((a) => a.length > MAX_ALIAS_LARGO)) {
    return { ok: false, error: `Máximo ${MAX_ALIAS} apodos, de ${MAX_ALIAS_LARGO} letras cada uno.` };
  }

  if (existentes.length >= MAX_CONTACTOS) return { ok: false, error: "Ya tienes demasiados contactos guardados." };
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

/**
 * El mensaje tal como lo enviaría David. Quita los saltos y caracteres de control, las comillas con que el modelo suele
 * envolverlo y la firma de Wabid si la puso en una línea propia ("— Wabid", "Enviado por Wabid"): Wabid no firma.
 */
export function limpiarMensaje(v: unknown): string {
  if (typeof v !== "string") return "";
  let t = v.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  const lineas = t.split("\n").map((l) => l.replace(/[ \t]+$/, ""));
  const FIRMA = /^[\s\-–—_~*(\[]*(?:(?:enviado|escrito|mensaje)\s+(?:por|de)|de parte de|atte\.?|atentamente|saludos)?[\s,:]*(?:wabid|tu asistente|la asistente|asistente de david)[\s.!)\]*]*$/i;
  while (lineas.length && (!lineas.at(-1)!.trim() || FIRMA.test(lineas.at(-1)!))) lineas.pop();
  t = lineas.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  const envuelto = /^[«“"]([^«»“”"]*)[»”"]$/.exec(t);
  return envuelto ? envuelto[1]!.trim() : t;
}

// --- Frases (pantalla y voz) -------------------------------------------------------------------------------------------
/** La primera frase que, ya dicha en palabras, cabe en el tope de voz (VOZ_MAX). */
const queCabe = (candidatas: string[]): string => candidatas.find((c) => paraVoz(c).length <= VOZ_MAX) ?? candidatas[candidatas.length - 1]!;
const corto = (s: string, max = 28) => cortoVoz(s, max);

export type Frase = { message: string; voz: string };

/** «¿Cuál?» cuando hay varios: «Marco (de Saya)» o «Marco (del gimnasio)». Sin teléfonos. */
export function preguntaCual(cs: Contacto[]): Frase {
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
/** Sin coincidencia: se pide el número en vez de adivinar. */
export function frasesNoEsta(nombre: string, para: Gestion): Frase {
  const n = nombre || "esa persona";
  const pide = para === "buscar" ? "Si me dices su número, lo anoto." : para === "escribir" ? "Dime su número y te dejo el WhatsApp." : "Dime su número y te dejo la llamada.";
  const corta = para === "buscar" ? "¿Me dices su número?" : "Dime su número.";
  return {
    message: `No tengo a ${n} guardado. ${pide}`,
    voz: queCabe([`No tengo a ${corto(n)} guardado. ${pide}`, `No tengo a ${corto(n)}. ${corta}`, `No lo tengo guardado. ${corta}`]),
  };
}

export const fraseCreado = (c: Pick<ContactoNuevo, "nombre" | "relacion">): Frase => ({
  message: `Guardé a ${etiqueta(c)}.`,
  voz: queCabe([`Listo, guardé a ${corto(c.nombre)}.`, "Listo, lo guardé."]),
});

export const fraseWhatsapp = (nombre: string, texto: string): Frase => ({
  message: texto ? `WhatsApp para ${nombre}: «${texto}»` : `Chat de WhatsApp con ${nombre}.`,
  voz: queCabe([`Listo, te dejo el WhatsApp de ${corto(nombre)}.`, "Listo, te dejo el WhatsApp."]),
});

export const fraseLlamar = (nombre: string): Frase => ({
  message: `Llamar a ${nombre}.`,
  voz: queCabe([`Listo, toca para llamar a ${corto(nombre)}.`, "Listo, toca para llamar."]),
});

/** Sin el número: va en la tarjeta de la pantalla, no en la frase (que vuelve al modelo en el historial). */
export const fraseNumero = (c: Pick<Contacto, "nombre" | "relacion">): Frase => ({
  message: `Aquí está el contacto de ${etiqueta(c)}.`,
  voz: queCabe([`Te dejo el número de ${corto(c.nombre)} en pantalla.`, "Te dejo el número en pantalla."]),
});
