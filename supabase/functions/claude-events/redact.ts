// Limpieza de texto antes de guardarlo: quita secretos obvios, marca caracteres invisibles y recorta.
//
// Hay DOS implementaciones de estas reglas, una aquí y otra en tools/claude-hooks/wabid-hook.mjs (la laptop
// redacta antes de enviar; el servidor vuelve a redactar antes de guardar). Las dos pasan los mismos casos
// de tools/claude-hooks/redaction-cases.json. Si cambias una regla, cambia primero ese archivo y las dos.
//
// Sin globals de Deno: corre igual en Node 22 (pruebas) y en la edge function.

export const MARK = "[oculto]";
const PEM_MARK = "[clave privada oculta]";

// Prefijos de llaves conocidas. Cada alternativa exige largo mínimo para no tocar palabras comunes.
const PREFIXED_TOKENS = [
  String.raw`sk-ant-[A-Za-z0-9_-]{16,}`, // Anthropic
  String.raw`sk-(?:proj-)?[A-Za-z0-9_-]{20,}`, // OpenAI
  String.raw`sk_[a-f0-9]{32,}`, // ElevenLabs
  String.raw`gh[pousr]_[A-Za-z0-9]{20,}`, // GitHub
  String.raw`github_pat_[A-Za-z0-9_]{20,}`,
  String.raw`xox[abprs]-[A-Za-z0-9-]{10,}`, // Slack
  String.raw`(?:AKIA|ASIA)[0-9A-Z]{16}\b`, // AWS
  String.raw`AIza[0-9A-Za-z_-]{35}`, // Google API
  String.raw`ya29\.[0-9A-Za-z_-]{20,}`, // Google OAuth
  String.raw`[sr]k_(?:live|test)_[0-9A-Za-z]{16,}`, // Stripe
  String.raw`npm_[A-Za-z0-9]{30,}`,
  String.raw`glpat-[A-Za-z0-9_-]{16,}`, // GitLab
  String.raw`sbp_[a-f0-9]{30,}`, // Supabase (token personal)
  String.raw`sb_secret_[A-Za-z0-9_-]{16,}`, // Supabase (llave secreta)
  String.raw`SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}`, // SendGrid
  String.raw`EAA[A-Za-z0-9]{50,}`, // Meta (WhatsApp Cloud, Ads)
  String.raw`wbd\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}`, // token de dispositivo de Wabid
];

// El valor de una asignación: entre comillas (con espacios) o hasta el próximo separador.
const VALUE = String.raw`("[^"\n]{4,}"|'[^'\n]{4,}'|[^\s"'&;|)]{4,})`;

