import type { SupabaseClient, User } from "jsr:@supabase/supabase-js@2";

export type ToolDefinition = {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

// `message` es lo que se ve (el detalle completo). `voz`, si viene, es lo que se dice en voz alta: una frase corta con el dato
// principal, porque ElevenLabs cobra por carácter. Sin `voz` se dice `message`. Siempre pasa por el tope VOZ_MAX.
// Opcional a propósito: un cliente viejo ignora `voz` y sigue funcionando con `message`.
export type ToolResult = { action: string; message: string; voz?: string; data?: unknown; accion?: AccionCliente };

// Lo que la app ofrece como botón grande tras la respuesta ("Abrir WhatsApp", "Llamar"): el navegador exige un toque de David
// para abrir otra app, así que Wabid no abre nada sola. Lleva el teléfono, por eso viaja SOLO aquí y nunca en `message` ni en
// `voz`: la app devuelve `message` al modelo como historial en el turno siguiente.
// `url` es https://api.whatsapp.com/send?… (whatsapp) o tel:+… (llamar, numero). En "numero", `urlWhatsapp` es el segundo botón.
export type AccionCliente = {
  tipo: "whatsapp" | "llamar" | "numero";
  contacto: string;
  relacion?: string;
  numero: string; // para leerlo en la tarjeta: "+51 999 888 777"
  url: string;
  urlWhatsapp?: string;
  texto?: string; // el mensaje redactado (whatsapp)
};

export type AgentContext = {
  supabase: SupabaseClient; // cliente con el JWT del usuario: aplica RLS
  user: User;
  text: string; // lo que dijo o escribió David
  limaNow: Date; // getters locales = hora de Lima (el runtime corre en UTC)
  // Lo que David dijo en los turnos anteriores (solo sus mensajes, hasta 8): para contrastar un dato que el modelo repite, como un teléfono.
  anteriores?: string[];
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
