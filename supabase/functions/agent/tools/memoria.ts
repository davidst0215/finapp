// Módulo "memoria" del agente: responde preguntas sobre los proyectos de David con las fichas y notas de su vault
// como fuente. Busca con Postgres full-text (español, sin acentos) y hace UNA segunda llamada al modelo, solo
// con los fragmentos encontrados, para redactar una respuesta corta que cita la ficha.
import { type AgentContext, type AgentModule, type ToolResult, tool } from "../types.ts";
import { assertOwner, ensureIndexed, GitHubError, searchMemory, VaultError, vaultEnv } from "../../_shared/vault.ts";
import { fuenteHablada } from "../../_shared/vault/search.ts";

const rules = `MEMORIA DE PROYECTOS:
- Preguntas sobre lo que David sabe o dejó anotado de sus proyectos y clientes (estado, decisiones, trampas conocidas, repos, personas, cómo se despliega algo, qué es X) → search_memory. No la uses para gastos ni para tareas.
- query = solo las palabras clave de la pregunta, sin relleno.`;

const str = (v: unknown) => (typeof v === "string" ? v : "");

async function searchMemoryTool(args: Record<string, unknown>, ctx: AgentContext): Promise<ToolResult> {
  try {
    const env = vaultEnv();
    assertOwner(ctx.user.id, env);
    await ensureIndexed(ctx.supabase, ctx.user.id, env); // primera vez: trae el vault antes de buscar
    const q = str(args.query).trim() || ctx.text;
    const res = await searchMemory(ctx.supabase, ctx.user.id, { q, cliente: str(args.cliente).trim() || undefined, answer: true });

    if (!res.sources.length) {
      return { action: "search_memory", message: res.indexed === 0 ? "Todavía no tengo fichas indexadas. Abre Tareas para sincronizar el vault." : "No encontré nada sobre eso en tus fichas." };
    }
    const fuentes = res.sources.map((s) => ({ title: s.title, slug: s.slug, path: s.path }));
    if (res.spoken) return { action: "search_memory", message: res.spoken, data: { sources: fuentes } };

    // Sin respuesta redactada (modelo caído): se dicen las fichas encontradas.
    const titulos = res.sources.slice(0, 3).map((s) => fuenteHablada(s.title)).join("; ");
    const n = res.sources.length;
    return {
      action: "search_memory",
      message: `Encontré ${n} ${n === 1 ? "ficha" : "fichas"} sobre eso: ${titulos}. No pude redactar la respuesta ahora.`,
      data: { sources: fuentes },
    };
  } catch (e) {
    if (e instanceof VaultError) return { action: "error", message: e.message };
    if (e instanceof GitHubError) return { action: "error", message: "No pude hablar con GitHub ahora. Inténtalo en un momento." };
    console.error("memoria:", e instanceof Error ? e.message : String(e));
    return { action: "error", message: "Algo falló al buscar en tus fichas. Inténtalo de nuevo." };
  }
}

export const memoria: AgentModule = {
  id: "memoria",
  rules,
  definitions: [
    tool("search_memory", "Busca en las fichas y notas de proyectos de David y responde citando la ficha. Para 'qué sé / qué decidimos / cómo está / qué trampas tiene / qué es' sobre un proyecto, cliente o tema suyo.", {
      query: { type: "string", description: "Palabras clave de la pregunta (ej. 'bolsa de costos despliegue')" },
      cliente: { type: "string", description: "Cliente para acotar, solo si lo nombró (ej. 'Acme')" },
    }, ["query"]),
  ],
  handlers: { search_memory: searchMemoryTool },
};
