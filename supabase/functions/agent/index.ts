import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type User } from "jsr:@supabase/supabase-js@2";
import { LLM_FALLBACK, LLM_MODEL, llmConfigured, llmConRespaldo } from "../_shared/llm.ts";
import { pedirVoz, vozConfigurada } from "../_shared/elevenlabs.ts";
import { PERSONA } from "./prompt.ts";
import { MODULES } from "./registry.ts";
import { bearer, jwtSub } from "../_shared/jwt.ts";
import { argumentos, respuestaInservible } from "./respuesta.ts";
import { Tiempos } from "./tiempos.ts";
import type { AgentContext, ToolResult } from "./types.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Max-Age": "7200", // preflight recordado 2 h (ver _shared/http.ts)
  "Access-Control-Expose-Headers": "server-timing",
};

const DEFINITIONS = MODULES.flatMap((m) => m.definitions);
const OWNER = new Map(MODULES.flatMap((m) => m.definitions.map((d) => [d.function.name, m] as const)));
if (OWNER.size !== DEFINITIONS.length) throw new Error("Dos módulos declaran una tool con el mismo nombre");
const RULES = MODULES.map((m) => m.rules).filter(Boolean).join("\n\n");
// Prefijo idéntico en cada pedido: el proveedor lo reutiliza de su caché y el modelo arranca antes.
const SISTEMA = `${PERSONA}\n\n${RULES}`;
const MAX_TEXTO = 2000; // un dictado largo cabe de sobra; más es abuso o error
// Si el modelo no terminó en este plazo sale un segundo pedido a otro proveedor (ver _shared/respaldo.ts).
// Io Net, el primero, respondió siempre en ≤3 s en la medición del 5-oct: el respaldo queda para las colas.
const RESPALDO_MS = 3000;
const VOZ_MAX = 400; // lo que se dice en voz alta; el texto completo igual llega a la pantalla

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const t = new Tiempos();
  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json", "Server-Timing": t.header(), ...corsHeaders },
    });

  // Con `voz`, texto y audio van en una sola respuesta: primera línea el JSON del resultado y después el MP3
  // mientras ElevenLabs lo genera. Ahorra el segundo viaje celular→servidor (y su validación de sesión) que
  // costaba pedir /tts aparte. Si la voz falla, la respuesta termina tras el JSON y la app usa /tts o la del navegador.
  const conVoz = (result: ToolResult): Response => {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    (async () => {
      let escritor: WritableStreamDefaultWriter<Uint8Array> | null = writable.getWriter();
      try {
        await escritor.write(new TextEncoder().encode(JSON.stringify(result) + "\n"));
        const t0 = performance.now();
        const audio = await pedirVoz(result.message.slice(0, VOZ_MAX));
        console.log(JSON.stringify({ evt: "agent_voz", status: audio.status, ttfb: Math.round(performance.now() - t0) }));
        if (!audio.ok || !audio.body) {
          await audio.body?.cancel();
          return;
        }
        escritor.releaseLock();
        escritor = null;
        await audio.body.pipeTo(writable); // si David interrumpe, también se corta la descarga de ElevenLabs
      } catch (e) {
        console.error("agent voz:", e instanceof Error ? e.message : String(e));
      } finally {
        await escritor?.close().catch(() => {});
      }
    })();
    return new Response(readable, {
      headers: { "Content-Type": "application/octet-stream", "Server-Timing": t.header(), ...corsHeaders },
    });
  };

  try {
    // Primero el token: la anon key (pública, va en el bundle) no trae `sub` y se corta antes de
    // leer el cuerpo o revelar configuración. Ese `sub` sin verificar solo arranca las lecturas
    // mientras getUser valida la sesión: PostgREST verifica la firma en cada consulta y RLS filtra.
    const token = bearer(req);
    const sub = jwtSub(token);
    if (!sub) return json({ error: "No autorizado" }, 401);
    if (!llmConfigured()) return json({ error: "Modelo no configurado" }, 500);

    const { text, history, voz } = await req.json();
    if (!text || typeof text !== "string") return json({ error: "Se requiere 'text'" }, 400);
    if (text.length > MAX_TEXTO) return json({ error: "Mensaje demasiado largo" }, 413);
    const quiereVoz = voz === true && vozConfigurada();
    const responder = (result: ToolResult) => (quiereVoz && result.message ? conVoz(result) : json(result));

    const supabase = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    // Lima es UTC-5 todo el año; el runtime corre en UTC, así que los getters locales quedan en hora de Lima.
    const ctx: AgentContext = { supabase, user: { id: sub } as User, text, limaNow: new Date(Date.now() - 5 * 60 * 60 * 1000) };

    const [user, contexts] = await Promise.all([
      t.medir("auth", supabase.auth.getUser(token).then((r) => r.data.user)),
      t.medir("ctx", Promise.all(MODULES.map(async (m) => {
        if (!m.loadContext) return { id: m.id, prompt: "", data: undefined, estable: false };
        try {
          return { id: m.id, ...(await m.loadContext(ctx)) };
        } catch (e) {
          // Un módulo caído no debe tumbar a los demás.
          console.error(`contexto ${m.id}:`, e instanceof Error ? e.message : e);
          return { id: m.id, prompt: `(${m.id}: sin datos por un error temporal)`, data: undefined, estable: false };
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
    // Lo estable (catálogo de fichas) va justo después de SISTEMA y lo volátil al final, con la hora en último lugar:
    // lo que cambia en cada pedido no debe romper el prefijo cacheado.
    const estableMsg = contexts.filter((c) => c.estable).map((c) => c.prompt).filter(Boolean).join("\n\n");
    const contextMsg = [...contexts.filter((c) => !c.estable).map((c) => c.prompt).filter(Boolean), `HOY: ${hoy} (hora de Lima)`].join("\n\n");

    // La fase incluye leer el cuerpo: OpenRouter manda los headers de inmediato y el cuerpo al final.
    // `modelo` fuerza uno solo (sin la lista de respaldo): se usa para el reintento.
    const pedirAlModelo = (modelo?: string) => t.medir("llm", llmConRespaldo({
      ...(modelo ? { model: modelo, models: [modelo] } : {}),
      messages: [
        { role: "system", content: SISTEMA },
        ...(estableMsg ? [{ role: "system", content: estableMsg }] : []),
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
    }, RESPALDO_MS));

    // Una respuesta sin tool o con el texto a decir vacío se pide una vez más antes de ejecutar nada. Si hay modelo de
    // respaldo encendido (LLM_FALLBACK), el reintento va a él; hoy está apagado y se reintenta con MiMo. La causa
    // conocida de respuestas vacías (faltaba el gasto de la semana en el contexto) ya está resuelta.
    let call: { function: { name: string; arguments?: string } } | undefined;
    let prov = ""; // proveedor que respondió (para seguir la latencia por proveedor en los logs)
    let respaldo = false;
    for (let intento = 0; intento < 2; intento++) {
      const llm = await pedirAlModelo(intento > 0 && LLM_FALLBACK ? LLM_FALLBACK : undefined);
      respaldo ||= llm.respaldo;
      if (!llm.ok) {
        console.error("agent modelo:", llm.status, llm.cuerpo.slice(0, 300));
        return json({ error: "El modelo no respondió. Intenta de nuevo." }, 502);
      }
      const data = JSON.parse(llm.cuerpo);
      prov = typeof data.provider === "string" ? data.provider : "";
      if (typeof data.model === "string" && !data.model.startsWith(LLM_MODEL)) prov += ` (${data.model})`; // cayó al modelo de respaldo
      t.tokens(data.usage);
      call = data.choices?.[0]?.message?.tool_calls?.[0];
      if (!respuestaInservible(call)) break;
      console.error(`agent: respuesta inservible del modelo (intento ${intento + 1})`);
    }
    if (respuestaInservible(call) || !call) {
      console.log(JSON.stringify({ evt: "agent", fn: "(inservible)", prov, respaldo, ...t.resumen() }));
      return responder({ action: "query", message: "No me salió la respuesta. ¿Me lo repites?" });
    }

    const owner = OWNER.get(call.function.name);
    if (!owner) return responder({ action: "unknown", message: "No entendí. Intenta de nuevo." });
    const args = argumentos(call) ?? {};
    const result = await t.medir("tool", owner.handlers[call.function.name](args, ctx, dataByModule.get(owner.id)));
    // Una línea por pedido, sin contenido de David: sirve para seguir el p50 en los logs.
    // `fn` y no `tool`: resumen() ya trae `tool` (los ms de la fase) y pisaba el nombre.
    console.log(JSON.stringify({ evt: "agent", fn: call.function.name, prov, respaldo, voz: quiereVoz, ...t.resumen() }));
    return responder(result);
  } catch (error) {
    console.error("agent error:", error instanceof Error ? error.message : String(error));
    return json({ error: "Algo falló de mi lado. Intenta de nuevo." }, 500);
  }
});
