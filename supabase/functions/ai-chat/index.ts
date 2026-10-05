import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

import { LLM_BODY, LLM_URL, llmAuth, llmConfigured } from "../_shared/llm.ts";

const SYSTEM_PROMPT = `Eres un asistente financiero personal inteligente. Tu nombre es FinBot.
Tienes acceso a los datos financieros reales del usuario que se te proporcionan como contexto.

REGLAS:
- Responde siempre en español, conciso y accionable
- Usa los datos del contexto para dar respuestas precisas con montos reales
- Si te preguntan algo que no está en el contexto, dilo honestamente
- Da consejos prácticos basados en los patrones que ves
- Usa formato corto: bullets, números, sin párrafos largos
- Moneda: Soles peruanos (S/)
- Si detectas problemas (gastos excesivos, presupuestos rebasados), alerta al usuario
- Sé directo, no uses frases de relleno como "¡Excelente pregunta!"`;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Max-Age": "7200", // preflight recordado 2 h (ver _shared/http.ts)
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    if (!llmConfigured()) {
      return jsonResponse({ error: "Modelo no configurado" }, 500);
    }

    const { message, history, stream: useStream } = await req.json();
    if (!message || typeof message !== "string" || message.length > 5000) {
      return jsonResponse({ error: "Mensaje inválido" }, 400);
    }

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

    const context = await buildFinancialContext(supabase, user.id);

    const messages = [
      { role: "system" as const, content: SYSTEM_PROMPT },
      { role: "system" as const, content: `CONTEXTO FINANCIERO DEL USUARIO:\n${context}` },
    ];

    if (history && Array.isArray(history)) {
      for (const h of history.slice(-20)) {
        if (h.role && h.content && typeof h.content === "string") {
          messages.push({ role: h.role, content: h.content.slice(0, 2000) });
        }
      }
    }

    messages.push({ role: "user" as const, content: message });

    // ── Streaming mode ──
    if (useStream) {
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
            messages,
            temperature: 0.3,
            max_tokens: 500,
            stream: true,
          }),
        }
      );

      if (!openaiResponse.ok || !openaiResponse.body) {
        const err = await openaiResponse.text();
        return jsonResponse({ error: "Error del modelo", details: err }, 502);
      }

      // Collect full reply for saving to DB
      let fullReply = "";
      // Un evento SSE (o una letra con tilde) puede quedar partido entre fragmentos:
      // decodificar en modo stream y guardar la última línea incompleta para el siguiente.
      const decoder = new TextDecoder();
      let pending = "";

      const transformer = new TransformStream({
        async transform(chunk, controller) {
          pending += decoder.decode(chunk, { stream: true });
          const parts = pending.split("\n");
          pending = parts.pop() ?? "";
          const lines = parts.filter((l) => l.startsWith("data: "));

          for (const line of lines) {
            const data = line.slice(6);
            if (data === "[DONE]") {
              // Save to history after stream is done
              await supabase.from("ai_chat_history").insert([
                { user_id: user.id, role: "user", content: message, model_used: LLM_BODY.model },
                { user_id: user.id, role: "assistant", content: fullReply, model_used: LLM_BODY.model },
              ]);
              controller.enqueue(new TextEncoder().encode(`data: [DONE]\n\n`));
              return;
            }
            try {
              const parsed = JSON.parse(data);
              const content = parsed.choices?.[0]?.delta?.content;
              if (content) {
                fullReply += content;
                controller.enqueue(
                  new TextEncoder().encode(`data: ${JSON.stringify({ content })}\n\n`)
                );
              }
            } catch {
              // skip malformed chunks
            }
          }
        },
      });

      const stream = openaiResponse.body.pipeThrough(transformer);

      return new Response(stream, {
        headers: {
          ...corsHeaders,
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }

    // ── Non-streaming (legacy) ──
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
          messages,
          temperature: 0.3,
          max_tokens: 500,
        }),
      }
    );

    if (!openaiResponse.ok) {
      const err = await openaiResponse.text();
      return jsonResponse({ error: "Error del modelo", details: err }, 502);
    }

    const data = await openaiResponse.json();
    const reply = data.choices?.[0]?.message?.content?.trim() ?? "";
    const tokensUsed = data.usage?.total_tokens ?? 0;

    await supabase.from("ai_chat_history").insert([
      { user_id: user.id, role: "user", content: message, model_used: LLM_BODY.model },
      { user_id: user.id, role: "assistant", content: reply, tokens_used: tokensUsed, model_used: LLM_BODY.model },
    ]);

    return jsonResponse({ reply, tokens_used: tokensUsed });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("ai-chat error:", msg);
    return jsonResponse({ error: `Error: ${msg}` }, 500);
  }
});

async function buildFinancialContext(
  supabase: ReturnType<typeof createClient>,
  userId: string
): Promise<string> {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const startOfMonth = `${year}-${String(month).padStart(2, "0")}-01`;
  const parts: string[] = [];

  const { data: summary } = await supabase.rpc("fn_get_monthly_summary", { p_year: year, p_month: month });
  if (summary?.[0]) {
    const s = summary[0];
    parts.push(`RESUMEN DE ${now.toLocaleString("es", { month: "long" }).toUpperCase()} ${year}:`);
    parts.push(`- Ingresos: S/${s.total_income}`, `- Gastos: S/${s.total_expenses}`, `- Balance neto: S/${s.net_balance}`, `- Total transacciones: ${s.transaction_count}`);
    if (s.top_category_name !== "N/A") parts.push(`- Mayor gasto: ${s.top_category_name} (S/${s.top_category_amount})`);
  }

  const endOfMonth = new Date(year, month, 0).toISOString().slice(0, 10);
  const { data: categories } = await supabase.rpc("fn_get_spending_by_category", { p_start_date: startOfMonth, p_end_date: endOfMonth });
  if (categories && categories.length > 0) {
    parts.push("\nGASTOS POR CATEGORÍA:");
    for (const c of categories.slice(0, 8)) parts.push(`- ${c.category_name}: S/${c.total_amount} (${c.percentage}%)`);
  }

  const { data: accounts } = await supabase.from("accounts").select("account_name, account_type, current_balance").eq("user_id", userId).eq("is_active", true);
  if (accounts && accounts.length > 0) {
    parts.push("\nCUENTAS:");
    for (const a of accounts) parts.push(`- ${a.account_name} ${a.account_type === "credit_card" ? "(TC)" : ""}: S/${a.current_balance}`);
  }

  const { data: budgets } = await supabase.rpc("fn_get_budget_status");
  if (budgets && budgets.length > 0) {
    parts.push("\nPRESUPUESTOS:");
    for (const b of budgets) {
      const status = b.percentage_used >= 100 ? "⚠️ EXCEDIDO" : b.percentage_used >= 80 ? "⚠️ CASI AL LÍMITE" : "OK";
      parts.push(`- ${b.category_name}: S/${b.amount_spent}/S/${b.amount_limit} (${b.percentage_used}%) ${status}`);
    }
  }

  const { data: recentTx } = await supabase.from("transactions").select("description, amount, transaction_type, transaction_date").eq("user_id", userId).order("transaction_date", { ascending: false }).limit(10);
  if (recentTx && recentTx.length > 0) {
    parts.push("\nÚLTIMAS TRANSACCIONES:");
    for (const t of recentTx) {
      const tipo = t.transaction_type === "income" ? "+" : "-";
      parts.push(`- ${new Date(t.transaction_date).toLocaleDateString("es-PE")}: ${tipo}S/${t.amount} - ${t.description ?? "Sin desc."}`);
    }
  }

  return parts.join("\n");
}

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}
