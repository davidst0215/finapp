// Lógica pura de la voz en el chat de Claude Code (sin DOM, probada con Node).
// El cliente solo limpia el markdown y manda a /tts; el único recorte lo hace el servidor (supabase/functions/_shared/voz.ts).

/** Lo máximo que acepta /tts de una vez. Lo que de verdad se dice (100 caracteres) lo recorta el servidor, no el cliente. */
export const MAX_ENVIO = 600;
/** Solo para estimar el aviso «(leo el inicio)»: lo que el servidor suele alcanzar a decir. */
const LARGO_LEIDO = 100;

/** Une lo dictado al texto que ya había en el campo: se agrega al final, con un espacio si hace falta. */
export function unirDictado(existente: string, dictado: string): string {
  const d = dictado.trim();
  if (!d) return existente;
  if (!existente.trim()) return d;
  return /\s$/.test(existente) ? existente + d : `${existente} ${d}`;
}

/** Quita lo que una voz leería mal: bloques de código, comillas invertidas, énfasis, encabezados y enlaces. */
export function limpiarParaVoz(texto: string): string {
  return texto
    .replace(/```[\s\S]*?```/g, ' (código) ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/g, '$1') // la URL admite un nivel de paréntesis: Foo_(bar)
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

/**
 * La primera parte significativa de un texto largo: su primera línea con letras (si es muy corta, con la siguiente),
 * saltando los bloques de código y los encabezados. Es lo que resume un mensaje de Claude sin leerlo entero.
 */
export function primeraParte(limpio: string): string {
  const conLetras = limpio.split('\n').map((l) => l.trim()).filter((l) => /\p{L}{3}/u.test(l) && l !== '(código)');
  // Un encabezado ("Resultado") queda como una línea corta sin puntuación: no es contenido, salvo que no haya otra cosa.
  const frases = conLetras.filter((l) => l.length >= 40 || /[.!?:…]$/.test(l));
  const lineas = frases.length > 0 ? frases : conLetras;
  if (lineas.length === 0) return limpio;
  let parte = lineas[0]!;
  for (let i = 1; i < lineas.length && parte.length < 40; i++) parte += ` ${lineas[i]}`;
  return parte;
}

/**
 * Lo que se manda a /tts de `texto`: el markdown limpio y su primera parte significativa (sin bloques de código ni
 * encabezados), hasta MAX_ENVIO caracteres. El recorte de lo que se dice lo hace el servidor, el único que sabe cuánto
 * ocupa un monto en palabras. `recortado` avisa, por largo, que no se lee todo: es un resumen, no el mensaje completo.
 */
export function recortarParaVoz(texto: string): { texto: string; recortado: boolean } {
  const limpio = limpiarParaVoz(texto);
  return { texto: primeraParte(limpio).slice(0, MAX_ENVIO), recortado: limpio.length > LARGO_LEIDO };
}
