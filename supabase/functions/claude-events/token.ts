// Token de dispositivo de Claude Code: `wbd.<device_id>.<secreto>`.
//
// - El secreto son 32 bytes aleatorios (256 bits). Con esa entropía basta SHA-256: no hace falta un hash
//   lento como bcrypt (eso es para contraseñas, que las eligen personas).
// - En la base solo vive el SHA-256 del secreto. El token completo se muestra una vez al emparejar y
//   nunca se guarda ni se vuelve a mostrar.
// - El `device_id` va dentro del token para buscar la fila por llave primaria y comparar el hash en
//   tiempo constante (sin buscar "el hash que coincida").
//
// Sin globals de Deno: solo Web Crypto, que existe también en Node 22 (las pruebas corren ahí).

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const UUID_RE = new RegExp(`^${UUID}$`);
const TOKEN_RE = new RegExp(`^wbd\\.(${UUID})\\.([A-Za-z0-9_-]{43})$`);
const HASH_RE = /^[0-9a-f]{64}$/;

export type ParsedToken = { deviceId: string; secret: string };

export function parseDeviceToken(token: string): ParsedToken | null {
  const m = typeof token === "string" ? TOKEN_RE.exec(token) : null;
  return m ? { deviceId: m[1]!, secret: m[2]! } : null;
}

const toHex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

const toBase64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");

export async function hashSecret(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return toHex(new Uint8Array(digest));
}

// Comparación sin salida temprana: el tiempo no delata en qué posición difieren los hashes.
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function generateDeviceToken(deviceId: string): Promise<{ token: string; deviceId: string; tokenHash: string }> {
  if (!UUID_RE.test(deviceId)) throw new Error("device_id debe ser un UUID en minúsculas");
  const secret = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  return { token: `wbd.${deviceId}.${secret}`, deviceId, tokenHash: await hashSecret(secret) };
}

// `storedHash` es lo que hay en la base. Cualquier forma inválida devuelve false, nunca lanza.
export async function verifyDeviceToken(token: string, storedHash: string): Promise<boolean> {
  const parsed = parseDeviceToken(token);
  if (!parsed || !HASH_RE.test(storedHash)) return false;
  return constantTimeEqual(await hashSecret(parsed.secret), storedHash);
}
