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
  // Un enlace markdown se dice por su texto: la URL no se lee ("[el doc](https://…)" → "el doc").
  let t = montosAVoz(text.replace(ENLACE_MD, "$1"));
  t = t.replace(/\*\*|\*/g, "").replace(/#{1,3}\s/g, "").replace(/(^|\n)\s*[-•]\s/g, "$1");
  t = t.replace(/(\d+(?:\.\d+)?)%/g, "$1 por ciento");
  t = t.replace(EMOJI, (c) => (SIMBOLOS_DE_TEXTO.has(c) ? c : ""));
  return t.replace(/\s{2,}/g, " ").trim();
}

// [texto](url) e ![alt](url). La URL admite un nivel de paréntesis: https://es.wikipedia.org/wiki/Foo_(bar).
const ENLACE_MD = /!?\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/g;

// Emojis y sus piezas: pictogramas (⭐ ⏰ 🫠 …), tonos de piel, banderas, selector de variación (U+FE0F), unión (U+200D) y
// teclas (U+20E3). ElevenLabs los leería como "estrella" o los saltaría, pero cobra el carácter.
const EMOJI = /[\p{Extended_Pictographic}\p{Emoji_Modifier}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}\u{20E3}]/gu;
// Pictográficos "de texto" que sí se escriben en una frase normal.
const SIMBOLOS_DE_TEXTO = new Set(["©", "®", "™"]);

// --- Tope de voz -----------------------------------------------------------------------------------------------------
// ElevenLabs cobra por carácter enviado. Todo lo que se manda pasa por `prepararVoz`: nunca más de VOZ_MAX caracteres
// ya convertidos (los montos en palabras crecen: "S/ 45.90" son 8 caracteres y "cuarenta y cinco soles con noventa
// céntimos" son 43), cortado donde una voz humana pararía y nunca a mitad de palabra.

/** Máximo de caracteres que se mandan a la voz en cada respuesta (ya convertidos a palabras). */
export const VOZ_MAX = 100;

// Abreviaturas que llevan punto sin cerrar la oración: "Dr. Pérez", "Av. Arequipa", "EE. UU.", "pág. 3".
const ABREVIATURAS = new Set(["dr", "dra", "sr", "sra", "srta", "ud", "uds", "av", "ing", "lic", "prof", "pág", "págs", "núm", "tel", "vs", "aprox", "ee", "jr"]);
const CIERRES = new Set([")", "]", "»", '"', "'", "”", "’"]);

/**
 * Posiciones (exclusivas) donde termina una oración. Un punto cuenta solo si va seguido de espacio o del final, y no
 * cuando lo que sigue empieza en minúscula ("p. m. mañana", "etc. y"), ni tras una abreviatura de tratamiento. Así
 * "S/ 45.90", "12.5 por ciento" y "Dr. Pérez" no parten una oración.
 */
export function finesDeOracion(texto: string): number[] {
  const fines: number[] = [];
  for (const m of texto.matchAll(/[.!?…]+/g)) {
    let fin = m.index + m[0].length;
    while (fin < texto.length && CIERRES.has(texto[fin])) fin++;
    if (fin < texto.length && !/\s/.test(texto[fin])) continue; // "45.90", "a.b": no es un fin
    const resto = texto.slice(fin).trimStart();
    if (resto && /^\p{Ll}/u.test(resto)) continue; // sigue en minúscula: la oración continúa
    if (m[0] === ".") {
      const palabra = /(\p{L}+)$/u.exec(texto.slice(0, m.index))?.[1]?.toLowerCase();
      if (palabra && ABREVIATURAS.has(palabra)) continue;
    }
    fines.push(fin);
  }
  return fines;
}

/** Una oración más corta que esto no es una respuesta ("Sí."): se sigue hasta la pausa en vez de quedarse con ella. */
const MIN_ORACION = 12;
// Tras una coma que abre un contraste ("…, pero no los gastos") no se corta: dejaría una afirmación falsa ("Te alcanza.").
const CONTRASTE = /^(?:pero|aunque|sin embargo|salvo|excepto|y no|no)(?![\p{L}\p{N}])/iu;

/**
 * Recorta `texto` a `max` caracteres como lo diría una persona:
 * 1. hasta el último fin de oración que cabe, si esa oración mide al menos MIN_ORACION (la segunda no hace falta que quepa);
 * 2. si la primera oración ya se pasa, hasta la última pausa natural (coma, punto y coma o dos puntos) que no abra un
 *    contraste (pero, aunque, sin embargo, salvo, excepto, no), y cierra con punto;
 * 3. sin pausa, hasta la última palabra completa, cerrando con punto.
 * Nunca pasa de `max` ni corta una palabra (salvo una "palabra" sola más larga que el tope, p. ej. una URL).
 */
export function acotarVoz(texto: string, max: number = VOZ_MAX): string {
  const t = texto.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;

  const fin = finesDeOracion(t).filter((f) => f <= max).at(-1) ?? 0;
  if (fin >= MIN_ORACION) return t.slice(0, fin).trim();

  // Hay que dejar sitio al punto final. `ventana` son palabras completas (corta en el último espacio si hace falta).
  const ventana = t.slice(0, max - 1);
  const completa = /\s/.test(t[max - 1] ?? " ");
  const palabras = completa ? ventana : ventana.slice(0, Math.max(ventana.lastIndexOf(" "), 0)) || ventana;

  // Se mira un carácter más allá de `palabras` (el espacio del corte) para ver también una coma que quedó justo al final.
  const pausas = [...t.slice(0, palabras.length + 1).matchAll(/[,;:](?=\s)/g)]
    .filter((m) => m.index < palabras.length && !CONTRASTE.test(t.slice(m.index + 1).trimStart()));
  const pausa = pausas.at(-1)?.index ?? -1;
  const corte = pausa >= max * 0.35 ? palabras.slice(0, pausa) : palabras;
  return cerrar(t, corte, max);
}

