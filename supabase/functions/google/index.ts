// API de Wabid para agenda y correo (la usa la UI; el agente de voz llama a _shared/google.ts directo).
// Un solo POST con { action, ...parámetros }. Requiere el JWT de David; el user_id sale del JWT, nunca del cuerpo.
//
//   status            → conexión, permisos concedidos
//   disconnect        → revoca en Google y borra la conexión
//   events            { from?: AAAA-MM-DD, days?: 1-14 }
//   event.create      { title, date, start_time, end_time? | duration_min?, location?, description?, request_id? }
//   event.move        { event_id, date, start_time, end_time?, confirm_guests? }
//   mail.important    { max?, rest? }
//   mail.drafts       { max? }
//   draft.create      { thread_id, message_id?, body }      (respuesta en el hilo; no envía)
//   draft.update      { draft_id, body }
//   draft.send        { draft_id, expected_message_id, confirm: true }   (único envío; exige confirmación explícita)
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { json, preflight, requireUser } from "../_shared/http.ts";
import * as google from "../_shared/google.ts";
import { describeError } from "../_shared/google/errors.ts";
import { isDateKey, limaDateKey } from "../_shared/google/time.ts";

const int = (v: unknown, fallback: number, min: number, max: number) => {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) && v !== undefined && v !== null ? Math.min(Math.max(n, min), max) : fallback;
};

Deno.serve(async (req: Request) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);

  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;
  const userId = auth.user.id;

  let body: Record<string, unknown>;
  try {
    const parsed = await req.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("no es un objeto");
    body = parsed;
  } catch {
    return json({ error: "Cuerpo inválido", code: "invalido" }, 400);
  }

  try {
    switch (body.action) {
      case "status":
        return json(await google.googleStatus(userId));

      case "disconnect":
        return json(await google.disconnect(userId));

      case "events": {
        const today = limaDateKey(new Date());
        const from = body.from ?? today;
        if (!isDateKey(from)) return json({ error: "La fecha no es válida.", code: "invalido" }, 400);
        const events = await google.calendarEvents(userId, from, int(body.days, 1, 1, 14));
        return json({ events, today, now: new Date().toISOString() });
      }

      case "event.create":
        return json(await google.calendarCreate(userId, body));

      case "event.move":
        return json(await google.calendarMove(userId, body));

      case "mail.important":
        return json(await google.mailImportant(userId, { max: int(body.max, 10, 1, 25), rest: body.rest === true }));

      case "mail.drafts":
        return json({ drafts: await google.mailDrafts(userId, int(body.max, 10, 1, 25)) });

      case "draft.create":
        return json({ draft: await google.draftCreateReply(userId, body) });

      case "draft.update":
        return json({ draft: await google.draftUpdateBody(userId, body) });

      case "draft.send":
        return json(await google.draftSend(userId, body));

      default:
        return json({ error: "Acción desconocida", code: "invalido" }, 400);
    }
  } catch (e) {
    const d = describeError(e);
    if (d.status >= 500 || d.code === "google") console.error(`google ${String(body.action)}:`, e instanceof Error ? `${e.name}: ${e.message}` : e);
    return json({ error: d.message, code: d.code, ...d.data }, d.status);
  }
});
