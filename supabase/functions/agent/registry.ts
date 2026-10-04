import { agenda } from "./tools/agenda.ts";
import { correo } from "./tools/correo.ts";
import { finanzas } from "./tools/finanzas.ts";
import { type AgentModule, tool } from "./types.ts";

// Respuestas generales: siempre disponible, sin contexto propio.
const general: AgentModule = {
  id: "general",
  definitions: [
    tool("query", "Responde preguntas generales o saludos. NO para acciones de otros módulos.", { answer: { type: "string" } }, ["answer"]),
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
  correo,
  finanzas,
];