// Conectores que cambian el sentido de lo anterior: si el corte los borra, la frase afirma lo contrario.
const CONTRASTE_PALABRAS = new Set(["pero", "aunque", "salvo", "excepto", "embargo", "no"]);
// Un conector que trae su negación ("…, pero no para los gastos"): se puede conservar aunque lo demás se acorte.
// Está justo después del corte, o tras lo que falta de la cláusula (hasta su primera pausa).
const CONECTOR_NEGADO = /^(?:[\s,;:]*|[^,;:]*[,;:]\s*)((?:pero|y|aunque|sino) no|no)(?![\p{L}\p{N}])/iu;
// La primera pausa que sigue al corte abre un contraste: se cortó dentro de la cláusula que ese contraste matiza.
const SIGUE_UN_CONTRASTE = /^[^,;:]*[,;:]\s*(?:pero|aunque|sin embargo|salvo|excepto|y no|no)(?![\p{L}\p{N}])/iu;

/**
 * Cierra el corte con punto. Si al quitar las palabras colgantes se borró un conector de contraste o una negación (o el
 * corte cae justo antes de uno), la frase quedaría afirmando lo contrario ("Tu saldo alcanza para todo el mes." cuando era
 * "…, pero no para los gastos variables"). Entonces:
 * 1. se corta antes de esa cláusula afirmativa, en el límite anterior (oración o pausa), si deja al menos MIN_ORACION;
 * 2. si no, se conserva la negación acortando la cláusula para que quepa ("Tu saldo alcanza para todos los pagos fijos, pero no.").
 * Si ninguna de las dos es posible (el conector no trae "no"), se cierra como siempre.
 */
function cerrar(t: string, corte: string, max: number): string {
  const { texto: limpio, quitadas } = quitarColgantes(corte);
  const resto = t.slice(corte.length);
  const cambiaElSentido = quitadas.some((w) => CONTRASTE_PALABRAS.has(w)) ||
    CONTRASTE.test(resto.replace(/^[\s,;:.!?…\-–—]+/, "")) || SIGUE_UN_CONTRASTE.test(resto);
  if (!cambiaElSentido) return `${limpio}.`;

  const fin = finesDeOracion(limpio).filter((f) => f < limpio.length).at(-1) ?? 0;
  const coma = [...limpio.matchAll(/[,;:](?=\s)/g)].at(-1)?.index ?? -1;
  const previos = [fin > 0 ? limpio.slice(0, fin).trim() : "", coma > 0 ? `${sinColgantes(limpio.slice(0, coma))}.` : ""];
  const previo = previos.sort((a, b) => b.length - a.length)[0] ?? "";
  if (previo.length >= MIN_ORACION) return previo;

  const conector = CONECTOR_NEGADO.exec(t.slice(limpio.length))?.[1];
  if (conector) {
    const union = /^y\b/i.test(conector) ? " " : ", ";
    const afirmativa = cortoVoz(limpio, max - union.length - conector.length - 1);
    if (afirmativa.length >= MIN_ORACION) return `${afirmativa}${union}${conector}.`;
  }
  return `${limpio}.`;
}

// Palabras que no pueden cerrar una frase ("…lo que pasa con la."): si el corte las deja al final se quitan. Un número
// dicho en palabras ("mil quinientos") tampoco: sin su unidad ("soles") diría una cifra que no es la del monto.
const NUMERALES = [...U, ...D, ...C, "cien", "mil", "millón", "millones"].filter(Boolean);
const COLGANTES = new Set([
  ...NUMERALES,"a", "al", "con", "de", "del", "e", "el", "en", "la", "las", "lo", "los", "o", "para", "por", "que", "se", "su", "sus", "u", "un", "una", "y", "tu", "tus", "mi", "mis", "sin", "como", "ni", "no", "sí", "más", "menos", "muy", "ya", "pero", "aunque", "salvo", "excepto", "embargo", "este", "esta", "estos", "estas", "ese", "esa", "esos", "esas", "todos", "todas", "cada"]);

/** El texto sin puntuación ni palabras colgantes al final, y las palabras que se quitaron (en minúscula, de atrás hacia adelante). */
function quitarColgantes(texto: string): { texto: string; quitadas: string[] } {
  let t = texto.replace(/[\s,;:.!?…\-–—]+$/, "");
  const quitadas: string[] = [];
  for (;;) {
    const m = /^(.*\s)(\p{L}+)$/su.exec(t);
    if (!m || !COLGANTES.has(m[2].toLowerCase())) return { texto: t, quitadas };
    quitadas.push(m[2].toLowerCase());
    t = m[1].replace(/[\s,;:.!?…\-–—]+$/, "");
  }
}

const sinColgantes = (texto: string): string => quitarColgantes(texto).texto;

/** Lo que de verdad se manda a ElevenLabs: montos y símbolos en palabras (paraVoz) y luego el tope. */
export function prepararVoz(texto: string, max: number = VOZ_MAX): string {
  return acotarVoz(paraVoz(texto), max);
}

/**
 * Recorta un título o nombre para decirlo: siempre en el último espacio, sin puntos suspensivos (la voz los lee raro) ni
 * palabras colgantes. A mitad de palabra solo si no hay ningún espacio donde cortar.
 */
export function cortoVoz(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  if (/\s/.test(t[max]!)) return sinColgantes(cut); // la palabra termina justo en el límite
  const sp = cut.lastIndexOf(" ");
  return sinColgantes(sp > 0 ? cut.slice(0, sp) : cut);
}
