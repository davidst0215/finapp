import { agenda } from "./tools/agenda.ts";
import { avisos } from "./tools/avisos.ts";
import { brief } from "./tools/brief.ts";
import { contactos } from "./tools/contactos.ts";
import { correo } from "./tools/correo.ts";
import { finanzas } from "./tools/finanzas.ts";
import { reuniones } from "./tools/reuniones.ts";
import { internet } from "./tools/internet.ts";
import { saldo } from "./tools/saldo.ts";
import { memoria } from "./tools/memoria.ts";
import { notas } from "./tools/notas.ts";
import { hechos } from "./tools/hechos.ts";
import { tareas } from "./tools/tareas.ts";
import { conDetalle } from "./respuesta.ts";
import { type AgentModule, tool } from "./types.ts";

// Respuestas generales: siempre disponible, sin contexto propio.
const general: AgentModule = {
  id: "general",
  definitions: [
    tool("query", "Responde preguntas generales o saludos. NO para acciones de otros módulos.", {
      answer: { type: "string", description: "Lo que David ESCUCHA: 2 o 3 frases cortas, unos 180 caracteres y nunca más de 250 (máximo 3 cifras: cada número dicho cuenta ~35). El dato primero y luego el porqué o qué sigue, sin relleno ni despedida. Nunca un marcador ni 'déjame revisar'." },
      detalle: { type: "string", description: "Opcional. Lo que David VE en pantalla (no se dice): más contexto en 1-3 frases cortas. Vacío si la frase basta." },
    }, ["answer"]),
  ],
  handlers: {
    // Pantalla: el detalle (o, sin él, la misma frase). Voz: solo la frase de `answer`.
    query: async (args) => conDetalle("query", args),
  },
};

// Cada módulo de Wabid se agrega aquí con una línea. El orden solo importa para los contextos `estable`: se concatenan en este orden
// tras la persona y las reglas, así que lo que cambia más seguido (hechos) va DESPUÉS del catálogo de fichas (memoria) y no rompe su prefijo cacheado.
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
  notas,
  hechos, // después de memoria: su bloque `estable` va tras el catálogo de fichas y no rompe su prefijo cacheado
  internet,
  saldo,
  contactos,
  avisos,
];
