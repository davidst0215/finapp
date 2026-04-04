import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");

const ANALYSIS_PROMPT = `Eres un analista financiero personal. Recibes datos de dos meses del usuario y generas un análisis breve y accionable.

FORMATO DE RESPUESTA (JSON):
{
  "summary": "Resumen en 1-2 oraciones del estado financiero",
  "insights": [
    "Insight 1 (máximo 15 palabras)",
    "Insight 2",
    "Insight 3"
  ],
  "alerts": [
    "Alerta si algo preocupante (0-3 alertas)"
  ],
  "tips": [
    "Consejo accionable 1",
    "Consejo accionable 2"
  ],
  "score": 1-10
}

REGLAS:
- score: 1-3 malo, 4-6 regular, 7-8 bueno, 9-10 excelente
- Moneda: Soles (S/)
- Compara mes actual vs anterior
- Detecta tendencias, gastos inusuales, oportunidades de ahorro
- Responde SOLO con JSON válido`;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
      },
    });
  }

  try {
    if (!OPENAI_API_KEY) {
      return jsonResponse({ error: "OpenAI API key not configured" }, 500);
    }

    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) {
      return jsonResponse({ error: "Token de autorización inválido" }, 401);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const supabase = createClient(supabaseUrl, supabaseKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user } } = await supabase.auth.getUser(authHeader.replace("Bearer ", ""));
    if (!user) return jsonResponse({ error: "No autorizado" }, 401);

    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth() + 1;
    let prevMonth = currentMonth - 1;
    let prevYear = currentYear;
    if (prevMonth <= 0) { prevMonth = 12; prevYear -= 1; }

    // Datos mes actual
    const { data: currentSummary } = await supabase.rpc("fn_get_monthly_summary", {
      p_year: currentYear, p_month: currentMonth,
    });

    // Datos mes anterior
    const { data: prevSummary } = await supabase.rpc("fn_get_monthly_summary", {
      p_year: prevYear, p_month: prevMonth,
    });

    // Gastos por categoría actual
    const startCurrent = `${currentYear}-${String(currentMonth).padStart(2, "0")}-01`;
    const endCurrent = new Date(currentYear, currentMonth, 0).toISOString().slice(0, 10);
    const { data: currentCategories } = await supabase.rpc("fn_get_spending_by_category", {
      p_start_date: startCurrent, p_end_date: endCurrent,
    });

    // Gastos por categoría anterior
    const startPrev = `${prevYear}-${String(prevMonth).padStart(2, "0")}-01`;
    const endPrev = new Date(prevYear, prevMonth, 0).toISOString().slice(0, 10);
    const { data: prevCategories } = await supabase.rpc("fn_get_spending_by_category", {
      p_start_date: startPrev, p_end_date: endPrev,
    });

    // Presupuestos
    const { data: budgets } = await supabase.rpc("fn_get_budget_status");

    const context = `
MES ACTUAL (${currentMonth}/${currentYear}):
${JSON.stringify(currentSummary?.[0] ?? {})}
Categorías: ${JSON.stringify(currentCategories ?? [])}

MES ANTERIOR (${prevMonth}/${prevYear}):
${JSON.stringify(prevSummary?.[0] ?? {})}
Categorías: ${JSON.stringify(prevCategories ?? [])}

PRESUPUESTOS: ${JSON.stringify(budgets ?? [])}
`;

    const openaiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: ANALYSIS_PROMPT },
          { role: "user", content: context },
        ],
        temperature: 0.2,
        max_tokens: 500,
      }),
    });

    if (!openaiResponse.ok) {
      const err = await openaiResponse.text();
      return jsonResponse({ error: "Error de OpenAI", details: err }, 502);
    }

    const data = await openaiResponse.json();
    const content = data.choices?.[0]?.message?.content?.trim() ?? "";

    let analysis;
    try {
      analysis = JSON.parse(content);
    } catch {
      return jsonResponse({ error: "No se pudo interpretar la respuesta del análisis. Intenta de nuevo." }, 502);
    }

    return jsonResponse({
      analysis,
      current_month: { year: currentYear, month: currentMonth, ...currentSummary?.[0] },
      prev_month: { year: prevYear, month: prevMonth, ...prevSummary?.[0] },
    });
  } catch (error) {
    console.error("ai-analysis error:", error);
    return jsonResponse({ error: "Error interno del servidor. Intenta de nuevo." }, 500);
  }
});

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}
