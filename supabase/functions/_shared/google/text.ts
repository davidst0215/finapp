// Utilidades de texto para buscar por nombre o título. Lógica pura.

// Minúsculas y sin tildes: "Mónica" y "monica" se comparan igual.
export const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

const STOP = new Set(["el", "la", "los", "las", "de", "del", "un", "una", "que", "por", "con", "para", "en", "y", "a", "correo", "mail", "email", "reunion", "evento", "cita"]);

// Palabras útiles de lo que dijo David ("la reunión de TDV" → ["tdv"]).
export function keywords(query: string): string[] {
  return norm(query).split(/[^a-z0-9@.]+/).filter((t) => t.length >= 2 && !STOP.has(t));
}

// Elementos que mejor coinciden con la búsqueda: todos los empatados en el puntaje más alto.
export function bestMatches<T>(items: T[], query: string, haystack: (item: T) => string): T[] {
  const tokens = keywords(query);
  if (tokens.length === 0) return [];
  const scored = items
    .map((item) => {
      const hay = norm(haystack(item));
      return { item, score: tokens.filter((t) => hay.includes(t)).length };
    })
    .filter((x) => x.score > 0);
  const best = Math.max(0, ...scored.map((x) => x.score));
  return scored.filter((x) => x.score === best).map((x) => x.item);
}
