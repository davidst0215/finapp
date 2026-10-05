// ¿La llamada del modelo sirve? Algunos proveedores devuelven a veces la tool sin el texto que
// David va a escuchar (p. ej. analyze_finances con `answer` vacío). Esas respuestas se reintentan
// una vez antes de ejecutar nada. Sin globals de Deno: se prueba con Node (respuesta.test.ts).

type ToolCall = { function?: { name?: string; arguments?: string } } | undefined | null;

export function argumentos(call: ToolCall): Record<string, unknown> | null {
  try {
    const a = JSON.parse(call?.function?.arguments || "{}");
    return a && typeof a === "object" && !Array.isArray(a) ? a as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

// Rellenos que el modelo a veces escribe en vez de la respuesta.
const RELLENO = /^(placeholder|respuesta|answer|todo|tbd|n\/?a|\.{2,}|…|revisando[\s\S]*|déjame (revisar|ver)[\s\S]*)$/i;

/** true si no hay tool, los argumentos no se pueden leer o el texto a decir (`answer`) vino vacío o de relleno. */
export function respuestaInservible(call: ToolCall): boolean {
  if (!call?.function?.name) return true;
  const args = argumentos(call);
  if (!args) return true;
  if (!("answer" in args)) return false;
  if (typeof args.answer !== "string") return true;
  const texto = args.answer.trim();
  return texto.length < 3 || RELLENO.test(texto);
}
