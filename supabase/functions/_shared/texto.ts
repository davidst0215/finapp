// Texto hablado → comparable. Lo usan las cuentas ("la de BCP") y los proyectos ("nova fondos"). Puro: sin globals de Deno.

export const sinTildes = (s: string): string => s.normalize("NFD").replace(/[̀-ͯ]/g, "");

/** Minúsculas, sin tildes y con todo lo que no sea letra o número convertido en un espacio: "Maqui+ CO" → "maqui co". */
export const norm = (s: string): string => sinTildes(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Dos palabras coinciden si son iguales o una es prefijo de la otra (plurales: "costo"/"costos"), con 4 letras o más. */
export const coincide = (a: string, b: string): boolean =>
  a === b || (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a)));

/**
 * Palabras de la consulta que ninguna palabra de la bolsa cubre. Dos palabras seguidas de la consulta cuentan juntas
 * cuando la voz partió un nombre en dos: "nova fondos" cubre «novafondos» y "mqs co" cubre «mqsco».
 */
export function sinCubrir(consulta: string[], bolsa: string[]): string[] {
  const falta: string[] = [];
  for (let i = 0; i < consulta.length; i++) {
    const t = consulta[i];
    if (bolsa.some((b) => coincide(t, b))) continue;
    const junta = i + 1 < consulta.length ? t + consulta[i + 1] : "";
    // Unidas deben ser CASI iguales (plural a lo sumo): "mqs"+"colombia" no es «mqsco» aunque empiece igual.
    if (junta && bolsa.some((b) => b === junta || (junta.length >= 6 && coincide(junta, b) && Math.abs(junta.length - b.length) <= 2))) {
      i++;
      continue;
    }
    falta.push(t);
  }
  return falta;
}

/** Todas las palabras de la consulta aparecen en la bolsa. */
export const cubre = (consulta: string[], bolsa: string[]): boolean => consulta.length > 0 && sinCubrir(consulta, bolsa).length === 0;
