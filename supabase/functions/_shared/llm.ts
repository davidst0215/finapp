// Cliente único del modelo de Wabid: MiMo vía OpenRouter, servido fuera de Xiaomi.
const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY");
export const LLM_MODEL = Deno.env.get("LLM_MODEL") ?? "xiaomi/mimo-v2.6-flash";

export function llmConfigured(): boolean {
  return Boolean(OPENROUTER_API_KEY);
}

export const LLM_URL = "https://openrouter.ai/api/v1/chat/completions";
export const llmAuth = () => `Bearer ${OPENROUTER_API_KEY}`;
// Proveedores en orden de preferencia (secreto LLM_PROVIDERS, coma entre slugs de OpenRouter);
// cambiarlo no requiere redeploy. Xiaomi queda fuera siempre.
const PROVEEDORES = (Deno.env.get("LLM_PROVIDERS") ?? "deepinfra")
  .split(",").map((p) => p.trim()).filter((p) => p && p !== "xiaomi");
// Campos fijos de cada request: modelo, proveedor y sin razonamiento (latencia).
export const LLM_BODY = {
  model: LLM_MODEL,
  provider: { order: PROVEEDORES, ignore: ["xiaomi"] },
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
