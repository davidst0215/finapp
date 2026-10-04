import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

import { LLM_BODY, LLM_URL, llmAuth, llmConfigured, parseModelJson } from "../_shared/llm.ts";

const SYSTEM_PROMPT = `Eres un parser de comandos de voz para una app de finanzas personales en Perú.
El usuario dicta transacciones por voz. Tu trabajo es extraer datos estructurados del texto.

REGLAS:
- Moneda por defecto: PEN (soles peruanos)
- Si dice "dólares" o "dollars", usa USD
- Si no se especifica tipo, asume "expense" (gasto)
- Palabras clave de ingreso: sueldo, salario, cobré, me pagaron, ingreso, gané, recibí, depositar, freelance
- Palabras clave de gasto: gasté, pagué, compré, costó, me cobró, cuesta
- Para la categoría, elige la que mejor coincida de la lista proporcionada
- Si no encuentras categoría, devuelve null
- La descripción debe ser corta y clara (ej: "Almuerzo", "Uber al trabajo", "Sueldo marzo")
- Extrae el monto numérico. "mil" = 1000, "medio" o "media" puede ser 0.5 o 500 según contexto

Responde SOLO con JSON válido, sin markdown, sin explicaciones:
{
  "amount": number,
  "transaction_type": "income" | "expense",
  "description": "string",
  "category_name": "string" | null,
  "currency_code": "PEN" | "USD",
  "confidence": number (0-1)
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

    const { text } = await req.json();
    if (!text || typeof text !== "string" || text.length > 1000) {
      return jsonResponse({ error: "Se requiere 'text' (máx 1000 chars)" }, 400);
    }

    // Autenticar usuario
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) {
      return jsonResponse({ error: "Token de autorización inválido" }, 401);
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

    // Obtener categorías del usuario para matching
    const { data: categories } = await supabase
      .from("categories")
      .select("category_id, category_name, category_type")
      .eq("is_active", true)
      .or(`user_id.eq.${user.id},user_id.is.null`);

    const categoryList = (categories ?? [])
      .map((c) => `- ${c.category_name} (${c.category_type})`)
      .join("\n");

    // Llamar al modelo
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
            { role: "user", content: text },
          ],
          temperature: 0.1,
          max_tokens: 200,
        }),
      }
    );

    if (!openaiResponse.ok) {
      const err = await openaiResponse.text();
      return jsonResponse({ error: "Error del modelo", details: err }, 502);
    }

    const data = await openaiResponse.json();
    const raw = data.choices?.[0]?.message?.content?.trim() ?? "";

    // Parsear la respuesta JSON del modelo
    let parsed;
    try {
      parsed = parseModelJson(raw);
    } catch {
      return jsonResponse(
        { error: "No se pudo parsear la respuesta de IA", raw },
        500
      );
    }

    // Validar campos requeridos
    if (!parsed.amount || typeof parsed.amount !== "number" || parsed.amount <= 0) {
      return jsonResponse(
        { error: "No se detectó un monto válido", parsed },
        422
      );
    }

    // Resolver category_id desde category_name
    let category_id: string | null = null;
    if (parsed.category_name && categories) {
      const match = categories.find(
        (c) =>
          c.category_name.toLowerCase() === parsed.category_name.toLowerCase() &&
          c.category_type === parsed.transaction_type
      );
      if (match) {
        category_id = match.category_id;
      }
    }

    return jsonResponse({
      amount: parsed.amount,
      transaction_type: parsed.transaction_type ?? "expense",
      description: parsed.description ?? text,
      category_id,
      category_name: parsed.category_name,
      currency_code: parsed.currency_code ?? "PEN",
      confidence: parsed.confidence ?? 0.5,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("parse-voice error:", msg);
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
