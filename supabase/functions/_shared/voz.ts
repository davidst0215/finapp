// Convierte montos "S/ 45.90" a palabras de forma determinista antes de la voz.
// El modelo escribe cifras; nunca decide cómo se pronuncian.
const U = ["cero", "uno", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve", "diez", "once", "doce", "trece", "catorce", "quince",
  "dieciséis", "diecisiete", "dieciocho", "diecinueve", "veinte", "veintiuno", "veintidós", "veintitrés", "veinticuatro", "veinticinco",
  "veintiséis", "veintisiete", "veintiocho", "veintinueve"];
const D = ["", "", "", "treinta", "cuarenta", "cincuenta", "sesenta", "setenta", "ochenta", "noventa"];
const C = ["", "ciento", "doscientos", "trescientos", "cuatrocientos", "quinientos", "seiscientos", "setecientos", "ochocientos", "novecientos"];

export const apocope = (s: string) => s.replace(/veintiuno$/, "veintiún").replace(/uno$/, "un");

export function palabras(n: number): string {
  if (n < 30) return U[n];
  if (n < 100) { const u = n % 10; return D[Math.floor(n / 10)] + (u ? " y " + U[u] : ""); }
  if (n < 1000) { if (n === 100) return "cien"; const r = n % 100; return C[Math.floor(n / 100)] + (r ? " " + palabras(r) : ""); }
  if (n < 1e6) { const m = Math.floor(n / 1000), r = n % 1000; return (m === 1 ? "mil" : apocope(palabras(m)) + " mil") + (r ? " " + palabras(r) : ""); }
  const mm = Math.floor(n / 1e6), r = n % 1e6;
  return (mm === 1 ? "un millón" : apocope(palabras(mm)) + " millones") + (r ? " " + palabras(r) : "");
}

function monto(entero: number, cent: number, moneda: "soles" | "dolares"): string {
  const [uno, varios, centUno, centVarios] = moneda === "soles"
    ? ["un sol", "soles", "un céntimo", "céntimos"]
    : ["un dólar", "dólares", "un centavo", "centavos"];
  const e = entero === 1 ? uno : entero === 0 ? "" : apocope(palabras(entero)) + (entero >= 1e6 && entero % 1e6 === 0 ? ` de ${varios}` : ` ${varios}`);
  const c = cent ? (cent === 1 ? centUno : apocope(palabras(cent)) + ` ${centVarios}`) : "";
  return e && c ? `${e} con ${c}` : e || c || `cero ${varios}`;
}

const NUM = String.raw`(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?`;

export function montosAVoz(texto: string): string {
  const conv = (moneda: "soles" | "dolares") => (_: string, ent: string, dec?: string) =>
    monto(parseInt(ent.replace(/,/g, ""), 10), dec ? parseInt(dec.padEnd(2, "0"), 10) : 0, moneda);
  return texto
    .replace(new RegExp(String.raw`S\/\s?` + NUM, "g"), conv("soles"))
    .replace(new RegExp(String.raw`(?:US\$|\$)\s?` + NUM, "g"), conv("dolares"));
}

/** Texto listo para la voz: montos a palabras (determinista) y sin formato de texto. */
export function paraVoz(text: string): string {
  let t = montosAVoz(text);
  t = t.replace(/\*\*|\*/g, "").replace(/#{1,3}\s/g, "").replace(/(^|\n)\s*[-•]\s/g, "$1");
  t = t.replace(/(\d+(?:\.\d+)?)%/g, "$1 por ciento");
  t = t.replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, "");
  return t.replace(/\s{2,}/g, " ").trim();
}
