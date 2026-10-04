import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers":
          "authorization, x-client-info, apikey, content-type",
      },
    });
  }

  try {
    if (!llmConfigured()) {
      return jsonResponse({ error: "Modelo no configurado" }, 500);
    }

    const { image } = await req.json();
    if (!image || typeof image !== "string") {
      return jsonResponse({ error: "Se requiere 'image' en base64" }, 400);
    }

    // Auth
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) {
      return jsonResponse({ error: "Token inválido" }, 401);
    }
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const supabase = createClient(supabaseUrl, supabaseKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const {
      data: { user },
    } = await supabase.auth.getUser(authHeader.replace("Bearer ", ""));
    if (!user) {
      return jsonResponse({ error: "No autorizado" }, 401);
    }

    // Get categories for matching
    const { data: categories } = await supabase
      .from("categories")
      .select("category_id, category_name, category_type")
      .eq("is_active", true)
      .eq("category_type", "expense")
      .or(`user_id.eq.${user.id},user_id.is.null`);

    const categoryList = (categories ?? [])
      .map((c) => `- ${c.category_name}`)
      .join("\n");

    // Determine image mime type
    let mimeType = "image/jpeg";
    if (image.startsWith("/9j/")) mimeType = "image/jpeg";
    else if (image.startsWith("iVBOR")) mimeType = "image/png";
    else if (image.startsWith("R0lG")) mimeType = "image/gif";

    // Leer la boleta con el modelo (visión)
    const openaiResponse = await fetch(
      LLM_URL,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: llmAuth(),
        },
        body: JSON.stringify({
          ...LLM_BODY,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            {
              role: "system",
              content: `CATEGORÍAS DISPONIBLES:\n${categoryList}`,
            },
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: "Lee esta boleta/recibo y extrae los datos.",
                },
                {
                  type: "image_url",
                  image_url: {
                    url: `data:${mimeType};base64,${image}`,
                    detail: "low",
                  },
                },
              ],
            },
          ],
          temperature: 0.1,
          max_tokens: 300,
        }),
      }
    );

    if (!openaiResponse.ok) {
      const err = await openaiResponse.text();
      return jsonResponse({ error: "Error del modelo", details: err }, 502);
    }

    const data = await openaiResponse.json();
    const raw = data.choices?.[0]?.message?.content?.trim() ?? "";

    let parsed;
    try {
      parsed = parseModelJson(raw);
    } catch {
      return jsonResponse(
        { error: "No se pudo leer la boleta", raw },
        500
      );
    }

    if (!parsed.amount || parsed.amount <= 0) {
      return jsonResponse(
        { error: "No se detectó un monto válido en la boleta", parsed },
        422
      );
    }

    // Resolve category_id
    let category_id: string | null = null;
    if (parsed.category_name && categories) {
      const match = categories.find(
        (c) => c.category_name.toLowerCase() === parsed.category_name.toLowerCase()
      );
      if (match) category_id = match.category_id;
    }

    return jsonResponse({
      amount: parsed.amount,
      transaction_type: "expense",
      description: parsed.description ?? "Boleta",
      category_id,
      category_name: parsed.category_name,
      currency_code: parsed.currency_code ?? "PEN",
      date: parsed.date,
      confidence: parsed.confidence ?? 0.5,
      items_detected: parsed.items_detected ?? 0,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("parse-receipt error:", msg);
    return jsonResponse({ error: `Error: ${msg}` }, 500);
  }
});

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
