// claude-events: puente entre los hooks de Claude Code (laptop) y el celular de David.
//
// DESPLIEGUE: sin verificación de JWT, porque la laptop se identifica con un token de dispositivo y no con
// un usuario de Supabase:
//   npx supabase functions deploy claude-events --no-verify-jwt --project-ref rrhyyclltgaecfyertqh
// Por eso cada ruta se autentica sola (ver handlers.ts):
//   /device/*  cabecera x-wabid-device-token, comparada contra su hash SHA-256
//   /ui/*      JWT del usuario vía requireUser
// No usa secretos nuevos: SUPABASE_URL, SUPABASE_ANON_KEY y SUPABASE_SERVICE_ROLE_KEY los inyecta la plataforma.
//
// Contrato completo: tools/claude-hooks/README.md y handlers.ts.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { adminClient, json, preflight, requireUser } from "../_shared/http.ts";
import { notify } from "../_shared/notify.ts";
import { readBodyLimited } from "./body.ts";
import { handleApi } from "./handlers.ts";
import { createSupabaseStore } from "./supabase-store.ts";

const MAX_BODY_BYTES = 64_000;

Deno.serve(async (req: Request) => {
  const pre = preflight(req);
  if (pre) return pre;

  // Sin ninguna credencial no hay nada que atender: se responde antes de leer el cuerpo.
  if (!req.headers.has("x-wabid-device-token") && !req.headers.has("authorization")) {
    return json({ error: "No autorizado" }, 401);
  }
  const body = await readBodyLimited(req, MAX_BODY_BYTES);
  if (body === null) return json({ error: "Cuerpo demasiado grande" }, 413);

  // Cliente de servicio: salta RLS. El aislamiento entre usuarios lo garantiza el Store (todo lleva user_id).
  const db = adminClient();
  const result = await handleApi(
    { method: req.method, path: new URL(req.url).pathname, headers: req.headers, body },
    {
      store: createSupabaseStore(db),
      now: () => new Date(),
      notify: (userId, notice) => notify(db, userId, notice),
      authenticateUser: async () => {
        const auth = await requireUser(req);
        return auth instanceof Response ? null : { userId: auth.user.id };
      },
      randomUUID: () => crypto.randomUUID(),
      publicUrl: `${Deno.env.get("SUPABASE_URL") ?? ""}/functions/v1/claude-events`,
    },
  );
  return json(result.body, result.status);
});