// Orden importa: primero lo más específico, y cada regla genérica ignora lo que ya quedó como [oculto].
const RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, PEM_MARK],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, MARK],
  [new RegExp(String.raw`\b(?:${PREFIXED_TOKENS.join("|")})`, "g"), MARK],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/=-]{12,}/gi, `$1 ${MARK}`],
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:\/@]+:)[^\s@\/]+@/gi, `$1${MARK}@`],
  [/(\bsshpass\s+(?:-\w+\s+)*-p\s*)(?!\[oculto\])("[^"\n]*"|'[^'\n]*'|[^\s"']+)/g, `$1${MARK}`],
  [/(\becho\s+(?:-n\s+)?)("[^"\n]*"|'[^'\n]*'|[^\s|"']+)(?=[ \t]*\|[^\n|]*--password-stdin)/gi, `$1${MARK}`],
  [/(\s(?:-u|--user)(?:[ \t]+|=))([^\s:"']+:)(?!\[oculto\])("[^"\n]*"|'[^'\n]*'|[^\s"']+)/g, `$1$2${MARK}`],
  [/(\b(?:mysql|mariadb|mysqldump|psql|pg_dump|mongo|mongosh|sshpass)\b[^\n|;&]*?[ \t]-p)(?!\d+(?:\s|$))(?!\[oculto\])([^\s"'-][^\s"']{3,})/g, `$1${MARK}`],
  [/(\bauthorization["']?[ \t]*[:=][ \t]*[A-Za-z][\w-]*[ \t]+)(?!\[oculto\])[^\s"']{4,}/gi, `$1${MARK}`],
  [
    new RegExp(
      String.raw`(--?(?:password|passwd|pass|token|secret|api-?key|access-?key|auth-?token|client-?secret|private-?key)(?:=|[ \t]+))(?!\[oculto\]|-)("[^"\n]*"|'[^'\n]*'|\S+)`,
      "gi",
    ),
    `$1${MARK}`,
  ],
  [
    new RegExp(
      String.raw`((?:password|passwd|passphrase|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credentials?)["']?[ \t]*[=:][ \t]*)(?!\[oculto\]|Bearer\b|Basic\b)${VALUE}`,
      "gi",
    ),
    `$1${MARK}`,
  ],
  [/(\bauthorization["']?[ \t]*[:=][ \t]*)(?!\[oculto\]|[A-Za-z][\w-]*[ \t]+\S)("[^"\n]{4,}"|'[^'\n]{4,}'|[^\s"'&;|)]{4,})/gi, `$1${MARK}`],
  [new RegExp(String.raw`([A-Z0-9]_KEY[ \t]*=[ \t]*)(?!\[oculto\])${VALUE}`, "g"), `$1${MARK}`],
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const [re, replacement] of RULES) out = out.replace(re, replacement);
  return out;
}

// --- Caracteres invisibles ---------------------------------------------------------------------------

// Controles, espacios de ancho cero y marcas bidireccionales (que pueden reordenar visualmente un comando).
// Se dejan VISIBLES como [U+XXXX] para que quien aprueba vea que hay algo raro. \n y \t se conservan.
const INVISIBLE =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u061C\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g;

export const normalizeNewlines = (text: string) => text.replace(/\r\n?/g, "\n");

export const markInvisible = (text: string) =>
  text.replace(INVISIBLE, (ch) => `[U+${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}]`);

export const sanitizeText = (text: string) => markInvisible(normalizeNewlines(text));

// --- Recorte -----------------------------------------------------------------------------------------

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

// Cortar en medio de un par sustituto (emoji) deja un carácter huérfano que la base rechaza.
function sliceHead(text: string, n: number): string {
  const s = text.slice(0, n);
  return s.length > 0 && isHighSurrogate(s.charCodeAt(s.length - 1)) ? s.slice(0, -1) : s;
}
function sliceTail(text: string, n: number): string {
  if (n <= 0) return "";
  const s = text.slice(-n);
  return s.length > 0 && isLowSurrogate(s.charCodeAt(0)) ? s.slice(1) : s;
}

export type Clipped = { text: string; truncated: boolean };

// Si pasa de `max`, conserva el principio y el final (lo peligroso de un comando suele estar al final)
// y avisa cuánto se omitió. La salida puede superar `max` por el aviso (~35 caracteres).
export function clipMiddle(text: string, max: number, head: number, tail: number): Clipped {
  if (text.length <= max) return { text, truncated: false };
  const start = sliceHead(text, head);
  const end = sliceTail(text, tail);
  const omitted = text.length - start.length - end.length;
  return { text: `${start}\n[... ${omitted} caracteres omitidos ...]\n${end}`, truncated: true };
}

// Recorte simple con puntos suspensivos, para resúmenes de una línea.
export function clipText(text: string, max: number): string {
  if (text.length <= max) return text;
  return sliceHead(text, Math.max(0, max - 1)) + "…";
}

export const toOneLine = (text: string, max: number) => clipText(text.replace(/\s+/g, " ").trim(), max);

// --- Entrada completa --------------------------------------------------------------------------------

// Tope previo: acota el costo de las regex con entradas gigantes (un Write de varios MB).
const INPUT_CAP = { max: 8000, head: 5000, tail: 3000 };

export type StorageLimits = { max: number; head: number; tail: number };

// Texto de una sola línea (nombre de proyecto, resumen, mensaje de un aviso): limpio, redactado y corto.
export function cleanLine(text: string, max: number): string {
  const capped = clipMiddle(text, INPUT_CAP.max, INPUT_CAP.head, INPUT_CAP.tail).text;
  return toOneLine(markInvisible(redactSecrets(normalizeNewlines(capped))), max);
}

// Orden: acotar → unificar saltos → redactar → marcar invisibles → recortar.
// Redactar ANTES de recortar: un corte en medio de una llave dejaría un pedazo que ya no reconocen las reglas.
export function normalizeForStorage(text: string, limits: StorageLimits): Clipped {
  const capped = clipMiddle(text, INPUT_CAP.max, INPUT_CAP.head, INPUT_CAP.tail);
  const clean = markInvisible(redactSecrets(normalizeNewlines(capped.text)));
  const clipped = clipMiddle(clean, limits.max, limits.head, limits.tail);
  return { text: clipped.text, truncated: capped.truncated || clipped.truncated };
}
