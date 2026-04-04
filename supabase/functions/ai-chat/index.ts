import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");

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
    if (!OPENAI_API_KEY) {
      return jsonResponse({ error: "OpenAI API key not configured" }, 500);
    }

    const { message, history } = await req.json();
    if (!message) {
      return jsonResponse({ error: "Se requiere el campo 'message'" }, 400);
    }
    if (typeof message !== "string" || message.length > 5000) {
      return jsonResponse({ error: "Mensaje inválido o demasiado largo" }, 400);
    }

    // Conectar a Supabase con el token del usuario
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) {
      return jsonResponse({ error: "Token de autorización inválido" }, 401);
    }
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const supabase = createClient(supabaseUrl, supabaseKey, {
      global: { headers: { Authorization: authHeader } },
    });

    // Obtener el user_id del token
    const {
      data: { user },
    } = await supabase.auth.getUser(authHeader.replace("Bearer ", ""));
    if (!user) {
      return jsonResponse({ error: "No autorizado" }, 401);
    }

    // Construir contexto financiero real
    const context = await buildFinancialContext(supabase, user.id);

    // Preparar mensajes para OpenAI
    const messages = [
      { role: "system" as const, content: SYSTEM_PROMPT },
      {
        role: "system" as const,
        content: `CONTEXTO FINANCIERO DEL USUARIO:\n${context}`,
      },
    ];

    // Agregar historial (últimos 20 mensajes)
    if (history && Array.isArray(history)) {
      const recent = history.slice(-20);
      for (const h of recent) {
        if (h.role && h.content && typeof h.content === "string") {
          messages.push({ role: h.role, content: h.content.slice(0, 2000) });
        }
      }
    }

    messages.push({ role: "user" as const, content: message });

    // Llamar a OpenAI
    const openaiResponse = await fetch(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages,
          temperature: 0.3,
          max_tokens: 500,
        }),
      }
    );

    if (!openaiResponse.ok) {
      const err = await openaiResponse.text();
      return jsonResponse({ error: "Error de OpenAI", details: err }, 502);
    }

    const data = await openaiResponse.json();
    const reply = data.choices?.[0]?.message?.content?.trim() ?? "";
    const tokensUsed = data.usage?.total_tokens ?? 0;

    // Guardar en historial
    await supabase.from("ai_chat_history").insert([
      {
        user_id: user.id,
        role: "user",
        content: message,
        model_used: "gpt-4o-mini",
      },
      {
        user_id: user.id,
        role: "assistant",
        content: reply,
        tokens_used: tokensUsed,
        model_used: "gpt-4o-mini",
      },
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

  // 1. Resumen del mes
  const { data: summary } = await supabase.rpc("fn_get_monthly_summary", {
    p_year: year,
    p_month: month,
  });
  if (summary?.[0]) {
    const s = summary[0];
    parts.push(`RESUMEN DE ${now.toLocaleString("es", { month: "long" }).toUpperCase()} ${year}:`);
    parts.push(`- Ingresos: S/${s.total_income}`);
    parts.push(`- Gastos: S/${s.total_expenses}`);
    parts.push(`- Balance neto: S/${s.net_balance}`);
    parts.push(`- Total transacciones: ${s.transaction_count}`);
    if (s.top_category_name !== "N/A") {
      parts.push(
        `- Mayor gasto: ${s.top_category_name} (S/${s.top_category_amount})`
      );
    }
  }

  // 2. Gastos por categoría
  const endOfMonth = new Date(year, month, 0).toISOString().slice(0, 10);
  const { data: categories } = await supabase.rpc(
    "fn_get_spending_by_category",
    { p_start_date: startOfMonth, p_end_date: endOfMonth }
  );
  if (categories && categories.length > 0) {
    parts.push("\nGASTOS POR CATEGORÍA:");
    for (const c of categories.slice(0, 8)) {
      parts.push(`- ${c.category_name}: S/${c.total_amount} (${c.percentage}%)`);
    }
  }

  // 3. Cuentas
  const { data: accounts } = await supabase
    .from("accounts")
    .select("account_name, account_type, current_balance")
    .eq("user_id", userId)
    .eq("is_active", true);
  if (accounts && accounts.length > 0) {
    parts.push("\nCUENTAS:");
    for (const a of accounts) {
      const tipo =
        a.account_type === "credit_card" ? "(Tarjeta crédito)" : "";
      parts.push(`- ${a.account_name} ${tipo}: S/${a.current_balance}`);
    }
  }

  // 4. Presupuestos
  const { data: budgets } = await supabase.rpc("fn_get_budget_status");
  if (budgets && budgets.length > 0) {
    parts.push("\nPRESUPUESTOS:");
    for (const b of budgets) {
      const status =
        b.percentage_used >= 100
          ? "⚠️ EXCEDIDO"
          : b.percentage_used >= 80
            ? "⚠️ CASI AL LÍMITE"
            : "OK";
      parts.push(
        `- ${b.category_name}: S/${b.amount_spent}/S/${b.amount_limit} (${b.percentage_used}%) ${status}`
      );
    }
  }

  // 5. Recurrentes
  const { data: recurrings } = await supabase
    .from("recurring_transactions")
    .select("description, amount, frequency, next_due_date")
    .eq("user_id", userId)
    .eq("is_active", true)
    .order("next_due_date");
  if (recurrings && recurrings.length > 0) {
    parts.push("\nPAGOS RECURRENTES:");
    for (const r of recurrings) {
      parts.push(
        `- ${r.description}: S/${r.amount} (${r.frequency}) - próximo: ${r.next_due_date}`
      );
    }
  }

  // 6. Metas de ahorro
  const { data: goals } = await supabase
    .from("savings_goals")
    .select("goal_name, target_amount, current_amount, target_date")
    .eq("user_id", userId)
    .eq("is_completed", false);
  if (goals && goals.length > 0) {
    parts.push("\nMETAS DE AHORRO:");
    for (const g of goals) {
      const pct = ((g.current_amount / g.target_amount) * 100).toFixed(0);
      parts.push(
        `- ${g.goal_name}: S/${g.current_amount}/S/${g.target_amount} (${pct}%)${g.target_date ? ` - fecha: ${g.target_date}` : ""}`
      );
    }
  }

  // 7. Últimas 10 transacciones
  const { data: recentTx } = await supabase
    .from("transactions")
    .select("description, amount, transaction_type, transaction_date, input_method")
    .eq("user_id", userId)
    .order("transaction_date", { ascending: false })
    .limit(10);
  if (recentTx && recentTx.length > 0) {
    parts.push("\nÚLTIMAS TRANSACCIONES:");
    for (const t of recentTx) {
      const tipo = t.transaction_type === "income" ? "+" : "-";
      const fecha = new Date(t.transaction_date).toLocaleDateString("es-PE");
      parts.push(`- ${fecha}: ${tipo}S/${t.amount} - ${t.description ?? "Sin desc."}`);
    }
  }

  return parts.join("\n");
}

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
