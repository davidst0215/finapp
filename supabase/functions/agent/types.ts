import type { SupabaseClient, User } from "jsr:@supabase/supabase-js@2";

export type ToolDefinition = {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

export type ToolResult = { action: string; message: string; data?: unknown };

export type AgentContext = {
  supabase: SupabaseClient; // cliente con el JWT del usuario: aplica RLS
  user: User;
  text: string; // lo que dijo o escribió David
  limaNow: Date; // getters locales = hora de Lima (el runtime corre en UTC)
};

// Cada módulo de Wabid aporta su contexto, sus reglas y sus tools.
// `loadContext` corre en paralelo con los demás módulos; lo que devuelve en `data`
// llega a sus handlers sin volver a consultar la base.
// `estable: true` marca un contexto que cambia rara vez (p. ej. el catálogo de fichas): va en su propio mensaje de sistema,
// antes del volátil, para no romper el prefijo que el proveedor tiene cacheado.
// `loadContext` es SOLO LECTURA con `ctx.supabase` (RLS): corre mientras se valida la sesión y
// en ese momento `ctx.user` solo trae `id`. Nada de escribir, avisar ni llamar APIs pagadas ahí:
// eso va en los handlers, que corren con la sesión ya confirmada.
export type AgentModule<D = unknown> = {
  id: string;
  rules?: string;
  definitions: ToolDefinition[];
  loadContext?: (ctx: AgentContext) => Promise<{ prompt: string; data: D; estable?: boolean }>;
  handlers: Record<string, (args: Record<string, unknown>, ctx: AgentContext, data: D) => Promise<ToolResult>>;
};

export const tool = (
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[] = [],
): ToolDefinition => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties, required } },
});
