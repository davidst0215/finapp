// Base de toda edge function nueva de Wabid: CORS, respuestas JSON y usuario autenticado.
import { createClient, type SupabaseClient, type User } from "jsr:@supabase/supabase-js@2";

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

export const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...corsHeaders } });

export const preflight = (req: Request) =>
  req.method === "OPTIONS" ? new Response(null, { headers: corsHeaders }) : null;

// Cliente de servicio: salta RLS. Solo para trabajos del sistema (cron, webhooks), nunca con datos que mande el cliente sin validar.
export const adminClient = (): SupabaseClient =>
  createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");

// Valida el JWT del pedido y devuelve el usuario y un cliente que actúa como él (RLS aplica).
// La anon key también es un JWT válido para el gateway: por eso se exige un usuario real.
export async function requireUser(req: Request): Promise<{ user: User; db: SupabaseClient } | Response> {
  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return json({ error: "No autorizado" }, 401);
  const db = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
    global: { headers: { Authorization: auth } },
  });
  const { data: { user } } = await db.auth.getUser(auth.slice(7));
  if (!user) return json({ error: "No autorizado" }, 401);
  return { user, db };
}

// Hora de Lima (UTC-5 todo el año) usable con getters locales en el runtime UTC.
export const limaNow = () => new Date(Date.now() - 5 * 60 * 60 * 1000);
