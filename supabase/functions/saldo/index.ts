// Saldo de IA de Wabid: lo que queda en OpenRouter (modelo) y el consumo de ElevenLabs (voz).
// Función propia y no una ruta de `agent`/`tts`: la llama solo la pantalla Más, tiene secretos y reglas de acceso
// distintas (solo el dueño) y así un fallo o un cambio aquí no toca la voz ni el agente, que están en el camino crítico.
// Despliegue con verify_jwt normal: `npx supabase functions deploy saldo --project-ref rrhyyclltgaecfyertqh`.
// Secretos: OPENROUTER_API_KEY, ELEVENLABS_API_KEY, WABID_OWNER_ID (los tres ya existen).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders, json } from "../_shared/http.ts";
import { bearer, jwtSub } from "../_shared/jwt.ts";
import { obtenerSaldo } from "../_shared/saldoServicio.ts";

// Un cliente por instancia: guarda las llaves públicas de Auth (JWKS) y getClaims verifica la firma sin viaje a Auth.
const supabase = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
  auth: { persistSession: false, autoRefreshToken: false },
});

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "GET" && req.method !== "POST") return json({ error: "Método no permitido" }, 405);

  try {
    // La anon key también es un JWT válido para el gateway: sin `sub` de usuario se corta aquí.
    const token = bearer(req);
    const sub = jwtSub(token);
    if (!sub) return json({ error: "No autorizado" }, 401);
    const { data: verificado, error: errorToken } = await supabase.auth.getClaims(token);
    if (errorToken || verificado?.claims?.sub !== sub) return json({ error: "No autorizado" }, 401);

    // Solo el dueño; sin WABID_OWNER_ID configurado falla cerrado.
    const ownerId = Deno.env.get("WABID_OWNER_ID");
    if (!ownerId) return json({ error: "Falta configurar WABID_OWNER_ID" }, 503);
    if (sub !== ownerId) return json({ error: "No autorizado" }, 403);

    return json(await obtenerSaldo());
  } catch (e) {
    console.error("saldo:", e instanceof Error ? e.message : String(e));
    return json({ error: "No pude consultar el saldo. Intenta de nuevo." }, 500);
  }
});
