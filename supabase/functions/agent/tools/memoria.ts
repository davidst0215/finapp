// Módulo "memoria" del agente: responde preguntas sobre los proyectos de David con las fichas y notas de su vault
// como fuente. La IA ve un catálogo compacto de fichas en el contexto y ELIGE cuáles leer (`fichas`, por significado:
// "nova fondos" → novafondos); el handler lee esas fichas completas y hace UNA segunda llamada al modelo para redactar
// una respuesta corta que cita la ficha. Si no eligió ninguna, cae a la búsqueda por palabras (Postgres full-text).
import { type AgentContext, type AgentModule, type ToolResult, tool } from "../types.ts";
import { assertOwner, cargarCatalogo, ensureIndexed, GitHubError, searchMemory, VaultError, vaultEnv } from "../../_shared/vault.ts";
import { type FichaCat, resolverFichas } from "../../_shared/vault/catalogo.ts";
import { fuenteHablada } from "../../_shared/vault/search.ts";

const rules = `MEMORIA DE PROYECTOS:
- Preguntas sobre lo que David sabe o dejó anotado de sus proyectos y clientes (estado, decisiones, trampas conocidas, repos, personas, cómo se despliega algo, qué es X) → search_memory. No la uses para gastos ni para tareas.
- "Contexto de X", "qué sé de X", "en qué va X", "háblame de X", "trampas de X": mira el CATÁLOGO DE FICHAS del contexto y pasa en fichas el slug (máximo 2) que corresponda por significado, aunque la voz lo escriba distinto ("nova fondos" = novafondos). Con varias fichas del mismo proyecto, elige la que trata el tema preguntado (el hub si preguntan en general).
- query = solo las palabras clave de la pregunta, sin relleno. Si nada del catálogo corresponde, deja fichas vacío.`;

const str = (v: unknown) => (typeof v === "string" ? v : "");

// El catálogo se arma en loadContext y llega al handler sin volver a consultar la base.
type DataMemoria = { fichas: FichaCat[] } | undefined;

async function loadContext(ctx: AgentContext) {
  const cat = await cargarCatalogo(ctx.supabase, ctx.user.id);
  return { prompt: cat.prompt, data: { fichas: cat.fichas }, estable: true };
}

async function searchMemoryTool(args: Record<string, unknown>, ctx: AgentContext, data: DataMemoria): Promise<ToolResult> {
  try {
    const env = vaultEnv();
    assertOwner(ctx.user.id, env);
    await ensureIndexed(ctx.supabase, ctx.user.id, env); // primera vez: trae el vault antes de buscar
    const q = str(args.query).trim() || ctx.text;
    // Solo cuentan los slugs que existen en el catálogo; lo demás se descarta y, sin fichas válidas, se busca por palabras.
    const { validas, descartadas } = resolverFichas(args.fichas, data?.fichas ?? []);
    if (descartadas.length) console.log(JSON.stringify({ evt: "memoria_fichas_descartadas", n: descartadas.length }));
    const res = await searchMemory(ctx.supabase, ctx.user.id, {
      q, cliente: str(args.cliente).trim() || undefined, answer: true, fichaPaths: validas.map((f) => f.path),
    });

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

export const memoria: AgentModule<DataMemoria> = {
  id: "memoria",
  rules,
  loadContext,
  definitions: [
    tool("search_memory", "Busca en las fichas y notas de proyectos de David y responde citando la ficha. Para 'qué sé / qué decidimos / cómo está / qué trampas tiene / qué es / contexto de' sobre un proyecto, cliente o tema suyo.", {
      fichas: {
        type: "array", items: { type: "string" }, maxItems: 2,
        description: "Slugs del CATÁLOGO DE FICHAS (máx. 2) que responden la pregunta, elegidos por significado (ej. ['novafondos']). Vacío si ninguna corresponde.",
      },
      query: { type: "string", description: "Palabras clave de la pregunta (ej. 'bolsa de costos despliegue')" },
      cliente: { type: "string", description: "Cliente para acotar, solo si lo nombró (ej. 'Acme')" },
    }, ["query"]),
  ],
  handlers: { search_memory: searchMemoryTool },
};
