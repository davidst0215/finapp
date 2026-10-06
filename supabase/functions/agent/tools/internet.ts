// Módulo "internet" del agente: datos actuales que no están en el contexto (noticias, clima, tipo de cambio, resultados,
// horarios). El modelo elige la tool solo cuando hace falta; ahí sale UNA llamada extra con el plugin web de OpenRouter,
// que busca (Exa: ~US$ 0.007 por búsqueda, tarifa del 5-oct) y redacta la respuesta corta para voz.
// A la búsqueda va SOLO la consulta: nada del contexto de David (gastos, tareas, agenda, correo).
import { type AgentContext, type AgentModule, type ToolResult, tool } from "../types.ts";
import { LLM_BODY, LLM_URL, llmAuth } from "../../_shared/llm.ts";
import { paraDecir } from "./internetTexto.ts";

const TIEMPO_MAX_MS = 9000; // el celular corta a los 15 s y antes ya corrió la primera llamada al modelo

const rules = `INTERNET:
- Datos actuales o de afuera que no están en el contexto: noticias, clima, tipo de cambio, precios, resultados deportivos, horarios, qué pasó con algo o alguien → search_web.
- consulta = qué buscar, en pocas palabras, con lugar o fecha si importa (por ejemplo "tipo de cambio dólar sol hoy Perú").
- Lo personal de David (gastos, tareas, agenda, correo, reuniones, sus proyectos) NUNCA va a internet: usa sus módulos. No pongas datos de David en la consulta.`;

const str = (v: unknown) => (typeof v === "string" ? v : "");

type Cita = { type?: string; url_citation?: { url?: string; title?: string } };

async function searchWeb(args: Record<string, unknown>, ctx: AgentContext): Promise<ToolResult> {
  const consulta = str(args.consulta).trim() || ctx.text;
  const hoy = ctx.limaNow.toISOString().slice(0, 10);
  const t0 = performance.now();
  try {
    const r = await fetch(LLM_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: llmAuth(), "X-Title": "Wabid" },
      signal: AbortSignal.timeout(TIEMPO_MAX_MS),
      body: JSON.stringify({
        ...LLM_BODY,
        // Exa explícito: con el modelo de respaldo (Claude) OpenRouter usaría la búsqueda nativa, con otra tarifa.
        plugins: [{ id: "web", engine: "exa", max_results: 3 }],
        temperature: 0.2,
        max_tokens: 300,
        messages: [
          {
            role: "system",
            // Probado el 5-oct: sin estos límites salían 3 oraciones con fechas entre paréntesis y montos de 4 decimales
            // ("S/ 3.4357", que la voz no sabe leer), y en deportes mezclaba un partido viejo con uno reciente.
            content: `Respondes por voz a David, en Lima, Perú. Hoy es ${hoy}. Con lo que dicen los resultados de la búsqueda, responde en 1 o 2 oraciones, máximo 40 palabras, con el dato principal primero. Si hay varios resultados en el tiempo, usa el más reciente; si los resultados no responden la pregunta o son viejos, dilo. Si el dato cambia durante el día, di de cuándo es con palabras ("hoy a las seis de la tarde"). Montos con 2 decimales (S/ 3.44, US$ 20.00). Sin listas, enlaces, paréntesis ni markdown.`,
          },
          { role: "user", content: consulta },
        ],
      }),
    });
    const j = await r.json().catch(() => ({}));
    const msg = j.choices?.[0]?.message;
    const texto = paraDecir(str(msg?.content));
    const fuentes = ((msg?.annotations ?? []) as Cita[])
      .filter((a) => a.type === "url_citation" && a.url_citation?.url)
      .map((a) => ({ title: a.url_citation?.title ?? "", url: a.url_citation?.url ?? "" }));
    // Una línea por búsqueda, sin la consulta (es contenido de David): para seguir costo y latencia en los logs.
    console.log(JSON.stringify({ evt: "internet", ok: r.ok, ms: Math.round(performance.now() - t0), fuentes: fuentes.length, prov: j.provider ?? "" }));
    if (!r.ok || !texto) {
      if (!r.ok) console.error("internet:", r.status, JSON.stringify(j).slice(0, 200));
      return { action: "error", message: "No pude buscar en internet ahora. Inténtalo en un momento." };
    }
    return { action: "search_web", message: texto, data: { fuentes } };
  } catch (e) {
    const tiempo = e instanceof DOMException && e.name === "TimeoutError";
    console.error("internet:", tiempo ? "tiempo agotado" : e instanceof Error ? e.message : String(e));
    return { action: "error", message: tiempo ? "La búsqueda tardó demasiado. Pregúntame de nuevo." : "No pude buscar en internet ahora." };
  }
}

export const internet: AgentModule = {
  id: "internet",
  rules,
  definitions: [
    tool("search_web", "Busca en internet datos actuales que no están en el contexto: noticias, clima, tipo de cambio, precios, resultados, horarios.", {
      consulta: { type: "string", description: "Qué buscar, en pocas palabras, con lugar o fecha si importa. Sin datos personales de David." },
    }, ["consulta"]),
  ],
  handlers: { search_web: searchWeb },
};
