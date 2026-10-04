import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { llmConfigured, llmFetch } from "../_shared/llm.ts";
import { PERSONA } from "./prompt.ts";
import { MODULES } from "./registry.ts";
import type { AgentContext } from "./types.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...corsHeaders } });

const DEFINITIONS = MODULES.flatMap((m) => m.definitions);
const OWNER = new Map(MODULES.flatMap((m) => m.definitions.map((d) => [d.function.name, m] as const)));
if (OWNER.size !== DEFINITIONS.length) throw new Error("Dos módulos declaran una tool con el mismo nombre");
const RULES = MODULES.map((m) => m.rules).filter(Boolean).join("\n\n");

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    if (!llmConfigured()) return json({ error: "Modelo no configurado" }, 500);

    const { text, history } = await req.json();
    if (!text || typeof text !== "string") return json({ error: "Se requiere 'text'" }, 400);

    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) return json({ error: "No autorizado" }, 401);

    // Cliente con el JWT del usuario: las consultas pasan por RLS.
    const supabase = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user } } = await supabase.auth.getUser(authHeader.replace("Bearer ", ""));
    if (!user) return json({ error: "No autorizado" }, 401);

    // Lima es UTC-5 todo el año; el runtime corre en UTC, así que los getters locales quedan en hora de Lima.
    const ctx: AgentContext = { supabase, user, text, limaNow: new Date(Date.now() - 5 * 60 * 60 * 1000) };

    const contexts = await Promise.all(MODULES.map(async (m) => {
      if (!m.loadContext) return { id: m.id, prompt: "", data: undefined };
      try {
        return { id: m.id, ...(await m.loadContext(ctx)) };
      } catch (e) {
        // Un módulo caído no debe tumbar a los demás.
        console.error(`contexto ${m.id}:`, e instanceof Error ? e.message : e);
        return { id: m.id, prompt: `(${m.id}: sin datos por un error temporal)`, data: undefined };
      }
    }));
    const dataByModule = new Map(contexts.map((c) => [c.id, c.data]));

    const hoy = new Date().toLocaleString("es-PE", {
      timeZone: "America/Lima", weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit",
    });
    const contextMsg = [`HOY: ${hoy} (hora de Lima)`, ...contexts.map((c) => c.prompt).filter(Boolean)].join("\n\n");

    const res = await llmFetch({
      messages: [
        { role: "system", content: `${PERSONA}\n\n${RULES}` },
        { role: "system", content: contextMsg },
        ...(Array.isArray(history)
          ? history.slice(-8).map((h: { role: string; content: string }) => ({
              role: h.role === "assistant" ? "assistant" : "user",
              content: String(h.content ?? "").slice(0, 500),
            }))
          : []),
        { role: "user", content: text },
      ],
      tools: DEFINITIONS,
      tool_choice: "required",
      temperature: 0.15,
      max_tokens: 500,
    });

    if (!res.ok) return json({ error: "Error del modelo", details: await res.text() }, 502);

    const data = await res.json();
    const call = data.choices?.[0]?.message?.tool_calls?.[0];
    if (!call) return json({ error: "No se pudo interpretar" }, 500);

    const owner = OWNER.get(call.function.name);
    if (!owner) return json({ action: "unknown", message: "No entendí. Intenta de nuevo." });
    const args = JSON.parse(call.function.arguments || "{}");
    const result = await owner.handlers[call.function.name](args, ctx, dataByModule.get(owner.id));
    return json(result);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("agent error:", msg);
    return json({ error: `Error: ${msg}` }, 500);
  }
});
