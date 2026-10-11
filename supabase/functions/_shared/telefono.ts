// Teléfonos de la agenda de Wabid: normalizar a E.164 (Perú por defecto), mostrarlos y armar los enlaces que abren WhatsApp o
// el marcador. Puro: sin globals de Deno; se prueba con Node (telefono.test.ts).
// ESPEJO: apps/web/src/lib/telefono.ts hace lo mismo para el formulario de Contactos; apps/web/tests/contactos/telefono.test.ts
// comprueba que los dos den el mismo resultado. Si cambias una regla aquí, cámbiala allá.

export type Telefono = { ok: true; e164: string } | { ok: false; error: string };

const MAX_ENTRADA = 40;
const PE = "51";
// Móvil peruano: 9 dígitos que empiezan con 9. Fijo: 8 dígitos (Lima = 1 + 7; provincias = código de área de 2 + 6) con primer dígito 1-8.
const PE_MOVIL = /^9\d{8}$/;
const PE_FIJO = /^[1-8]\d{7}$/;

export const TEL_FALTA = "¿Cuál es su número?";
const TEL_INVALIDO =
  "No reconozco ese número. En Perú son 9 dígitos y empiezan con 9; si es de otro país, dímelo con el prefijo (más cincuenta y siete…).";
const TEL_PE_INCOMPLETO = "Ese número peruano no está completo: los celulares tienen 9 dígitos y empiezan con 9.";
const TEL_SIN_AREA = "Falta el código de área (en Lima, el 1) o el prefijo del país.";

const ok = (e164: string): Telefono => ({ ok: true, e164 });
const no = (error: string): Telefono => ({ ok: false, error });

/**
 * Lo que David dijo o escribió → "+51999888777". Perú por defecto ("999 888 777", "51 999 888 777", "01 234 5678" fijo de Lima);
 * otros países solo con prefijo ("+57 300 123 4567" o "0057…"). Se aceptan espacios, puntos, guiones y paréntesis como
 * separadores; cualquier letra u otro símbolo se rechaza, y un número que no encaja nunca se "arregla": se pide repetirlo.
 */
export function normalizarTelefono(v: unknown): Telefono {
  if (typeof v !== "string" && typeof v !== "number") return no(TEL_FALTA);
  const crudo = String(v).trim();
  if (!crudo) return no(TEL_FALTA);
  if (crudo.length > MAX_ENTRADA || !/^[\d\s().+-]+$/.test(crudo)) return no(TEL_INVALIDO);
  const s = crudo.replace(/[\s().-]/g, "");
  if (!/^\+?\d+$/.test(s)) return no(TEL_INVALIDO);

  // Con prefijo internacional explícito (+ o 00): E.164, 8 a 15 dígitos y sin cero inicial.
  const internacional = s.startsWith("+") ? s.slice(1) : s.startsWith("00") ? s.slice(2) : null;
  if (internacional !== null) {
    if (!/^[1-9]\d{7,14}$/.test(internacional)) return no(TEL_INVALIDO);
    if (internacional.startsWith(PE)) {
      const nacional = internacional.slice(PE.length);
      return PE_MOVIL.test(nacional) || PE_FIJO.test(nacional) ? ok(`+${internacional}`) : no(TEL_PE_INCOMPLETO);
    }
    return ok(`+${internacional}`);
  }

  // Sin prefijo se supone Perú.
  if (PE_MOVIL.test(s)) return ok(`+${PE}${s}`);
  if (s.length === 11 && s.startsWith(PE) && PE_MOVIL.test(s.slice(PE.length))) return ok(`+${s}`);
  if (/^0[1-8]\d{7}$/.test(s)) return ok(`+${PE}${s.slice(1)}`); // 01 234 5678: el 0 es el prefijo de larga distancia nacional
  if (/^[1-8]\d{6,7}$/.test(s)) return no(TEL_SIN_AREA); // fijo sin prefijo: ¿de qué ciudad? No se supone
  if (s.startsWith("9") && s.length < 9) return no(TEL_PE_INCOMPLETO);
  return no(TEL_INVALIDO);
}

