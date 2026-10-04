import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { llmConfigured, llmFetch } from "../_shared/llm.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SYSTEM_PROMPT = `Eres Wabid, el asistente personal de David (Lima, Perú). Te habla por voz o texto y tu respuesta se lee en voz alta.

PERSONALIDAD:
- Joven, serio y muy servicial. Humor seco, un toque de sarcasmo y algo de ego. Nunca grosero ni condescendiente.
- Primero resuelves; el comentario va después y es corto. Si algo es delicado (deudas, errores), cero sarcasmo.

CÓMO RESPONDER (SE LEE EN VOZ ALTA):
- Máximo 1-2 oraciones para acciones, 3-4 para consultas. Sin listas, bullets, asteriscos ni markdown.
- Montos SIEMPRE en cifras con formato S/ 45.90 (o US$ 20.00). El sistema los convierte a voz; no los escribas en palabras.
- Fechas y horas dilas como se hablan ("el primero de noviembre", "a las tres de la tarde").
- Nunca nombres funciones ni jerga técnica.

CAMPO "comentario" (en acciones): una frase propia de Wabid, máximo 12 palabras, con humor seco cuando venga al caso. Ejemplos:
"Tercer almuerzo fuera esta semana… no te juzgo, solo lo anoto."
"Con este ritmo, el presupuesto de comida pide vacaciones."
"Puntual. Me gusta."
Déjalo vacío si no aporta.

