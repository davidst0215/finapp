// Módulo "memoria" del agente: responde preguntas sobre los proyectos de David con las fichas y notas de su vault
// como fuente. La IA ve un catálogo compacto de fichas en el contexto y ELIGE cuáles leer (`fichas`, por significado:
// "nova fondos" → novafondos); el handler lee esas fichas completas y hace UNA segunda llamada al modelo para redactar
// una respuesta corta que cita la ficha. Si no eligió ninguna, cae a la búsqueda por palabras (Postgres full-text).
import { type AgentContext, type AgentModule, type ToolResult, tool } from "../types.ts";
import { assertOwner, cargarCatalogo, carpetasDePendientes, ensureIndexed, GitHubError, searchMemory, VaultError, vaultEnv, vaultEnvConConfig } from "../../_shared/vault.ts";
import { type FichaCat, resolverFichas } from "../../_shared/vault/catalogo.ts";
import { fuenteHablada } from "../../_shared/vault/search.ts";
import { relojLima } from "../../_shared/vault/fechas.ts";

const rules = `MEMORIA DE PROYECTOS:
- Preguntas sobre lo que David sabe o dejó anotado de sus proyectos y clientes (estado, decisiones, trampas conocidas, repos, personas, cómo se despliega algo, qué es X) → search_memory. No la uses para gastos ni para tareas.
- "Contexto de X", "qué sé de X", "en qué va X", "háblame de X", "trampas de X": mira el CATÁLOGO DE FICHAS del contexto y pasa en fichas el slug (máximo 2) que corresponda por significado, aunque la voz lo escriba distinto ("nova fondos" = novafondos). Con varias fichas del mismo proyecto, elige la que trata el tema preguntado (el hub si preguntan en general).
- query = solo las palabras clave de la pregunta (2 a 5 palabras), sin relleno ni la pregunta entera. Si nada del catálogo corresponde, deja fichas vacío.
- El sistema suma solo los pendientes reales del proyecto (tareas abiertas y hechas) al leer la ficha. "Qué pendientes tengo en X" es list_tasks, no esto.
- Voz: 2 o 3 frases cortas; la fuente y el detalle van a la pantalla.`;

const str = (v: unknown) => (typeof v === "string" ? v : "");

// El catálogo se arma en loadContext y llega al handler sin volver a consultar la base.
type DataMemoria = { fichas: FichaCat[] } | undefined;

async function loadContext(ctx: AgentContext) {
  const cat = await cargarCatalogo(ctx.supabase, ctx.user.id);
  return { prompt: cat.prompt, data: { fichas: cat.fichas }, estable: true };
}

async function searchMemoryTool(args: Record<string, unknown>, ctx: AgentContext, data: DataMemoria): Promise<ToolResult> {
  try {
    assertOwner(ctx.user.id, vaultEnv());
    const env = await vaultEnvConConfig(ctx.supabase, ctx.user.id); // la config de proyectos viene del vault
    await ensureIndexed(ctx.supabase, ctx.user.id, env); // primera vez: trae el vault antes de buscar
    // Palabras clave, no un párrafo: un `query` desbocado no debe llegar a la búsqueda ni al modelo que redacta.
    const delModelo = str(args.query).replace(/\s+/g, " ").trim().slice(0, 160);
    const q = delModelo || ctx.text.slice(0, 160); // sin palabras clave del modelo se busca con lo que dijo David… pero eso no se registra
    // Solo cuentan los slugs que existen en el catálogo; lo demás se descarta y, sin fichas válidas, se busca por palabras.
    const { validas, descartadas } = resolverFichas(args.fichas, data?.fichas ?? []);
    if (descartadas.length) console.log(JSON.stringify({ evt: "memoria_fichas_descartadas", n: descartadas.length }));
    // Las tareas reales de los proyectos de la pregunta y de las fichas elegidas son el estado más reciente; el modelo que
    // redacta responde a lo que David dijo (no solo a las palabras clave).
    const res = await searchMemory(ctx.supabase, ctx.user.id, {
      q, pregunta: ctx.text, cliente: str(args.cliente).trim() || undefined, answer: true, fichaPaths: validas.map((f) => f.path),
      pendientes: await carpetasDePendientes(ctx.supabase, ctx.user.id, env.config, validas.map((f) => f.slug), q), hoy: relojLima(ctx.limaNow).hoy, incluirPendientes: true,
    });
    // Una línea por búsqueda, sin el texto de David: `query` son las palabras clave que eligió el modelo (acotadas a 60); si el modelo
    // no las dio y se buscó con el dictado crudo, va vacía.
    console.log(JSON.stringify({
      evt: "memoria", fichas: res.meta.fichas, hits: res.meta.hits, encontrado: res.meta.encontrado, redactada: res.meta.redactada, query: delModelo.slice(0, 60),
      pendientes: res.meta.pendientes, recortada: res.meta.recortada, segunda: res.meta.segunda, ampliada: res.meta.ampliada, llm: res.meta.llm, tok_in: res.meta.tok_in, tok_out: res.meta.tok_out,
    }));

    if (!res.sources.length) {
      return { action: "search_memory", message: res.indexed === 0 ? "Todavía no tengo fichas indexadas. Abre Tareas para sincronizar el vault." : "No encontré nada sobre eso en tus fichas." };
    }
    const fuentes = res.sources.map((s) => ({ title: s.title, slug: s.slug, path: s.path }));
    // Pantalla: la respuesta con su fuente. Voz: solo la respuesta, sin «Fuente: …».
    if (res.spoken) return { action: "search_memory", message: res.spoken, voz: res.voz ?? undefined, data: { sources: fuentes } };

    // Sin respuesta redactada (modelo caído): se dicen las fichas encontradas.
    const titulos = res.sources.slice(0, 3).map((s) => fuenteHablada(s.title)).join("; ");
    const n = res.sources.length;
    return {
      action: "search_memory",
      message: `Encontré ${n} ${n === 1 ? "ficha" : "fichas"} sobre eso: ${titulos}. No pude redactar la respuesta ahora.`,
      voz: `Encontré ${n} ${n === 1 ? "ficha" : "fichas"}, pero no pude redactar la respuesta.`,
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
