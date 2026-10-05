// Cliente único del modelo de Wabid: MiMo vía OpenRouter, servido fuera de Xiaomi.
import { conRespaldo } from "./respaldo.ts";

const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY");
export const LLM_MODEL = Deno.env.get("LLM_MODEL") ?? "xiaomi/mimo-v2.6-flash";

export function llmConfigured(): boolean {
  return Boolean(OPENROUTER_API_KEY);
}

export const LLM_URL = "https://openrouter.ai/api/v1/chat/completions";
export const llmAuth = () => `Bearer ${OPENROUTER_API_KEY}`;
// Proveedores en orden de preferencia (secreto LLM_PROVIDERS, coma entre slugs de OpenRouter);
// cambiarlo no requiere redeploy. Xiaomi queda fuera siempre. Por defecto, los tres más rápidos con
// cero retención medidos el 5-oct (32 pedidos tipo Wabid): Io Net el más parejo (p50 2.0 s, p90 2.4 s),
// DeepInfra (p50 1.8 s pero p90 5.5 s) y Novita (p50 2.5 s, p90 4.2 s).
const configurados = (Deno.env.get("LLM_PROVIDERS") ?? "")
  .split(",").map((p) => p.trim()).filter((p) => p && p !== "xiaomi");
const PROVEEDORES = configurados.length ? configurados : ["io-net", "deepinfra", "novita"];

// `only`: si los proveedores elegidos fallan, OpenRouter NO cae en otros que nadie revisó (privacidad de
// los datos de David); `zdr`: de esos, solo endpoints sin retención de datos. Dentro de la lista, un
// proveedor caído pasa al siguiente (`allow_fallbacks`).
const proveedor = (orden: string[]) => ({ order: orden, only: PROVEEDORES, zdr: true, allow_fallbacks: true, ignore: ["xiaomi"] });

// Campos fijos de cada request: modelo, proveedor y sin razonamiento (latencia).
export const LLM_BODY = {
  model: LLM_MODEL,
  provider: proveedor(PROVEEDORES),
  reasoning: { enabled: false },
};

// El modelo a veces envuelve el JSON en ```json … ``` o le agrega texto alrededor.
export function parseModelJson<T = Record<string, unknown>>(text: string): T {
  const limpio = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  try {
    return JSON.parse(limpio) as T;
  } catch {
    const ini = limpio.indexOf("{");
    const fin = limpio.lastIndexOf("}");
    if (ini >= 0 && fin > ini) return JSON.parse(limpio.slice(ini, fin + 1)) as T;
    throw new Error("La respuesta del modelo no es JSON");
  }
}

export function llmFetch(body: Record<string, unknown>): Promise<Response> {
  return fetch(LLM_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: llmAuth(), "X-Title": "Wabid" },
    body: JSON.stringify({ ...LLM_BODY, ...body }),
  });
}

export type LlmRespuesta = { ok: boolean; status: number; cuerpo: string; respaldo: boolean };

/**
 * Para la voz: si el modelo no terminó en `esperaMs`, un segundo pedido empieza por el siguiente proveedor
 * y gana el que responda primero (ver respaldo.ts). OpenRouter manda los headers de inmediato y el cuerpo
 * cuando el modelo termina, así que cada intento cuenta hasta leer el cuerpo.
 */
export function llmConRespaldo(body: Record<string, unknown>, esperaMs: number): Promise<LlmRespuesta> {
  const rotado = [...PROVEEDORES.slice(1), PROVEEDORES[0]];
  const pedir = async (respaldo: boolean, signal?: AbortSignal) => {
    const r = await fetch(LLM_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: llmAuth(), "X-Title": "Wabid" },
      body: JSON.stringify({ ...LLM_BODY, provider: proveedor(respaldo ? rotado : PROVEEDORES), ...body }),
      signal,
    });
    return { ok: r.ok, status: r.status, cuerpo: await r.text() };
  };
  // Con un solo proveedor no hay a quién pedirle el respaldo.
  if (PROVEEDORES.length < 2) return pedir(false).then((r) => ({ ...r, respaldo: false }));
  return conRespaldo(pedir, esperaMs);
}
