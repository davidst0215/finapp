import { agenda } from "./tools/agenda.ts";
import { brief } from "./tools/brief.ts";
import { correo } from "./tools/correo.ts";
import { finanzas } from "./tools/finanzas.ts";
import { reuniones } from "./tools/reuniones.ts";
import { internet } from "./tools/internet.ts";
import { saldo } from "./tools/saldo.ts";
import { memoria } from "./tools/memoria.ts";
import { tareas } from "./tools/tareas.ts";
import { type AgentModule, tool } from "./types.ts";

// Respuestas generales: siempre disponible, sin contexto propio.
const general: AgentModule = {
  id: "general",
  definitions: [
    tool("query", "Responde preguntas generales o saludos. NO para acciones de otros módulos.", {
      answer: { type: "string", description: "Respuesta FINAL que David escucha. Nunca un marcador ni 'déjame revisar'." },
    }, ["answer"]),
  ],
  handlers: {
    query: async (args) => ({ action: "query", message: typeof args.answer === "string" ? args.answer : "" }),
  },
};

// Cada módulo de Wabid se agrega aquí con una línea. El orden no importa.
// deno-lint-ignore no-explicit-any
export const MODULES: AgentModule<any>[] = [
  general,
  agenda,
  brief,
  correo,
  finanzas,
  reuniones,
  tareas,
  memoria,
  internet,
  saldo,
];
