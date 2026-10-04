import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type User } from "jsr:@supabase/supabase-js@2";
import { llmConfigured, llmFetch } from "../_shared/llm.ts";
import { PERSONA } from "./prompt.ts";
import { MODULES } from "./registry.ts";
import { bearer, jwtSub } from "../_shared/jwt.ts";
import { Tiempos } from "./tiempos.ts";
import type { AgentContext } from "./types.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Expose-Headers": "server-timing",
};

const DEFINITIONS = MODULES.flatMap((m) => m.definitions);
const OWNER = new Map(MODULES.flatMap((m) => m.definitions.map((d) => [d.function.name, m] as const)));
if (OWNER.size !== DEFINITIONS.length) throw new Error("Dos módulos declaran una tool con el mismo nombre");
const RULES = MODULES.map((m) => m.rules).filter(Boolean).join("\n\n");
// Prefijo idéntico en cada pedido: el proveedor lo reutiliza de su caché y el modelo arranca antes.
const SISTEMA = `${PERSONA}\n\n${RULES}`;
const MAX_TEXTO = 2000; // un dictado largo cabe de sobra; más es abuso o error

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const t = new Tiempos();
  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json", "Server-Timing": t.header(), ...corsHeaders },
    });

  try {
    // Primero el token: la anon key (pública, va en el bundle) no trae `sub` y se corta antes de
    // leer el cuerpo o revelar configuración. Ese `sub` sin verificar solo arranca las lecturas
    // mientras getUser valida la sesión: PostgREST verifica la firma en cada consulta y RLS filtra.
    const token = bearer(req);
    const sub = jwtSub(token);
    if (!sub) return json({ error: "No autorizado" }, 401);
    if (!llmConfigured()) return json({ error: "Modelo no configurado" }, 500);

    const { text, history } = await req.json();
    if (!text || typeof text !== "string") return json({ error: "Se requiere 'text'" }, 400);
    if (text.length > MAX_TEXTO) return json({ error: "Mensaje demasiado largo" }, 413);

    const supabase = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    // Lima es UTC-5 todo el año; el runtime corre en UTC, así que los getters locales quedan en hora de Lima.
    const ctx: AgentContext = { supabase, user: { id: sub } as User, text, limaNow: new Date(Date.now() - 5 * 60 * 60 * 1000) };

    const [user, contexts] = await Promise.all([
      t.medir("auth", supabase.auth.getUser(token).then((r) => r.data.user)),
      t.medir("ctx", Promise.all(MODULES.map(async (m) => {
        if (!m.loadContext) return { id: m.id, prompt: "", data: undefined };
        try {
          return { id: m.id, ...(await m.loadContext(ctx)) };
        } catch (e) {
          // Un módulo caído no debe tumbar a los demás.
          console.error(`contexto ${m.id}:`, e instanceof Error ? e.message : e);
          return { id: m.id, prompt: `(${m.id}: sin datos por un error temporal)`, data: undefined };
        }
      }))),
    ]);
    // El modelo (que cuesta) solo corre con una sesión real y vigente del mismo usuario.
    if (!user || user.id !== sub) return json({ error: "No autorizado" }, 401);
    ctx.user = user;
    const dataByModule = new Map(contexts.map((c) => [c.id, c.data]));

    const hoy = new Date().toLocaleString("es-PE", {
      timeZone: "America/Lima", weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit",
    });
    // La hora va al final: lo que cambia cada minuto no debe romper el prefijo cacheado.
    const contextMsg = [...contexts.map((c) => c.prompt).filter(Boolean), `HOY: ${hoy} (hora de Lima)`].join("\n\n");

    // OpenRouter manda los headers de inmediato y el cuerpo cuando el modelo termina:
    // la fase incluye leer el cuerpo.
    const llm = await t.medir("llm", llmFetch({
      messages: [
        { role: "system", content: SISTEMA },
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
    }).then(async (r) => ({ ok: r.ok, status: r.status, cuerpo: await r.text() })));

    if (!llm.ok) {
      console.error("agent modelo:", llm.status, llm.cuerpo.slice(0, 300));
      return json({ error: "El modelo no respondió. Intenta de nuevo." }, 502);
    }

    const data = JSON.parse(llm.cuerpo);
    t.tokens(data.usage);
    const call = data.choices?.[0]?.message?.tool_calls?.[0];
    if (!call) return json({ error: "No se pudo interpretar" }, 500);

    const owner = OWNER.get(call.function.name);
    if (!owner) return json({ action: "unknown", message: "No entendí. Intenta de nuevo." });
    const args = JSON.parse(call.function.arguments || "{}");
    const result = await t.medir("tool", owner.handlers[call.function.name](args, ctx, dataByModule.get(owner.id)));
    // Una línea por pedido, sin contenido de David: sirve para seguir el p50 en los logs.
    console.log(JSON.stringify({ evt: "agent", tool: call.function.name, ...t.resumen() }));
    return json(result);
  } catch (error) {
    console.error("agent error:", error instanceof Error ? error.message : String(error));
    return json({ error: "Algo falló de mi lado. Intenta de nuevo." }, 500);
  }
});
