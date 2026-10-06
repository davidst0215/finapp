// Texto de una búsqueda listo para decirse en voz alta. Sin globals de Deno: se prueba con Node (internet.test.ts).
// Las respuestas con búsqueda traen las fuentes como enlaces markdown, montos con 3–4 decimales y fechas "02/10":
// el modelo no siempre obedece al prompt (5-oct), así que se corrige aquí, de forma determinista.

const MESES = ["", "enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

export function paraDecir(texto: string): string {
  return texto
    .replace(/\[([^\]]+)\]\((?:https?:\/\/)[^)]*\)/g, "$1") // [BCRP](https://…) → BCRP
    .replace(/https?:\/\/\S+/g, "") // URLs sueltas
    .replace(/\*\*|__|`/g, "")
    .replace(/(^|\n)\s*[-•*]\s+/g, "$1")
    // La voz convierte "S/ 3.44" a palabras solo con 2 decimales: "S/ 3.4475" se leería a medias.
    .replace(/(S\/|US\$)(\s?)(\d+)\.(\d{3,})/g, (_, moneda: string, esp: string, ent: string, dec: string) =>
      `${moneda}${esp}${Number(`${ent}.${dec}`).toFixed(2)}`)
    // Fechas día/mes(/año) a palabras (en Perú el día va primero).
    .replace(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?\b/g, (orig: string, d: string, m: string, a?: string) => {
      const dia = Number(d), mes = Number(m);
      if (dia < 1 || dia > 31 || mes < 1 || mes > 12) return orig;
      return `${dia} de ${MESES[mes]}${a ? ` de ${a}` : ""}`;
    })
    .replace(/\s*\n+\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}