// Largo del código de país para mostrar: 1 dígito (+1, +7), 3 dígitos (Centroamérica, Caribe, Bolivia, Ecuador, Paraguay, Uruguay…) o 2.
const CC_3 = /^(21\d|22\d|23\d|24\d|25\d|26\d|29\d|35\d|37\d|38\d|42\d|50\d|59\d|67\d|68\d|69\d|85\d|87\d|88\d|96\d|97\d|99\d)/;
const largoCodigo = (d: string): number => (/^[17]/.test(d) ? 1 : CC_3.test(d) ? 3 : 2);

/** "+51999888777" → "+51 999 888 777" (para la pantalla). Un valor que no es E.164 se devuelve tal cual. */
export function formatearTelefono(e164: string): string {
  if (!/^\+[1-9]\d{7,14}$/.test(e164)) return e164;
  const d = e164.slice(1);
  if (d.startsWith(PE)) {
    const n = d.slice(PE.length);
    if (PE_MOVIL.test(n)) return `+${PE} ${n.slice(0, 3)} ${n.slice(3, 6)} ${n.slice(6)}`;
    if (PE_FIJO.test(n)) return `+${PE} ${n[0]} ${n.slice(1, 4)} ${n.slice(4)}`;
  }
  const cc = largoCodigo(d);
  const grupos = d.slice(cc).match(/\d{1,3}/g) ?? [];
  // Un último grupo de un solo dígito se une al anterior: 300 123 4567, no 300 123 456 7.
  if (grupos.length > 1 && grupos[grupos.length - 1]!.length === 1) grupos.splice(-2, 2, grupos.slice(-2).join(""));
  return `+${d.slice(0, cc)} ${grupos.join(" ")}`;
}

/** Quita los sustitutos sueltos (mitad de un emoji cortado): encodeURIComponent lanza URIError con ellos. */
const bienFormado = (t: string): string => t.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "�");

/** Máximo de caracteres del mensaje en el enlace: una URL demasiado larga la rechazan el navegador y WhatsApp. */
export const MAX_MENSAJE = 500;

/**
 * Enlace que abre WhatsApp con el chat y el texto listos (David toca "enviar"). Se usa api.whatsapp.com/send y NO wa.me, que
 * corrompe los emojis. `phone` va en dígitos sin "+"; el texto, codificado en UTF-8 por componente (emojis, tildes, saltos de
 * línea, "&" y "#" no rompen la URL).
 */
export function urlWhatsapp(e164: string, texto = ""): string {
  if (!/^\+[1-9]\d{7,14}$/.test(e164)) throw new Error("Teléfono no válido");
  const t = [...bienFormado(texto)].slice(0, MAX_MENSAJE).join(""); // por caracteres, no por unidades UTF-16: no parte un emoji
  return `https://api.whatsapp.com/send?phone=${e164.slice(1)}${t ? `&text=${encodeURIComponent(t)}` : ""}`;
}

/** Enlace que abre el marcador con el número escrito. */
export function urlLlamar(e164: string): string {
  if (!/^\+[1-9]\d{7,14}$/.test(e164)) throw new Error("Teléfono no válido");
  return `tel:${e164}`;
}

/** Los teléfonos que aparecen en un dictado ("guarda a Marco con el 999 888 777"), ya normalizados. */
export function telefonosEnTexto(texto: string): string[] {
  const salida: string[] = [];
  for (const m of texto.matchAll(/\+?\(?\d[\d\s().-]{5,}\d/g)) {
    const t = normalizarTelefono(m[0]);
    if (t.ok && !salida.includes(t.e164)) salida.push(t.e164);
  }
  return salida;
}

/**
 * ¿Es el número que David dijo? El teléfono que mandó el modelo debe aparecer (con cualquier formato) entre lo que David dictó:
 * un dígito cambiado, o un número inventado, mandaría los mensajes a un desconocido. `dictado` junta lo de este turno y lo
 * que David dijo antes en la conversación (el número puede haber venido en un turno anterior). Sin ningún teléfono dictado no
 * hay nada que contrastar y la respuesta es NO: nunca se acepta un número que David no dijo.
 */
export function coincideConDictado(e164: string, dictado: string): boolean {
  return telefonosEnTexto(dictado).includes(e164);
}
