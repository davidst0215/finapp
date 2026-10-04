import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { json, preflight, requireUser } from "../_shared/http.ts";
import { bearer, jwtSub } from "../_shared/jwt.ts";
import { LLM_BODY, LLM_URL, llmAuth, llmConfigured, parseModelJson } from "../_shared/llm.ts";

const SYSTEM_PROMPT = `Eres un lector de boletas y recibos de compra en Perú.
El usuario te envía una foto de una boleta/recibo/factura. Extrae:

REGLAS:
- Moneda por defecto: PEN (soles peruanos)
- Si ves "$" o "USD", usa USD
- Extrae el TOTAL de la boleta (no subtotales)
- La descripción debe ser el nombre del comercio o establecimiento
- Si no puedes leer el monto, devuelve amount: 0
- Todos los recibos son gastos (expense)
- Para la categoría, elige la que mejor coincida de la lista proporcionada

Responde SOLO con JSON válido, sin markdown:
{
  "amount": number,
  "transaction_type": "expense",
  "description": "string (nombre del comercio)",
  "category_name": "string" | null,
  "currency_code": "PEN" | "USD",
  "date": "string (YYYY-MM-DD)" | null,
  "confidence": number (0-1),
  "items_detected": number
}`;

// La web reduce la foto a ≤1600 px en JPEG (~300 KB); 4 MB de base64 es margen de sobra.
const MAX_IMAGEN = 4 * 1024 * 1024;

Deno.serve(async (req: Request) => {
  const pre = preflight(req);
  if (pre) return pre;

  try {
    // La anon key (pública) se corta antes de leer la imagen.
    if (!jwtSub(bearer(req))) return json({ error: "No autorizado" }, 401);
    const auth = await requireUser(req);
    if (auth instanceof Response) return auth;
    const { user, db } = auth;
    if (!llmConfigured()) return json({ error: "Modelo no configurado" }, 500);

    const { image } = await req.json();
    if (!image || typeof image !== "string") return json({ error: "Se requiere 'image' en base64" }, 400);
    if (image.length > MAX_IMAGEN) return json({ error: "La foto es demasiado grande" }, 413);

    const { data: categories } = await db
      .from("categories")
      .select("category_id, category_name, category_type")
      .eq("is_active", true)
      .eq("category_type", "expense")
      .or(`user_id.eq.${user.id},user_id.is.null`);

    const categoryList = (categories ?? []).map((c) => `- ${c.category_name}`).join("\n");

    let mimeType = "image/jpeg";
    if (image.startsWith("iVBOR")) mimeType = "image/png";
    else if (image.startsWith("R0lG")) mimeType = "image/gif";
    else if (image.startsWith("UklGR")) mimeType = "image/webp";

    const res = await fetch(LLM_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: llmAuth() },
      body: JSON.stringify({
        ...LLM_BODY,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "system", content: `CATEGORÍAS DISPONIBLES:\n${categoryList}` },
          {
            role: "user",
            content: [
              { type: "text", text: "Lee esta boleta/recibo y extrae los datos." },
              // "high": con "low" algunos proveedores bajan la foto a ~512 px y el total se vuelve ilegible.
              { type: "image_url", image_url: { url: `data:${mimeType};base64,${image}`, detail: "high" } },
            ],
          },
        ],
        temperature: 0.1,
        max_tokens: 300,
      }),
    });

    if (!res.ok) {
      console.error("parse-receipt modelo:", res.status, (await res.text()).slice(0, 300));
      return json({ error: "No pude leer la boleta. Intenta de nuevo." }, 502);
    }

    const data = await res.json();
    const raw = data.choices?.[0]?.message?.content?.trim() ?? "";

    let parsed: Record<string, unknown>;
    try {
      parsed = parseModelJson(raw);
    } catch {
      return json({ error: "No se pudo leer la boleta" }, 500);
    }

    const amount = Number(parsed.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return json({ error: "No se detectó un monto válido en la boleta" }, 422);
    }

    const categoryName = typeof parsed.category_name === "string" ? parsed.category_name : null;
    const match = categoryName
      ? (categories ?? []).find((c) => c.category_name.toLowerCase() === categoryName.toLowerCase())
      : undefined;

    return json({
      amount,
      transaction_type: "expense",
      description: typeof parsed.description === "string" && parsed.description.trim() ? parsed.description.trim().slice(0, 200) : "Boleta",
      category_id: match?.category_id ?? null,
      category_name: categoryName,
      currency_code: parsed.currency_code === "USD" ? "USD" : "PEN",
      date: typeof parsed.date === "string" ? parsed.date : null,
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
      items_detected: typeof parsed.items_detected === "number" ? parsed.items_detected : 0,
    });
  } catch (error) {
    console.error("parse-receipt error:", error instanceof Error ? error.message : String(error));
    return json({ error: "No pude leer la boleta. Intenta de nuevo." }, 500);
  }
});
