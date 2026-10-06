import { comentario, conComentario } from "../prompt.ts";
import { type AgentContext, type AgentModule, tool } from "../types.ts";
import { type FiltroRecurrentes, type Recurrente, resumenRecurrentes } from "./recurrentes.ts";
import { rangoSemana } from "./semana.ts";

type Account = { account_id: string; account_name: string; current_balance: number; account_type: string };
type Category = { category_id: string; category_name: string; category_type: string };
type Goal = { goal_id: string; goal_name: string; target_amount: number; current_amount: number; target_date: string | null };
type Data = { accounts: Account[]; categories: Category[]; goals: Goal[]; recurring: Recurrente[]; paidIds: Set<string>; recurrentesOk: boolean };

const MESES = ["", "enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const FRECUENCIA: Record<string, string> = { daily: "diario", weekly: "semanal", biweekly: "quincenal", monthly: "mensual", quarterly: "trimestral", annual: "anual" };

const rules = `FINANZAS:
- Moneda soles por defecto, dólares si lo dice. "mil" = 1000.
- Gasto: gasté, pagué, compré, costó. Ingreso: sueldo, cobré, me pagaron, gané.
- "pon 500 en comida" = presupuesto. "Netflix 45 mensual" = recurrente. "ahorrar 5000 para viaje" = meta.
- "no fueron 60" o "cámbialo a 60" = editar el último.`;

async function loadContext(ctx: AgentContext): Promise<{ prompt: string; data: Data }> {
  const { supabase, user, limaNow } = ctx;
  const year = limaNow.getFullYear();
  const month = limaNow.getMonth() + 1;
  const prevMonth = month === 1 ? 12 : month - 1;
  const prevYear = month === 1 ? year - 1 : year;
  const monthStart = `${year}-${String(month).padStart(2, "0")}-01`;
  const monthEnd = new Date(year, month, 0).toISOString().slice(0, 10);
  const nextMonthStart = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, "0")}-01`;
  const semana = rangoSemana(limaNow);

  const [accountsRes, categoriesRes, goalsRes, summaryRes, prevSummaryRes, spendRes, prevSpendRes, budgetsRes, recentRes, recurringRes, paidRes, weekRes, last7Res] = await Promise.all([
    supabase.from("accounts").select("account_id, account_name, current_balance, account_type").eq("user_id", user.id).eq("is_active", true),
    supabase.from("categories").select("category_id, category_name, category_type").eq("is_active", true).or(`user_id.eq.${user.id},user_id.is.null`),
    supabase.from("savings_goals").select("goal_id, goal_name, target_amount, current_amount, target_date").eq("user_id", user.id).eq("is_completed", false),
    supabase.rpc("fn_get_monthly_summary", { p_year: year, p_month: month }),
    supabase.rpc("fn_get_monthly_summary", { p_year: prevYear, p_month: prevMonth }),
    supabase.rpc("fn_get_spending_by_category", { p_start_date: monthStart, p_end_date: monthEnd }),
    supabase.rpc("fn_get_spending_by_category", {
      p_start_date: `${prevYear}-${String(prevMonth).padStart(2, "0")}-01`,
      p_end_date: new Date(prevYear, prevMonth, 0).toISOString().slice(0, 10),
    }),
    supabase.rpc("fn_get_budget_status"),
    supabase.from("transactions").select("description, amount, transaction_type, transaction_date, category:categories(category_name)")
      .eq("user_id", user.id).order("transaction_date", { ascending: false }).limit(10),
    supabase.from("recurring_transactions").select("recurring_id, description, amount, frequency, next_due_date")
      .eq("user_id", user.id).eq("is_active", true).order("next_due_date"),
    // Pagos de este mes en hora de Lima: un pago a las 20:00 del 30 es del 30, no del 1 (UTC).
    supabase.from("transactions").select("recurring_id").eq("user_id", user.id).eq("is_recurring", true)
      .gte("transaction_date", `${monthStart}T00:00:00-05:00`).lt("transaction_date", `${nextMonthStart}T00:00:00-05:00`),
    supabase.rpc("fn_get_spending_by_category", { p_start_date: semana.lunes, p_end_date: semana.hoy }),
    supabase.rpc("fn_get_spending_by_category", { p_start_date: semana.hace7, p_end_date: semana.hoy }),
  ]);

  const accounts = (accountsRes.data ?? []) as Account[];
  const categories = (categoriesRes.data ?? []) as Category[];
  const goals = (goalsRes.data ?? []) as Goal[];
  const cur = summaryRes.data?.[0];
  const prev = prevSummaryRes.data?.[0];
  const curCats = (spendRes.data ?? []) as { category_name: string; total_amount: number; percentage: number }[];
  const prevCats = (prevSpendRes.data ?? []) as { category_name: string; total_amount: number }[];
  const budgets = (budgetsRes.data ?? []) as { category_name: string; amount_spent: number; amount_limit: number; percentage_used: number }[];
  const recent = recentRes.data ?? [];
  const recurring = (recurringRes.data ?? []) as Recurrente[];
  const paidIds = new Set((paidRes.data ?? []).map((t: { recurring_id: string | null }) => t.recurring_id).filter((id): id is string => Boolean(id)));
  // Con un error de lectura, "no tienes pagos fijos" sería falso e invitaría a duplicarlos.
  const recurrentesOk = !recurringRes.error && !paidRes.error;

  const daysInMonth = new Date(year, month, 0).getDate();
  const day = limaNow.getDate();
  const ctxLines: string[] = [];

  if (cur) {
    ctxLines.push(`MES ACTUAL (${MESES[month]} ${year}, día ${day}/${daysInMonth}, quedan ${daysInMonth - day} días):`);
    ctxLines.push(`- Ingresos: S/${cur.total_income}`, `- Gastos: S/${cur.total_expenses}`, `- Balance neto: S/${cur.net_balance}`);
    if (cur.total_expenses > 0) {
      const dailyAvg = cur.total_expenses / day;
      ctxLines.push(`- Promedio diario de gasto: S/${dailyAvg.toFixed(2)}`, `- Gasto proyectado fin de mes: S/${(dailyAvg * daysInMonth).toFixed(2)}`);
    }
  }
  if (prev) {
    ctxLines.push(`\nMES ANTERIOR (${MESES[prevMonth]}):`);
    ctxLines.push(`- Ingresos: S/${prev.total_income}`, `- Gastos: S/${prev.total_expenses}`, `- Balance: S/${prev.net_balance}`);
    if (cur && prev.total_expenses > 0) {
      const pct = ((cur.total_expenses - prev.total_expenses) / prev.total_expenses * 100).toFixed(1);
      ctxLines.push(`- Cambio en gastos vs anterior: ${Number(pct) > 0 ? "+" : ""}${pct}%`);
    }
  }
  if (curCats.length > 0) {
    ctxLines.push("\nGASTOS POR CATEGORÍA (mes actual):");
    for (const c of curCats.slice(0, 10)) {
      const p = prevCats.find((x) => x.category_name === c.category_name);
      const comp = p && p.total_amount > 0
        ? ` (${((c.total_amount - p.total_amount) / p.total_amount * 100) > 0 ? "+" : ""}${((c.total_amount - p.total_amount) / p.total_amount * 100).toFixed(0)}% vs ${MESES[prevMonth]})`
        : "";
      ctxLines.push(`- ${c.category_name}: S/${c.total_amount} (${c.percentage}%)${comp}`);
    }
  }
  // Siempre, aunque sea cero: sin estas líneas MiMo no sabía qué decir a «¿cuánto gasté esta semana?» y
  // devolvía la respuesta vacía (4 de 4 veces, 5-oct). Con un error de lectura se omite: cero sería falso.
  if (!weekRes.error && !last7Res.error) {
    type Gasto = { category_name: string; total_amount: number };
    const sumar = (filas: Gasto[]) => filas.reduce((s, c) => s + Number(c.total_amount), 0);
    const week = (weekRes.data ?? []) as Gasto[];
    const last7 = (last7Res.data ?? []) as Gasto[];
    ctxLines.push(`\nESTA SEMANA (lunes ${semana.lunes} a hoy ${semana.hoy}): gastos S/${sumar(week).toFixed(2)}`);
    for (const c of week.slice(0, 6)) ctxLines.push(`- ${c.category_name}: S/${c.total_amount}`);
    ctxLines.push(`ÚLTIMOS 7 DÍAS (${semana.hace7} a ${semana.hoy}): gastos S/${sumar(last7).toFixed(2)}`);
  }
  if (budgets.length > 0) {
    ctxLines.push("\nPRESUPUESTOS:");
    for (const b of budgets) {
      const estado = b.percentage_used >= 100 ? "EXCEDIDO" : b.percentage_used >= 80 ? "CASI AL LÍMITE" : "OK";
      ctxLines.push(`- ${b.category_name}: S/${b.amount_spent}/S/${b.amount_limit} (${b.percentage_used}%) ${estado}`);
    }
  }
  ctxLines.push(`\nCUENTAS: ${accounts.map((a) => `${a.account_name}: S/${a.current_balance}`).join(", ") || "ninguna"}`);
  if (goals.length > 0) {
    ctxLines.push("\nMETAS DE AHORRO:");
    for (const g of goals) {
      ctxLines.push(`- ${g.goal_name}: S/${g.current_amount}/S/${g.target_amount} (${((g.current_amount / g.target_amount) * 100).toFixed(0)}%)${g.target_date ? ` fecha: ${g.target_date}` : ""}`);
    }
  }
  if (recurring.length > 0) {
    const total = recurring.reduce((s, r) => s + Number(r.amount), 0);
    const pagados = recurring.filter((r) => paidIds.has(r.recurring_id)).length;
    ctxLines.push("\nRECURRENTES (suscripciones y pagos fijos):", `Total fijo mensual: S/${total.toFixed(2)}. Pagados este mes: ${pagados}/${recurring.length}`);
    for (const r of recurring) {
      ctxLines.push(`- ${r.description}: S/${r.amount} (${r.frequency}) ${paidIds.has(r.recurring_id) ? "✓ PAGADO" : "PENDIENTE"} próximo: ${r.next_due_date}`);
    }
  }
  if (recent.length > 0) {
    ctxLines.push("\nÚLTIMAS TRANSACCIONES:");
    for (const t of recent) {
      const sign = t.transaction_type === "income" ? "+" : "-";
      const cat = (t.category as { category_name?: string } | null)?.category_name ?? "";
      ctxLines.push(`- ${new Date(t.transaction_date).toLocaleDateString("es-PE", { timeZone: "America/Lima" })}: ${sign}S/${t.amount} ${t.description ?? cat}`);
    }
  }

  return { prompt: ctxLines.join("\n"), data: { accounts, categories, goals, recurring, paidIds, recurrentesOk } };
}

const nextDueDate = (current: string, frequency: string): string => {
  const d = new Date(current); // fecha AAAA-MM-DD en UTC; el runtime también es UTC
  switch (frequency) {
    case "daily": d.setDate(d.getDate() + 1); break;
    case "weekly": d.setDate(d.getDate() + 7); break;
    case "biweekly": d.setDate(d.getDate() + 14); break;
    case "monthly": d.setMonth(d.getMonth() + 1); break;
    case "quarterly": d.setMonth(d.getMonth() + 3); break;
    case "semiannual": d.setMonth(d.getMonth() + 6); break;
    case "annual": d.setFullYear(d.getFullYear() + 1); break;
  }
  return d.toISOString().slice(0, 10);
};

const err = (message: string) => ({ action: "error", message });
const str = (v: unknown) => (typeof v === "string" ? v : "");

export const finanzas: AgentModule<Data> = {
  id: "finanzas",
  rules,
  loadContext,
  definitions: [
    tool("create_transaction", "Registra un gasto o ingreso.", {
      amount: { type: "number", description: "Monto" },
      transaction_type: { type: "string", enum: ["income", "expense"] },
      description: { type: "string", description: "Descripción corta" },
      category_name: { type: "string", description: "Categoría: Alimentación, Transporte, Entretenimiento, Compras, Salud, Educación, Servicios, Vivienda, Ropa, Tecnología, Suscripciones, Mascotas, Regalos, Otros gastos, Sueldo, Freelance, Negocio, Inversiones, Trading, Otros ingresos" },
      currency_code: { type: "string", enum: ["PEN", "USD"], description: "PEN por defecto, USD si dice dólares" },
      notes: { type: "string", description: "Detalle adicional si el usuario da información extra (lugar, con quién, etc.)" },
      comentario,
    }, ["amount", "transaction_type", "description"]),
    tool("create_budget", "Crea un presupuesto mensual para una categoría.", {
      category_name: { type: "string" }, amount_limit: { type: "number" },
    }, ["category_name", "amount_limit"]),
    tool("create_goal", "Crea una meta de ahorro.", {
      goal_name: { type: "string" }, target_amount: { type: "number" }, target_date: { type: "string", description: "YYYY-MM-DD opcional" },
    }, ["goal_name", "target_amount"]),
    tool("contribute_to_goal", "Aporta a una meta de ahorro existente.", {
      goal_name: { type: "string" }, amount: { type: "number" },
    }, ["goal_name", "amount"]),
    tool("create_recurring", "Crea un pago recurrente o suscripción.", {
      description: { type: "string" }, amount: { type: "number" },
      frequency: { type: "string", enum: ["daily", "weekly", "biweekly", "monthly", "quarterly", "annual"] },
      category_name: { type: "string" },
    }, ["description", "amount", "frequency"]),
    tool("edit_transaction", "Edita una transacción existente.", {
      search_description: { type: "string" }, new_amount: { type: "number" }, new_description: { type: "string" },
    }, ["search_description"]),
    tool("delete_transaction", "Elimina una transacción.", { search_description: { type: "string" } }, ["search_description"]),
    tool("transfer", "Transfiere entre cuentas.", {
      amount: { type: "number" }, from_account: { type: "string" }, to_account: { type: "string" },
    }, ["amount", "from_account", "to_account"]),
    tool("pay_recurring", "Marca un pago recurrente como pagado: crea la transacción y avanza la próxima fecha. Usa cuando dice 'ya pagué Netflix', 'pagué el alquiler'.", {
      search_description: { type: "string", description: "Nombre del recurrente a marcar como pagado" },
    }, ["search_description"]),
    tool("list_recurring", "Lista suscripciones y pagos recurrentes: mis suscripciones, qué pagos tengo, cuáles ya pagué, qué falta pagar. El sistema arma la respuesta con los datos.", {
      filter: { type: "string", enum: ["all", "pending", "paid"], description: "all=todos, pending=lo que falta pagar este mes, paid=ya pagados este mes" },
    }, ["filter"]),
    tool("analyze_finances", "Analiza patrones financieros, proyecciones y comparaciones: ¿cómo voy?, ¿me alcanza?, ¿en qué gasto más?, ¿dónde puedo ahorrar?", {
      analysis_type: { type: "string", enum: ["projection", "comparison", "recommendations", "overview", "alert_check"] },
      answer: { type: "string", description: "Respuesta FINAL que David escucha, con los números reales del contexto, en frases cortas (sin bullets). Montos en cifras S/ 0.00. Nunca un marcador ni 'déjame revisar': si no hay datos, dilo." },
    }, ["analysis_type", "answer"]),
  ],
  handlers: {
    async create_transaction(args, { supabase, user, text }, { accounts, categories }) {
      const account = accounts[0];
      if (!account) return err("No tienes cuentas creadas. Crea una en Finanzas → Cuentas.");
      const type = str(args.transaction_type);
      const cat = categories.find((c) => c.category_name.toLowerCase() === str(args.category_name).toLowerCase() && c.category_type === type);
      const currency = str(args.currency_code) || "PEN";
      const { data: tx, error } = await supabase.from("transactions").insert({
        user_id: user.id, transaction_type: type, amount: args.amount, currency_code: currency,
        description: args.description, account_id: account.account_id,
        category_id: cat?.category_id ?? null, transaction_date: new Date().toISOString(),
        input_method: "voice", raw_voice_text: text, is_recurring: false,
        tags: null, notes: args.notes ?? null, transfer_to_account_id: null, recurring_id: null,
      }).select().single();
      if (error) return err(error.message);
      const label = type === "income" ? "ingreso" : "gasto";
      const sym = currency === "USD" ? "US$" : "S/";
      return { action: "create_transaction", message: conComentario(`Listo, ${label} de ${sym} ${Number(args.amount).toFixed(2)} en ${args.description}.`, args), data: tx };
    },
    async create_budget(args, { supabase, user }, { categories }) {
      const cat = categories.find((c) => c.category_name.toLowerCase() === str(args.category_name).toLowerCase() && c.category_type === "expense");
      if (!cat) return err(`No encontré la categoría "${args.category_name}".`);
      const { error } = await supabase.from("budgets").insert({ user_id: user.id, category_id: cat.category_id, amount_limit: args.amount_limit, period_type: "monthly", alert_threshold: 0.8, is_active: true });
      if (error) return err(error.message);
      return { action: "create_budget", message: `Presupuesto de S/ ${Number(args.amount_limit).toFixed(2)} creado para ${cat.category_name}.` };
    },
    async create_goal(args, { supabase, user }) {
      const { error } = await supabase.from("savings_goals").insert({ user_id: user.id, goal_name: args.goal_name, target_amount: args.target_amount, current_amount: 0, currency_code: "PEN", target_date: args.target_date ?? null, is_completed: false });
      if (error) return err(error.message);
      return { action: "create_goal", message: `Meta "${args.goal_name}" creada, objetivo S/ ${Number(args.target_amount).toFixed(2)}.` };
    },
    async contribute_to_goal(args, { supabase }, { goals }) {
      const goal = goals.find((g) => g.goal_name.toLowerCase().includes(str(args.goal_name).toLowerCase()));
      if (!goal) return err(`No encontré la meta "${args.goal_name}".`);
      const nuevo = Number(goal.current_amount) + Number(args.amount);
      const { error } = await supabase.from("savings_goals").update({ current_amount: nuevo }).eq("goal_id", goal.goal_id);
      if (error) return err(error.message);
      return { action: "contribute_to_goal", message: `S/ ${Number(args.amount).toFixed(2)} agregados a "${goal.goal_name}", vas ${((nuevo / goal.target_amount) * 100).toFixed(0)}%.` };
    },
    async create_recurring(args, { supabase, user, limaNow }, { accounts, categories }) {
      const account = accounts[0];
      if (!account) return err("No tienes cuentas creadas. Crea una en Finanzas → Cuentas.");
      const cat = categories.find((c) => c.category_name.toLowerCase() === str(args.category_name).toLowerCase());
      const hoy = limaNow.toISOString().slice(0, 10);
      const { error } = await supabase.from("recurring_transactions").insert({
        user_id: user.id, account_id: account.account_id, category_id: cat?.category_id ?? null,
        transaction_type: "expense", amount: args.amount, description: args.description,
        frequency: args.frequency, start_date: hoy, next_due_date: hoy, is_active: true, auto_register: false,
      });
      if (error) return err(error.message);
      return { action: "create_recurring", message: `Recurrente "${args.description}" de S/ ${Number(args.amount).toFixed(2)} (${FRECUENCIA[str(args.frequency)] ?? args.frequency}) creado.` };
    },
    async edit_transaction(args, { supabase, user }) {
      const { data: txs } = await supabase.from("transactions").select("transaction_id, description, amount")
        .eq("user_id", user.id).ilike("description", `%${str(args.search_description)}%`).order("transaction_date", { ascending: false }).limit(1);
      const tx = txs?.[0];
      if (!tx) return err(`No encontré "${args.search_description}".`);
      const upd: Record<string, unknown> = {};
      if (args.new_amount) upd.amount = args.new_amount;
      if (args.new_description) upd.description = args.new_description;
      const { error } = await supabase.from("transactions").update(upd).eq("transaction_id", tx.transaction_id);
      if (error) return err(error.message);
      return { action: "edit_transaction", message: `"${tx.description}" actualizado${args.new_amount ? `: S/ ${Number(args.new_amount).toFixed(2)}` : ""}${args.new_description ? `, ahora "${args.new_description}"` : ""}.` };
    },
    async delete_transaction(args, { supabase, user }) {
      const { data: txs } = await supabase.from("transactions").select("transaction_id, description, amount")
        .eq("user_id", user.id).ilike("description", `%${str(args.search_description)}%`).order("transaction_date", { ascending: false }).limit(1);
      const tx = txs?.[0];
      if (!tx) return err(`No encontré "${args.search_description}".`);
      const { error } = await supabase.from("transactions").delete().eq("transaction_id", tx.transaction_id);
      if (error) return err(error.message);
      return { action: "delete_transaction", message: `"${tx.description}" de S/ ${Number(tx.amount).toFixed(2)} eliminado.` };
    },
    async transfer(args, { supabase, user, text }, { accounts }) {
      const from = accounts.find((a) => a.account_name.toLowerCase().includes(str(args.from_account).toLowerCase()));
      const to = accounts.find((a) => a.account_name.toLowerCase().includes(str(args.to_account).toLowerCase()));
      if (!from || !to) return err("No encontré las cuentas.");
      const { error } = await supabase.from("transactions").insert({
        user_id: user.id, transaction_type: "transfer", amount: args.amount, currency_code: "PEN",
        description: `Transferencia a ${to.account_name}`, account_id: from.account_id,
        transfer_to_account_id: to.account_id, transaction_date: new Date().toISOString(),
        input_method: "voice", raw_voice_text: text, is_recurring: false,
        category_id: null, notes: null, tags: null, recurring_id: null,
      });
      if (error) return err(error.message);
      return { action: "transfer", message: `S/ ${Number(args.amount).toFixed(2)} transferidos de ${from.account_name} a ${to.account_name}.` };
    },
    async pay_recurring(args, { supabase, user, text }) {
      const { data: recs } = await supabase.from("recurring_transactions")
        .select("recurring_id, description, amount, frequency, account_id, category_id, transaction_type, next_due_date")
        .eq("user_id", user.id).eq("is_active", true).ilike("description", `%${str(args.search_description)}%`).limit(1);
      const rec = recs?.[0];
      if (!rec) return err(`No encontré el recurrente "${args.search_description}".`);
      const { error } = await supabase.from("transactions").insert({
        user_id: user.id, transaction_type: rec.transaction_type, amount: rec.amount, currency_code: "PEN",
        description: rec.description, account_id: rec.account_id, category_id: rec.category_id,
        transaction_date: new Date().toISOString(), input_method: "recurring",
        raw_voice_text: text, is_recurring: true, recurring_id: rec.recurring_id,
        transfer_to_account_id: null, notes: null, tags: null,
      });
      if (error) return err(error.message);
      const proximo = nextDueDate(rec.next_due_date, rec.frequency);
      await supabase.from("recurring_transactions").update({ next_due_date: proximo }).eq("recurring_id", rec.recurring_id);
      return { action: "pay_recurring", message: `${rec.description} de S/ ${Number(rec.amount).toFixed(2)} marcado como pagado. Próximo pago: ${proximo}.` };
    },
    list_recurring: async (args, { limaNow }, { recurring, paidIds, recurrentesOk }) => {
      if (!recurrentesOk) return err("No pude leer tus pagos fijos. Intenta de nuevo en un momento.");
      const filtro = (["all", "pending", "paid"].includes(str(args.filter)) ? str(args.filter) : "pending") as FiltroRecurrentes;
      return { action: "list_recurring", message: resumenRecurrentes(recurring, paidIds, limaNow.toISOString().slice(0, 10), filtro) };
    },
    analyze_finances: async (args) => ({ action: "analyze_finances", message: str(args.answer) }),
  },
};