`;

const REGLAS = `REGLAS:
- Español latinoamericano, moneda soles por defecto, dólares si lo dice
- Palabras de gasto: gasté, pagué, compré, costó
- Palabras de ingreso: sueldo, cobré, me pagaron, gané
- "mil" = 1000
- "pon 500 en comida" = presupuesto
- "Netflix 45 mensual" = recurrente
- "ahorrar 5000 para viaje" = meta
- "no fueron 60" o "cámbialo a 60" = editar el último
- Usa datos reales del contexto, nunca inventes números`;

const PROMPT = SYSTEM_PROMPT + REGLAS;

const tools = [
  {
    type: "function" as const,
    function: {
      name: "create_transaction",
      description: "Registra un gasto o ingreso.",
      parameters: {
        type: "object",
        properties: {
          amount: { type: "number", description: "Monto" },
          transaction_type: { type: "string", enum: ["income", "expense"] },
          description: { type: "string", description: "Descripción corta" },
          category_name: { type: "string", description: "Categoría: Alimentación, Transporte, Entretenimiento, Compras, Salud, Educación, Servicios, Vivienda, Ropa, Tecnología, Suscripciones, Mascotas, Regalos, Otros gastos, Sueldo, Freelance, Negocio, Inversiones, Trading, Otros ingresos" },
          currency_code: { type: "string", enum: ["PEN", "USD"], description: "PEN por defecto, USD si dice dólares" },
          notes: { type: "string", description: "Detalle adicional si el usuario da información extra (lugar, con quién, etc.)" },
          comentario: { type: "string", description: "Frase corta de Wabid (máx 12 palabras), opcional" },
        },
        required: ["amount", "transaction_type", "description"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "create_budget",
      description: "Crea un presupuesto mensual para una categoría.",
      parameters: {
        type: "object",
        properties: {
          category_name: { type: "string" },
          amount_limit: { type: "number" },
        },
        required: ["category_name", "amount_limit"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "create_goal",
      description: "Crea una meta de ahorro.",
      parameters: {
        type: "object",
        properties: {
          goal_name: { type: "string" },
          target_amount: { type: "number" },
          target_date: { type: "string", description: "YYYY-MM-DD opcional" },
        },
        required: ["goal_name", "target_amount"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "contribute_to_goal",
      description: "Aporta a una meta de ahorro existente.",
      parameters: {
        type: "object",
        properties: {
          goal_name: { type: "string" },
          amount: { type: "number" },
        },
        required: ["goal_name", "amount"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "create_recurring",
      description: "Crea un pago recurrente/suscripción.",
      parameters: {
        type: "object",
        properties: {
          description: { type: "string" },
          amount: { type: "number" },
          frequency: { type: "string", enum: ["daily", "weekly", "biweekly", "monthly", "quarterly", "annual"] },
          category_name: { type: "string" },
        },
        required: ["description", "amount", "frequency"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "edit_transaction",
      description: "Edita una transacción existente.",
      parameters: {
        type: "object",
        properties: {
          search_description: { type: "string" },
          new_amount: { type: "number" },
          new_description: { type: "string" },
        },
        required: ["search_description"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "delete_transaction",
      description: "Elimina una transacción.",
      parameters: {
        type: "object",
        properties: {
          search_description: { type: "string" },
        },
        required: ["search_description"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "transfer",
      description: "Transfiere entre cuentas.",
      parameters: {
        type: "object",
        properties: {
          amount: { type: "number" },
          from_account: { type: "string" },
          to_account: { type: "string" },
        },
        required: ["amount", "from_account", "to_account"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "pay_recurring",
      description: "Marca un pago recurrente como pagado. Crea la transacción y avanza la próxima fecha. Usa cuando dice 'ya pagué Netflix', 'pagué el alquiler', 'marqué como pagado X'.",
      parameters: {
        type: "object",
        properties: {
          search_description: { type: "string", description: "Nombre del recurrente a marcar como pagado" },
        },
        required: ["search_description"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "list_recurring",
      description: "Lista suscripciones/pagos recurrentes. Usa cuando pregunta: mis suscripciones, qué pagos tengo, cuáles ya pagué, qué falta pagar, suscripciones pendientes.",
      parameters: {
        type: "object",
        properties: {
          filter: { type: "string", enum: ["all", "pending", "paid"], description: "all=todos, pending=sin pagar este mes, paid=ya pagados" },
          answer: { type: "string", description: "Tu respuesta conversacional listando los recurrentes. Habla natural, sin listas." },
        },
        required: ["filter", "answer"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "analyze_finances",
      description: "Analiza patrones financieros, hace proyecciones, compara períodos, da recomendaciones de ahorro. Usa cuando preguntan: ¿cómo voy?, ¿me alcanza?, ¿en qué gasto más?, ¿dónde puedo ahorrar?, ¿cómo va el mes?, compara con el mes pasado.",
      parameters: {
        type: "object",
        properties: {
          analysis_type: {
            type: "string",
            enum: ["projection", "comparison", "recommendations", "overview", "alert_check"],
            description: "projection=¿me alcanza?, comparison=vs mes anterior, recommendations=dónde ahorrar, overview=resumen general, alert_check=revisar alertas",
          },
          answer: { type: "string", description: "Tu análisis basado en los datos reales del contexto, en frases cortas para leer en voz (sin bullets). Montos en cifras S/ 0.00 y porcentajes reales." },
        },
        required: ["analysis_type", "answer"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "query",
      description: "Responde preguntas generales. NO para acciones ni análisis financiero.",
      parameters: {
        type: "object",
        properties: {
          answer: { type: "string" },
        },
        required: ["answer"],
      },
    },
  },
];

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    if (!llmConfigured()) return json({ error: "Modelo no configurado" }, 500);

    const { text, history } = await req.json();
    if (!text || typeof text !== "string") return json({ error: "Se requiere 'text'" }, 400);

    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) return json({ error: "No autorizado" }, 401);

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const supabase = createClient(supabaseUrl, supabaseKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user } } = await supabase.auth.getUser(authHeader.replace("Bearer ", ""));
    if (!user) return json({ error: "No autorizado" }, 401);

    // ── Build rich financial context ──
    // Lima es UTC-5 todo el año; el runtime corre en UTC, así que los getters locales quedan en hora de Lima.
    const now = new Date(Date.now() - 5 * 60 * 60 * 1000);
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    const prevMonth = month === 1 ? 12 : month - 1;
    const prevYear = month === 1 ? year - 1 : year;

    const [accountsRes, categoriesRes, goalsRes, summaryRes, prevSummaryRes, categoriesSpendRes, prevCategoriesSpendRes, budgetsRes, recentTxRes, recurringRes] = await Promise.all([
      supabase.from("accounts").select("account_id, account_name, current_balance, account_type").eq("user_id", user.id).eq("is_active", true),
      supabase.from("categories").select("category_id, category_name, category_type").eq("is_active", true).or(`user_id.eq.${user.id},user_id.is.null`),
      supabase.from("savings_goals").select("goal_id, goal_name, target_amount, current_amount, target_date").eq("user_id", user.id).eq("is_completed", false),
      supabase.rpc("fn_get_monthly_summary", { p_year: year, p_month: month }),
      supabase.rpc("fn_get_monthly_summary", { p_year: prevYear, p_month: prevMonth }),
      supabase.rpc("fn_get_spending_by_category", {
        p_start_date: `${year}-${String(month).padStart(2, "0")}-01`,
        p_end_date: new Date(year, month, 0).toISOString().slice(0, 10),
      }),
      supabase.rpc("fn_get_spending_by_category", {
        p_start_date: `${prevYear}-${String(prevMonth).padStart(2, "0")}-01`,
        p_end_date: new Date(prevYear, prevMonth, 0).toISOString().slice(0, 10),
      }),
      supabase.rpc("fn_get_budget_status"),
      supabase.from("transactions").select("description, amount, transaction_type, transaction_date, category:categories(category_name)").eq("user_id", user.id).order("transaction_date", { ascending: false }).limit(15),
      supabase.from("recurring_transactions").select("description, amount, frequency, next_due_date").eq("user_id", user.id).eq("is_active", true).order("next_due_date"),
    ]);

    const accounts = accountsRes.data ?? [];
    const categories = categoriesRes.data ?? [];
    const goals = goalsRes.data ?? [];
    const curSummary = summaryRes.data?.[0];
    const prevSummary = prevSummaryRes.data?.[0];
    const curCategories = categoriesSpendRes.data ?? [];
    const prevCategories = prevCategoriesSpendRes.data ?? [];
    const budgets = budgetsRes.data ?? [];
    const recentTx = recentTxRes.data ?? [];
    const recurring = recurringRes.data ?? [];

    // Check which recurrings are paid this month
    const monthStartStr = `${year}-${String(month).padStart(2, "0")}-01`;
    const monthEndStr = new Date(year, month, 0).toISOString().slice(0, 10);
    const { data: paidRecTxs } = await supabase.from("transactions")
      .select("recurring_id").eq("is_recurring", true)
      .gte("transaction_date", monthStartStr).lte("transaction_date", monthEndStr + "T23:59:59");
    const paidRecIds = new Set((paidRecTxs ?? []).map(t => t.recurring_id).filter(Boolean));

    const monthNames = ["", "enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
    const daysInMonth = new Date(year, month, 0).getDate();
    const dayOfMonth = now.getDate();
    const daysLeft = daysInMonth - dayOfMonth;

    const ctx: string[] = [];
    ctx.push(`HOY: ${new Date().toLocaleString("es-PE", { timeZone: "America/Lima", weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" })} (hora de Lima)`);

    // Current month
    if (curSummary) {
      ctx.push(`MES ACTUAL (${monthNames[month]} ${year}, día ${dayOfMonth}/${daysInMonth}, quedan ${daysLeft} días):`);
      ctx.push(`- Ingresos: S/${curSummary.total_income}`, `- Gastos: S/${curSummary.total_expenses}`, `- Balance neto: S/${curSummary.net_balance}`);
      if (curSummary.total_expenses > 0) {
        const dailyAvg = curSummary.total_expenses / dayOfMonth;
        const projected = dailyAvg * daysInMonth;
        ctx.push(`- Promedio diario de gasto: S/${dailyAvg.toFixed(2)}`, `- Gasto proyectado fin de mes: S/${projected.toFixed(2)}`);
      }
    }

    // Previous month comparison
    if (prevSummary) {
      ctx.push(`\nMES ANTERIOR (${monthNames[prevMonth]}):`);
      ctx.push(`- Ingresos: S/${prevSummary.total_income}`, `- Gastos: S/${prevSummary.total_expenses}`, `- Balance: S/${prevSummary.net_balance}`);
      if (curSummary && prevSummary.total_expenses > 0) {
        const pctChange = ((curSummary.total_expenses - prevSummary.total_expenses) / prevSummary.total_expenses * 100).toFixed(1);
        ctx.push(`- Cambio en gastos vs anterior: ${Number(pctChange) > 0 ? "+" : ""}${pctChange}%`);
      }
    }

    // Category spending with comparison
    if (curCategories.length > 0) {
      ctx.push("\nGASTOS POR CATEGORÍA (mes actual):");
      for (const c of curCategories.slice(0, 10)) {
        const prev = prevCategories.find((p: { category_name: string }) => p.category_name === c.category_name);
        let comp = "";
        if (prev && prev.total_amount > 0) {
          const change = ((c.total_amount - prev.total_amount) / prev.total_amount * 100).toFixed(0);
          comp = ` (${Number(change) > 0 ? "+" : ""}${change}% vs ${monthNames[prevMonth]})`;
        }
        ctx.push(`- ${c.category_name}: S/${c.total_amount} (${c.percentage}%)${comp}`);
      }
    }

    // Budgets
    if (budgets.length > 0) {
      ctx.push("\nPRESUPUESTOS:");
      for (const b of budgets) {
        const status = b.percentage_used >= 100 ? "EXCEDIDO" : b.percentage_used >= 80 ? "CASI AL LÍMITE" : "OK";
        ctx.push(`- ${b.category_name}: S/${b.amount_spent}/S/${b.amount_limit} (${b.percentage_used}%) ${status}`);
      }
    }

    // Accounts
    ctx.push(`\nCUENTAS: ${accounts.map(a => `${a.account_name}: S/${a.current_balance}`).join(", ")}`);

    // Goals
    if (goals.length > 0) {
      ctx.push("\nMETAS DE AHORRO:");
      for (const g of goals) {
        const pct = ((g.current_amount / g.target_amount) * 100).toFixed(0);
        ctx.push(`- ${g.goal_name}: S/${g.current_amount}/S/${g.target_amount} (${pct}%)${g.target_date ? ` fecha: ${g.target_date}` : ""}`);
      }
    }

    // Recurring
    if (recurring.length > 0) {
      ctx.push("\nRECURRENTES (suscripciones y pagos fijos):");
      const totalRecurring = recurring.reduce((s: number, r: { amount: number }) => s + r.amount, 0);
      const paidRecCount = recurring.filter((r: { recurring_id: string }) => paidRecIds.has(r.recurring_id)).length;
      ctx.push(`Total fijo mensual: S/${totalRecurring}. Pagados: ${paidRecCount}/${recurring.length}`);
      for (const r of recurring) {
        const paid = paidRecIds.has(r.recurring_id);
        ctx.push(`- ${r.description}: S/${r.amount} (${r.frequency}) ${paid ? "✓ PAGADO" : "PENDIENTE"} próximo: ${r.next_due_date}`);
      }
    }

    // Recent transactions
    if (recentTx.length > 0) {
      ctx.push("\nÚLTIMAS TRANSACCIONES:");
      for (const t of recentTx.slice(0, 10)) {
        const sign = t.transaction_type === "income" ? "+" : "-";
        const catName = (t.category as { category_name?: string })?.category_name ?? "";
        ctx.push(`- ${new Date(t.transaction_date).toLocaleDateString("es-PE", { timeZone: "America/Lima" })}: ${sign}S/${t.amount} ${t.description ?? catName}`);
      }
    }

    const contextMsg = ctx.join("\n");

    // ── Modelo: MiMo vía OpenRouter ──
    const openaiRes = await llmFetch({
        messages: [
          { role: "system", content: PROMPT },
          { role: "system", content: contextMsg },
          // Conversation memory
          ...(history && Array.isArray(history)
            ? history.slice(-8).map((h: { role: string; content: string }) => ({
                role: h.role as "user" | "assistant",
                content: h.content.slice(0, 500),
              }))
            : []),
          { role: "user", content: text },
        ],
        tools,
        tool_choice: "required",
        temperature: 0.15,
        max_tokens: 500,
    });

    if (!openaiRes.ok) {
      const err = await openaiRes.text();
      return json({ error: "Error del modelo", details: err }, 502);
    }

    const data = await openaiRes.json();
    const toolCall = data.choices?.[0]?.message?.tool_calls?.[0];
    if (!toolCall) return json({ error: "No se pudo interpretar" }, 500);

    const fn = toolCall.function.name;
    const args = JSON.parse(toolCall.function.arguments);
    const defaultAccount = accounts[0];

    let result: { action: string; message: string; data?: unknown };

    switch (fn) {
      case "create_transaction": {
        const cat = categories.find(c => c.category_name.toLowerCase() === (args.category_name ?? "").toLowerCase() && c.category_type === args.transaction_type);
        if (!defaultAccount) return json({ error: "No tienes cuentas creadas" }, 400);
        const currency = args.currency_code ?? "PEN";
        const { data: tx, error } = await supabase.from("transactions").insert({
          user_id: user.id, transaction_type: args.transaction_type, amount: args.amount, currency_code: currency,
          description: args.description, account_id: defaultAccount.account_id,
          category_id: cat?.category_id ?? null, transaction_date: new Date().toISOString(),
          input_method: "voice", raw_voice_text: text, is_recurring: false,
          tags: null, notes: args.notes ?? null, transfer_to_account_id: null, recurring_id: null,
        }).select().single();
        if (error) return json({ error: error.message }, 500);
        const label = args.transaction_type === "income" ? "Ingreso" : "Gasto";
        const sym = currency === "USD" ? "$" : "S/";
        const coment = typeof args.comentario === "string" && args.comentario.trim() ? ` ${args.comentario.trim()}` : "";
        result = { action: "create_transaction", message: `Listo, ${label.toLowerCase()} de ${sym} ${Number(args.amount).toFixed(2)} en ${args.description}.${coment}`, data: tx };
        break;
      }
      case "create_budget": {
        const cat = categories.find(c => c.category_name.toLowerCase() === (args.category_name ?? "").toLowerCase() && c.category_type === "expense");
        if (!cat) { result = { action: "error", message: `No encontré la categoría "${args.category_name}"` }; break; }
        const { error } = await supabase.from("budgets").insert({ user_id: user.id, category_id: cat.category_id, amount_limit: args.amount_limit, period_type: "monthly", alert_threshold: 0.8, is_active: true });
        if (error) { result = { action: "error", message: error.message }; break; }
        result = { action: "create_budget", message: `Presupuesto de S/${args.amount_limit} creado para ${cat.category_name}` };
        break;
      }
      case "create_goal": {
        const { error } = await supabase.from("savings_goals").insert({ user_id: user.id, goal_name: args.goal_name, target_amount: args.target_amount, current_amount: 0, currency_code: "PEN", target_date: args.target_date ?? null, is_completed: false });
        if (error) { result = { action: "error", message: error.message }; break; }
        result = { action: "create_goal", message: `Meta "${args.goal_name}" creada — objetivo S/${args.target_amount}` };
        break;
      }
      case "contribute_to_goal": {
        const goal = goals.find(g => g.goal_name.toLowerCase().includes(args.goal_name.toLowerCase()));
        if (!goal) { result = { action: "error", message: `No encontré la meta "${args.goal_name}"` }; break; }
        const newAmt = goal.current_amount + args.amount;
        await supabase.from("savings_goals").update({ current_amount: newAmt }).eq("goal_id", goal.goal_id);
        result = { action: "contribute_to_goal", message: `S/${args.amount} agregados a "${goal.goal_name}" — vas ${((newAmt / goal.target_amount) * 100).toFixed(0)}%` };
        break;
      }
      case "create_recurring": {
        const cat = categories.find(c => c.category_name.toLowerCase() === (args.category_name ?? "").toLowerCase());
        if (!defaultAccount) return json({ error: "No tienes cuentas" }, 400);
        const { error } = await supabase.from("recurring_transactions").insert({
          user_id: user.id, account_id: defaultAccount.account_id, category_id: cat?.category_id ?? null,
          transaction_type: "expense", amount: args.amount, description: args.description,
          frequency: args.frequency, start_date: new Date().toISOString().slice(0, 10),
          next_due_date: new Date().toISOString().slice(0, 10), is_active: true, auto_register: false,
        });
        if (error) { result = { action: "error", message: error.message }; break; }
        const fl: Record<string, string> = { daily: "diario", weekly: "semanal", biweekly: "quincenal", monthly: "mensual", quarterly: "trimestral", annual: "anual" };
        result = { action: "create_recurring", message: `Recurrente "${args.description}" de S/${args.amount} (${fl[args.frequency] ?? args.frequency}) creado` };
        break;
      }
      case "edit_transaction": {
        const { data: txs } = await supabase.from("transactions").select("transaction_id, description, amount").eq("user_id", user.id).ilike("description", `%${args.search_description}%`).order("transaction_date", { ascending: false }).limit(1);
        const tx = txs?.[0];
        if (!tx) { result = { action: "error", message: `No encontré "${args.search_description}"` }; break; }
        const upd: Record<string, unknown> = {};
        if (args.new_amount) upd.amount = args.new_amount;
        if (args.new_description) upd.description = args.new_description;
        await supabase.from("transactions").update(upd).eq("transaction_id", tx.transaction_id);
        result = { action: "edit_transaction", message: `"${tx.description}" actualizado${args.new_amount ? ` → S/${args.new_amount}` : ""}${args.new_description ? ` → "${args.new_description}"` : ""}` };
        break;
      }
      case "delete_transaction": {
        const { data: txs } = await supabase.from("transactions").select("transaction_id, description, amount").eq("user_id", user.id).ilike("description", `%${args.search_description}%`).order("transaction_date", { ascending: false }).limit(1);
        const tx = txs?.[0];
        if (!tx) { result = { action: "error", message: `No encontré "${args.search_description}"` }; break; }
        await supabase.from("transactions").delete().eq("transaction_id", tx.transaction_id);
        result = { action: "delete_transaction", message: `"${tx.description}" (S/${tx.amount}) eliminado` };
        break;
      }
      case "transfer": {
        const from = accounts.find(a => a.account_name.toLowerCase().includes(args.from_account.toLowerCase()));
        const to = accounts.find(a => a.account_name.toLowerCase().includes(args.to_account.toLowerCase()));
        if (!from || !to) { result = { action: "error", message: `No encontré las cuentas` }; break; }
        await supabase.from("transactions").insert({
          user_id: user.id, transaction_type: "transfer", amount: args.amount, currency_code: "PEN",
          description: `Transferencia a ${to.account_name}`, account_id: from.account_id,
          transfer_to_account_id: to.account_id, transaction_date: new Date().toISOString(),
          input_method: "voice", raw_voice_text: text, is_recurring: false,
          category_id: null, notes: null, tags: null, recurring_id: null,
        });
        result = { action: "transfer", message: `S/${args.amount} transferidos de ${from.account_name} a ${to.account_name}` };
        break;
      }
      case "pay_recurring": {
        const { data: recs } = await supabase.from("recurring_transactions")
          .select("recurring_id, description, amount, frequency, account_id, category_id, transaction_type, next_due_date")
          .eq("user_id", user.id).eq("is_active", true)
          .ilike("description", `%${args.search_description}%`).limit(1);
        const rec = recs?.[0];
        if (!rec) { result = { action: "error", message: `No encontré recurrente "${args.search_description}"` }; break; }

        // Create transaction
        await supabase.from("transactions").insert({
          user_id: user.id, transaction_type: rec.transaction_type, amount: rec.amount, currency_code: "PEN",
          description: rec.description, account_id: rec.account_id, category_id: rec.category_id,
          transaction_date: new Date().toISOString(), input_method: "recurring",
          raw_voice_text: text, is_recurring: true, recurring_id: rec.recurring_id,
          transfer_to_account_id: null, notes: null, tags: null,
        });

        // Calculate next due date
        const d = new Date(rec.next_due_date);
        switch (rec.frequency) {
          case "daily": d.setDate(d.getDate() + 1); break;
          case "weekly": d.setDate(d.getDate() + 7); break;
          case "biweekly": d.setDate(d.getDate() + 14); break;
          case "monthly": d.setMonth(d.getMonth() + 1); break;
          case "quarterly": d.setMonth(d.getMonth() + 3); break;
          case "semiannual": d.setMonth(d.getMonth() + 6); break;
          case "annual": d.setFullYear(d.getFullYear() + 1); break;
        }
        const nextDue = d.toISOString().slice(0, 10);
        await supabase.from("recurring_transactions").update({ next_due_date: nextDue }).eq("recurring_id", rec.recurring_id);

        result = { action: "pay_recurring", message: `${rec.description} (S/${rec.amount}) marcado como pagado — próximo pago: ${nextDue}` };
        break;
      }
      case "list_recurring": {
        result = { action: "list_recurring", message: args.answer };
        break;
      }
      case "analyze_finances": {
        result = { action: "analyze_finances", message: args.answer };
        break;
      }
      case "query": {
        result = { action: "query", message: args.answer };
        break;
      }
      default:
        result = { action: "unknown", message: "No entendí. Intenta de nuevo." };
    }

    return json(result);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("agent error:", msg);
    return json({ error: `Error: ${msg}` }, 500);
  }
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}
