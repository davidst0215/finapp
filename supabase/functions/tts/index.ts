import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { bearer, jwtSub } from "../_shared/jwt.ts";
import { montosAVoz } from "../_shared/voz.ts";

const ELEVENLABS_API_KEY = Deno.env.get("ELEVENLABS_API_KEY");
const VOICE_ID = Deno.env.get("ELEVENLABS_VOICE_ID");
const MODEL_ID = Deno.env.get("ELEVENLABS_MODEL") ?? "eleven_v4";
const SPEED = Number(Deno.env.get("ELEVENLABS_SPEED") ?? "1.13");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const jsonError = (error: string, status: number) =>
  new Response(JSON.stringify({ error }), {
    status, headers: { "Content-Type": "application/json", ...corsHeaders },
  });

// Prepara el texto para la voz: montos a palabras (determinista) y sin formato de texto.
function paraVoz(text: string): string {
  let t = montosAVoz(text);
  t = t.replace(/\*\*|\*/g, "").replace(/#{1,3}\s/g, "").replace(/(^|\n)\s*[-•]\s/g, "$1");
  t = t.replace(/(\d+(?:\.\d+)?)%/g, "$1 por ciento");
  t = t.replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, "");
  return t.replace(/\s{2,}/g, " ").trim();
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    if (!ELEVENLABS_API_KEY || !VOICE_ID) return jsonError("Voz no configurada", 500);

    // La anon key también es un JWT válido para el gateway: sin `sub` de usuario se corta aquí,
    // así nadie con la key pública gasta créditos de voz.
    const token = bearer(req);
    const sub = jwtSub(token);
    if (!sub) return jsonError("No autorizado", 401);

    const { text } = await req.json();
    if (!text || typeof text !== "string" || text.length > 600) return jsonError("Texto inválido", 400);

    // La sesión se confirma ANTES de pedir la voz: lo que cobra ElevenLabs no puede depender
    // de que el gateway tenga verify_jwt activo.
    const supabase = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_ANON_KEY") ?? "");
    const { data: { user } } = await supabase.auth.getUser(token);
    if (!user || user.id !== sub) return jsonError("No autorizado", 401);

    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream?output_format=mp3_44100_128`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "xi-api-key": ELEVENLABS_API_KEY },
        body: JSON.stringify({ text: paraVoz(text), model_id: MODEL_ID, voice_settings: { speed: SPEED } }),
      },
    );
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
