import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { bearer, jwtSub } from "../_shared/jwt.ts";
import { pedirVoz, vozConfigurada } from "../_shared/elevenlabs.ts";

// Un cliente por instancia: guarda las llaves públicas de Auth (JWKS) entre pedidos, así la firma
// del token se verifica aquí mismo en vez de preguntarle a Auth en cada frase (getUser: p50 225 ms,
// p90 693 ms en los logs del agente del 5-oct).
const supabase = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
  auth: { persistSession: false, autoRefreshToken: false },
});

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Max-Age": "7200", // preflight recordado 2 h (ver _shared/http.ts)
};

const jsonError = (error: string, status: number) =>
  new Response(JSON.stringify({ error }), {
    status, headers: { "Content-Type": "application/json", ...corsHeaders },
  });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    if (!vozConfigurada()) return jsonError("Voz no configurada", 500);

    // La anon key también es un JWT válido para el gateway: sin `sub` de usuario se corta aquí,
    // así nadie con la key pública gasta créditos de voz.
    const token = bearer(req);
    const sub = jwtSub(token);
    if (!sub) return jsonError("No autorizado", 401);

    const { text } = await req.json();
    if (!text || typeof text !== "string" || text.length > 600) return jsonError("Texto inválido", 400);

    // El token se confirma ANTES de pedir la voz: lo que cobra ElevenLabs no puede depender
    // de que el gateway tenga verify_jwt activo. getClaims revisa firma y vencimiento con la llave
    // pública (ES256); no ve un cierre de sesión anterior al vencimiento (1 h), riesgo aceptable aquí.
    const t0 = performance.now();
    const { data: verificado, error: errorToken } = await supabase.auth.getClaims(token);
    const authMs = Math.round(performance.now() - t0);
    if (errorToken || verificado?.claims?.sub !== sub) return jsonError("No autorizado", 401);
    console.log(JSON.stringify({ evt: "tts", auth: authMs, chars: text.length }));

    const response = await pedirVoz(text);
    if (!response.ok || !response.body) {
      console.error("tts elevenlabs:", response.status, (await response.text()).slice(0, 300));
      return jsonError("No pude generar la voz", 502);
    }

    return new Response(response.body, { headers: { "Content-Type": "audio/mpeg", ...corsHeaders } });
  } catch (error) {
    console.error("tts error:", error instanceof Error ? error.message : String(error));
    return jsonError("No pude generar la voz", 500);
  }
});
