// Lógica pura de la voz en el chat de Claude Code (sin DOM, probada con Node).

/** `tts` acepta hasta 600 caracteres. */
export const MAX_TTS = 600;

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

/** Recorta al último fin de frase antes de `max`; si no hay, al último espacio. `recortado` avisa que no se lee todo. */
export function recortarParaVoz(texto: string, max = MAX_TTS): { texto: string; recortado: boolean } {
  const limpio = limpiarParaVoz(texto);
  if (limpio.length <= max) return { texto: limpio, recortado: false };
  const ventana = limpio.slice(0, max);
  let fin = -1;
  for (const m of ventana.matchAll(/[.!?…]+["')\]»]*(?=\s|$)|\n/g)) fin = m.index + m[0].length;
  if (fin < 40) fin = ventana.lastIndexOf(' ');
  if (fin < 40) fin = max;
  return { texto: ventana.slice(0, fin).trim(), recortado: true };
}
