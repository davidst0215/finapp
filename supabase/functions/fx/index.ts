// Tipo de cambio USD→PEN para Wabid: devuelve el vigente, guardado en fx_rates (migración 016), y lo refresca si ya venció.
//   GET/POST (JWT de cualquier sesión de la app) → { par, fecha, valor, fuente, obtenido_en, actualizado }
// Es un dato público (no de un usuario), pero la función exige sesión: así nadie de afuera dispara consultas a BCRP.
// Fuente: BCRP serie SBS venta; respaldo open.er-api.com; si ambas fallan, el último valor guardado (ver _shared/fx.ts).
// Escribe con el rol de servicio (authenticated no puede escribir fx_rates). La app la llama al abrirse (máx. 1 vez cada 6 h) y el
// brief de las 7:00 también refresca, así que la tabla se mantiene al día sin un cron propio.
// Despliegue con verify_jwt normal: `npx supabase functions deploy fx --project-ref rrhyyclltgaecfyertqh`.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { tipoCambioVigente } from "../_shared/fx.ts";
import { adminClient, json, limaNow, preflight, requireUser } from "../_shared/http.ts";

Deno.serve(async (req: Request) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "GET" && req.method !== "POST") return json({ error: "Método no permitido" }, 405);

  try {
    const auth = await requireUser(req);
    if (auth instanceof Response) return auth;

    const hoy = limaNow().toISOString().slice(0, 10); // fecha de Lima
    const { tasa, actualizado } = await tipoCambioVigente(adminClient(), { ahora: new Date(), hoy });
    if (!tasa) return json({ error: "Todavía no hay tipo de cambio guardado y las fuentes no respondieron." }, 503);
    return json({ ...tasa, actualizado });
  } catch (e) {
    console.error("fx:", e instanceof Error ? e.message : String(e));
    return json({ error: "No pude consultar el tipo de cambio. Intenta de nuevo." }, 500);
  }
});
