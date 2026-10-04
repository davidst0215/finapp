// Brief del día por voz: "dame mi brief", "resumen del día", "¿qué tengo hoy?" (en general).
// No tiene loadContext: generar el brief escribe en la base y llama a Google, y loadContext es solo lectura
// y corre antes de confirmar la sesión. Todo ocurre en el handler.
import { adminClient } from "../../_shared/http.ts";
import { generarBrief } from "../../brief/generate.ts";
import { type AgentModule, tool } from "../types.ts";

const rules = `BRIEF DEL DÍA:
- "dame mi brief", "resumen del día", "qué tengo hoy" (en general: agenda, tareas y pagos juntos) = get_brief.
- Si pregunta solo por reuniones o por la agenda de un día concreto, usa calendar_view, no get_brief.`;

export const brief: AgentModule = {
  id: "brief",
  rules,
  definitions: [
    tool("get_brief", "Dice el brief de hoy: agenda, tareas vencidas, pagos próximos, gastado del mes y esperas. Para 'dame mi brief', 'resumen del día' o '¿qué tengo hoy?' en general.", {}),
  ],
  handlers: {
    get_brief: async (_args, { user }) => {
      if (user.id !== Deno.env.get("WABID_OWNER_ID")) {
        return { action: "get_brief", message: "El brief solo está disponible para el dueño de Wabid." };
      }
      try {
        const { brief: b } = await generarBrief(adminClient(), user.id, "manual");
        return { action: "get_brief", message: b.texto, data: { fecha: b.fecha } };
      } catch (e) {
        console.error("get_brief:", e instanceof Error ? e.message : String(e));
        return { action: "error", message: "No pude armar tu brief ahora. Intenta de nuevo en un momento." };
      }
    },
  },
};
