// Contrato único para avisar a David desde cualquier módulo.
// Hoy deja el aviso en la bandeja (tabla notifications); el módulo `avisos` agrega el envío push
// dentro de esta misma función, sin que los módulos que avisan tengan que cambiar.
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

export type NotificationKind = "brief" | "pago" | "tarea" | "espera" | "agenda" | "correo" | "claude" | "sistema";

export type Notice = { kind: NotificationKind; title: string; body?: string; url?: string };

// `db` debe ser el cliente de servicio (adminClient): la tabla no permite inserts desde el cliente.
export async function notify(db: SupabaseClient, userId: string, notice: Notice): Promise<string | null> {
  const { data, error } = await db.from("notifications").insert({
    user_id: userId,
    kind: notice.kind,
    title: notice.title.slice(0, 120),
    body: notice.body ?? "",
    url: notice.url ?? null,
  }).select("notification_id").single();
  if (error) {
    console.error("notify:", error.message);
    return null;
  }
  return data.notification_id as string;
}
