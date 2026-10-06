// Saldo de IA por voz: "¿cuánto saldo me queda?", "¿cuánto he gastado en IA?". Solo lectura de dos APIs de consulta
// (no gastan crédito). Sin loadContext: llama a terceros y loadContext corre antes de confirmar la sesión.
import { esDueno } from "../../_shared/dueno.ts";
import { mensajeVoz } from "../../_shared/saldo.ts";
import { obtenerSaldo } from "../../_shared/saldoServicio.ts";
import { type AgentModule, tool } from "../types.ts";

const rules = `SALDO DE IA:
- "cuánto saldo me queda", "cuánto he gastado en IA", "cuánto me queda de OpenRouter", "cuánto llevo gastado en el asistente" = get_saldo_ia. Es el crédito del modelo y de la voz de Wabid, NO el dinero personal de David.`;

export const saldo: AgentModule = {
  id: "saldo",
  rules,
  definitions: [
    tool("get_saldo_ia", "Dice cuánto crédito de IA queda (OpenRouter), cuánto se gastó en el mes, cuánto durará y cuánto va la voz. Para '¿cuánto saldo me queda?' o '¿cuánto he gastado en IA?'.", {}),
  ],
  handlers: {
    get_saldo_ia: async (_args, { user }) => {
      // Mismo criterio que el brief: solo el dueño; sin WABID_OWNER_ID configurado falla cerrado.
      if (!esDueno(user.id, Deno.env.get("WABID_OWNER_ID"))) {
        return { action: "get_saldo_ia", message: "El saldo de IA solo está disponible para el dueño de Wabid." };
      }
      try {
        const s = await obtenerSaldo();
        return s.openrouter.estado === "ok"
          ? { action: "get_saldo_ia", message: mensajeVoz(s), data: s }
          : { action: "error", message: mensajeVoz(s) };
      } catch (e) {
        console.error("get_saldo_ia:", e instanceof Error ? e.message : String(e));
        return { action: "error", message: "No pude consultar tu saldo ahora. Inténtalo en un momento." };
      }
    },
  },
};
