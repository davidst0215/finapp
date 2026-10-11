// Lógica pura de la voz en el chat de Claude Code (sin DOM, probada con Node).

/** Lo máximo que se lee en voz alta de una vez: ElevenLabs cobra por carácter. El servidor (tts) pone el mismo tope. */
export const MAX_VOZ = 100;

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
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

// Abreviaturas que llevan punto sin cerrar la oración. Espejo de supabase/functions/_shared/voz.ts: mismos casos en las dos pruebas.
const ABREVIATURAS = new Set(['dr', 'dra', 'sr', 'sra', 'srta', 'ud', 'uds', 'av', 'ing', 'lic', 'prof', 'pág', 'págs', 'núm', 'tel', 'vs', 'aprox', 'ee', 'jr']);
const CIERRES = new Set([')', ']', '»', '"', "'", '”', '’']);
const COLGANTES = new Set(['a', 'al', 'con', 'de', 'del', 'e', 'el', 'en', 'la', 'las', 'lo', 'los', 'o', 'para', 'por', 'que', 'se', 'su', 'sus', 'u', 'un', 'una', 'y', 'tu', 'tus', 'mi', 'mis', 'sin', 'como', 'ni']);

/** Posiciones (exclusivas) donde termina una oración: "45.90", "Dr. Pérez" y "p. m. mañana" no la parten. */
function finesDeOracion(texto: string): number[] {
  const fines: number[] = [];
  for (const m of texto.matchAll(/[.!?…]+/g)) {
    let fin = m.index + m[0].length;
    while (fin < texto.length && CIERRES.has(texto[fin]!)) fin++;
    if (fin < texto.length && !/\s/.test(texto[fin]!)) continue;
    const resto = texto.slice(fin).trimStart();
    if (resto && /^\p{Ll}/u.test(resto)) continue;
    if (m[0] === '.') {
      const palabra = /(\p{L}+)$/u.exec(texto.slice(0, m.index))?.[1]?.toLowerCase();
      if (palabra && ABREVIATURAS.has(palabra)) continue;
    }
    fines.push(fin);
  }
  return fines;
}

function sinColgantes(texto: string): string {
  let t = texto.replace(/[\s,;:.!?…\-–—]+$/, '');
  for (;;) {
    const m = /^(.*\s)(\p{L}+)$/su.exec(t);
    if (!m || !COLGANTES.has(m[2]!.toLowerCase())) return t;
    t = m[1]!.replace(/[\s,;:.!?…\-–—]+$/, '');
  }
}

/**
 * Recorta a `max` caracteres como lo diría una persona: hasta el último fin de oración que cabe; si la primera ya se pasa,
 * hasta la última pausa (coma, punto y coma, dos puntos) cerrando con punto; si no hay pausa, hasta la última palabra.
 * Nunca pasa de `max` ni corta una palabra.
 */
export function acotarVoz(texto: string, max: number = MAX_VOZ): string {
  const t = texto.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;

  const cabenFines = finesDeOracion(t).filter((f) => f <= max);
  const fin = cabenFines.length ? cabenFines[cabenFines.length - 1]! : 0;
  if (fin >= max * 0.3) return t.slice(0, fin).trim();

  const ventana = t.slice(0, max - 1);
  const completa = /\s/.test(t[max - 1] ?? ' ');
  const palabras = completa ? ventana : ventana.slice(0, Math.max(ventana.lastIndexOf(' '), 0)) || ventana;
  const pausas = [...palabras.matchAll(/[,;:](?=\s)/g)];
  const pausa = pausas.length ? (pausas[pausas.length - 1]!.index ?? -1) : -1;
  const corte = pausa >= max * 0.35 ? palabras.slice(0, pausa) : palabras;
  return `${sinColgantes(corte)}.`;
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
 * Lo que se lee de `texto`: su primera parte significativa, de MAX_VOZ caracteres como máximo y sin cortar palabras.
 * `recortado` avisa que no se lee todo. Es un resumen, no el mensaje completo: leer 600 caracteres cuesta seis veces más.
 */
export function recortarParaVoz(texto: string, max: number = MAX_VOZ): { texto: string; recortado: boolean } {
  const limpio = limpiarParaVoz(texto);
  const leido = acotarVoz(primeraParte(limpio), max);
  const sinEspacios = (t: string) => t.replace(/\s+/g, '');
  return { texto: leido, recortado: sinEspacios(leido) !== sinEspacios(limpio) };
}
