import { agenda } from "./tools/agenda.ts";
import { brief } from "./tools/brief.ts";
import { contactos } from "./tools/contactos.ts";
import { correo } from "./tools/correo.ts";
import { finanzas } from "./tools/finanzas.ts";
import { reuniones } from "./tools/reuniones.ts";
import { internet } from "./tools/internet.ts";
import { saldo } from "./tools/saldo.ts";
import { memoria } from "./tools/memoria.ts";
import { tareas } from "./tools/tareas.ts";
import { conDetalle } from "./respuesta.ts";
import { type AgentModule, tool } from "./types.ts";

// Respuestas generales: siempre disponible, sin contexto propio.
const general: AgentModule = {
  id: "general",
  definitions: [
    tool("query", "Responde preguntas generales o saludos. NO para acciones de otros módulos.", {
      answer: { type: "string", description: "Lo que David ESCUCHA: UNA frase de 80 caracteres o menos (60 si lleva cifras: cada número dicho cuenta ~35), el dato primero, sin relleno ni despedida. Nunca un marcador ni 'déjame revisar'." },
      detalle: { type: "string", description: "Opcional. Lo que David VE en pantalla (no se dice): más contexto en 1-3 frases cortas. Vacío si la frase basta." },
    }, ["answer"]),
  ],
  handlers: {
    // Pantalla: el detalle (o, sin él, la misma frase). Voz: solo la frase de `answer`.
    query: async (args) => conDetalle("query", args),
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
  contactos,
];
