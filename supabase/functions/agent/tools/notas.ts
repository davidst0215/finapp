// Módulo "notas" del agente: deja por voz o texto una nota en el vault de David («anota en novafondos que decidimos cesión de
// 0,02 % mensual»). Va al final de `20-projects/<carpeta>/notas.md` (nunca a las fichas curadas de 60-wiki) con la fecha y la hora de
// Lima, y entra al índice al instante para que search_memory la encuentre. Sin contexto propio: cero consultas por pedido.
import { type AgentContext, type AgentModule, type ToolResult, tool } from "../types.ts";
import { agregarNota, GitHubError, resolverProyectoDicho, VaultError } from "../../_shared/vault.ts";
import { relojLima } from "../../_shared/vault/fechas.ts";
import { corto } from "../../_shared/vault/speech.ts";
import { planearNota } from "./notasPlan.ts";
import { acceso, err, logProyecto, str } from "./tareas.ts";

const rules = `NOTAS (el vault de David):
- Nota = algo que se decidió, pasó o se supo y David quiere dejar escrito en un proyecto: "anota en novafondos que decidimos X", "deja anotado en tdv que Y", "nota para vera: Z" → add_note. Si es algo por hacer ("anota llamar a Ana", "recuérdame …") es una tarea: create_task.
- text = lo que quiere dejar, casi literal y sin el "anota en …"; project = sus palabras ("nova fondos"); vacío si no dijo proyecto (va al cajón). Si el sistema pregunta cuál o confirma y David responde, repite add_note con el texto original (mira el historial) y el proyecto completo.
- Voz: una frase.`;

/** Errores de dominio → frase para decir en voz; lo inesperado se registra sin datos y se dice genérico. */
function mensajeError(e: unknown): string {
  if (e instanceof VaultError) return e.message;
  if (e instanceof GitHubError) return "No pude hablar con GitHub ahora. Inténtalo en un momento.";
  console.error("notas:", e instanceof Error ? e.message : String(e));
  return "Algo falló al anotar. Inténtalo de nuevo.";
}

const addNote = async (args: Record<string, unknown>, ctx: AgentContext): Promise<ToolResult> => {
  try {
    const { env, db, userId, hoy } = acceso(ctx);
    // El proyecto solo se busca si David nombró uno: sin proyecto la nota va al cajón.
    const dicho = str(args.project).trim();
    const resuelto = dicho ? (await resolverProyectoDicho(db, userId, env.config, dicho)).r : null;
    const planeado = planearNota(args, resuelto);
    const pedido = "plan" in planeado ? planeado.plan.proyecto : planeado.proyecto;
    if (pedido) logProyecto(pedido, "notas");
    if ("respuesta" in planeado) return planeado.respuesta;
    const { plan } = planeado;

    await agregarNota(db, userId, env, { folder: plan.folder, texto: plan.texto, hoy, minutos: relojLima(ctx.limaNow).minutos });
    // Pantalla: con el texto. Voz: sin repetirlo (David acaba de decirlo), solo dónde quedó.
    return {
      action: "add_note",
      message: `Anoté «${corto(plan.texto, 60)}» en ${plan.donde}.`,
      voz: `Anotado en ${plan.donde}.`,
      data: { folder: plan.folder },
    };
  } catch (e) {
    return err(mensajeError(e));
  }
};

export const notas: AgentModule = {
  id: "notas",
  rules,
  definitions: [
    tool("add_note", "Deja una nota o decisión escrita en el vault de David, en la carpeta de un proyecto. Para 'anota en <proyecto> que decidimos / quedamos en / el dato es …'. No es para tareas por hacer.", {
      text: { type: "string", description: "Lo que David quiere dejar escrito, casi literal y sin el 'anota en …' (ej. 'decidimos cesión de 0,02 % mensual')" },
      project: { type: "string", description: "Proyecto o frente con las palabras de David ('nova fondos', 'tdv bolsa'); vacío si no lo dijo (va al cajón)" },
    }, ["text"]),
  ],
  handlers: { add_note: addNote },
};
