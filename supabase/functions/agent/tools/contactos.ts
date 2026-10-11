// Contactos y WhatsApp por voz: la agenda propia de Wabid (tabla `contactos`, migración 018).
//   "Guarda a Marco con el 999 888 777, es de Saya" → create_contact
//   "¿Cuál es el número de Marco?"                    → find_contact   (tarjeta con el número y botones)
//   "Escríbele a Marco que llego 10 minutos tarde"    → whatsapp_contact (Wabid redacta; David toca «Abrir WhatsApp»)
//   "Llama a Marco"                                   → call_contact   (David toca «Llamar»)
// Wabid NUNCA envía ni llama: devuelve una `accion` con el enlace y la app muestra un botón (el navegador exige el toque).
//
// PRIVACIDAD. No hay loadContext: el modelo no recibe la agenda ni sus números en ningún pedido. Solo ve lo que David dice y,
// cuando hay que desempatar, el nombre y la relación que escribe este módulo en `message` ("Marco (de Saya)"). El teléfono se
// agrega aquí, en el servidor, dentro de `accion`; `message` y `voz` jamás lo llevan porque vuelven al modelo como historial.
import {
  buscarContacto, type Contacto, fraseCreado, fraseLlamar, fraseNumero, fraseWhatsapp, frasesNoEsta, type Gestion, limpiarMensaje, MAX_CONTACTOS,
  preguntaCual, validarContactoNuevo,
} from "../../_shared/contactos.ts";
import { coincideConDictado, formatearTelefono, MAX_MENSAJE, normalizarTelefono, urlLlamar, urlWhatsapp } from "../../_shared/telefono.ts";
import { type AccionCliente, type AgentContext, type AgentModule, type ToolResult, tool } from "../types.ts";

const rules = `CONTACTOS Y WHATSAPP (agenda propia de Wabid; no conoces a los contactos ni sus números, el sistema los busca):
- "guarda / anota / agrega a Marco con el 999 888 777, es de Saya" = create_contact. telefono = SOLO el número que David dijo, tal cual; si no lo dijo, déjalo vacío (el sistema lo pregunta). relacion = pocas palabras ("de Saya", "mi primo").
- "cuál es el número de Marco", "tengo a Marco" = find_contact. "escríbele / mándale un WhatsApp / dile a Marco que llego tarde" = whatsapp_contact. "llama a Marco" = call_contact.
- mensaje de WhatsApp: lo que David enviaría, en primera persona, corto y natural, sin saludo extra, sin comillas y SIN firma ni "de parte de David": tú no firmas. "Escríbele a Marco" a secas = sin mensaje. Es correo solo si dice correo o email (mail_draft_reply). Una llamada o reunión agendada ("llamada con Marco el jueves") es calendar_create_event.
- nombre = como David nombró a la persona ("Marco", "mi mamá"); "Marco de Saya" = nombre Marco y relacion "de Saya".
- Si el sistema pregunta cuál ("¿Cuál Marco: de Saya o del gimnasio?") o pide el número, y David responde, repite la MISMA tool con el nombre, el mensaje original (mira el historial) y la relacion o el telefono que dijo. Nunca inventes ni completes un número.
- Voz: una frase.`;

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const err = (message: string): ToolResult => ({ action: "error", message });
const sinContacto = "No pude leer tus contactos ahora. Inténtalo de nuevo.";

/** Una línea por pedido, sin nombres ni números: sirve para ver cuántas veces no se encuentra o queda ambiguo. */
const log = (fn: string, resultado: string) => console.log(JSON.stringify({ evt: "contactos", fn, resultado }));

/** Lo que David dijo en este turno y en los anteriores, separado para que dos turnos no se fundan en un solo número. */
const dictado = (ctx: AgentContext) => [ctx.text, ...(ctx.anteriores ?? [])].join(" | ");

/** Solo el handler lee la tabla (RLS con el JWT de David): ningún otro módulo ni contexto la consulta. */
async function cargar(ctx: AgentContext): Promise<Contacto[] | null> {
  const { data, error } = await ctx.supabase.from("contactos").select("contacto_id, nombre, alias, telefono, relacion")
    .eq("user_id", ctx.user.id).order("nombre", { ascending: true }).limit(MAX_CONTACTOS);
  if (error) {
    console.error("contactos:", error.code ?? "", error.message);
    return null;
  }
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    contacto_id: String(r.contacto_id),
    nombre: String(r.nombre ?? ""),
    alias: Array.isArray(r.alias) ? r.alias.map(String) : [],
    telefono: String(r.telefono ?? ""),
    relacion: typeof r.relacion === "string" && r.relacion ? r.relacion : null,
  }));
}

type Destino = { ok: true; nombre: string; relacion: string | null; e164: string } | { ok: false; res: ToolResult };

/**
 * A quién va el mensaje o la llamada. Con `telefono` (David acaba de dictar un número que no está en la agenda) se usa ese,
 * siempre que sea el que David dijo. Si no, se busca el nombre en la agenda: ninguno → se pide el número; varios → se pregunta
 * cuál; uno → ese. Nunca se adivina.
 */
async function resolver(fn: string, para: Gestion, args: Record<string, unknown>, ctx: AgentContext): Promise<Destino> {
  const nombre = str(args.nombre).replace(/\s+/g, " ");
  const dicho = args.telefono;
  if (dicho !== undefined && dicho !== null && dicho !== "") {
    const t = normalizarTelefono(dicho);
    if (!t.ok) return { ok: false, res: { action: "clarify", message: t.error } };
    if (!coincideConDictado(t.e164, dictado(ctx))) {
      log(fn, "telefono_no_dictado");
      return { ok: false, res: { action: "clarify", message: "No estoy segura del número que entendí. Dímelo otra vez, dígito por dígito." } };
    }
    log(fn, "telefono_dictado");
    return { ok: true, nombre: nombre || "ese número", relacion: null, e164: t.e164 };
  }
  if (!nombre) return { ok: false, res: { action: "clarify", message: para === "buscar" ? "¿De quién?" : "¿A quién?" } };

  const lista = await cargar(ctx);
  if (!lista) return { ok: false, res: err(sinContacto) };
  const r = buscarContacto(nombre, lista, args.relacion);
  log(fn, r.kind === "one" ? "uno" : r.kind === "many" ? `varios_${Math.min(r.contactos.length, 9)}` : "ninguno");
  if (r.kind === "none") return { ok: false, res: { action: "clarify", ...frasesNoEsta(nombre, para) } };
  if (r.kind === "many") return { ok: false, res: { action: "clarify", ...preguntaCual(r.contactos) } };
  return { ok: true, nombre: r.contacto.nombre, relacion: r.contacto.relacion, e164: r.contacto.telefono };
}

const base = (d: Extract<Destino, { ok: true }>): Pick<AccionCliente, "contacto" | "relacion" | "numero"> => ({
  contacto: d.nombre, ...(d.relacion ? { relacion: d.relacion } : {}), numero: formatearTelefono(d.e164),
});

async function createContact(args: Record<string, unknown>, ctx: AgentContext): Promise<ToolResult> {
  const existentes = await cargar(ctx);
  if (!existentes) return err(sinContacto);
  const v = validarContactoNuevo(args, existentes, dictado(ctx));
  if (!v.ok) {
    log("create_contact", v.pregunta ? "pregunta" : v.duplicado ? "duplicado" : "invalido");
    return { action: v.pregunta ? "clarify" : "error", message: v.error };
  }
  const { error } = await ctx.supabase.from("contactos").insert({ user_id: ctx.user.id, ...v.contacto });
  if (error) {
    console.error("create_contact:", error.code ?? "", error.message);
    // 23505 = el índice único (usuario, teléfono): otro alta llegó primero.
    return err(error.code === "23505" ? "Ya tienes ese número guardado." : "No pude guardar el contacto ahora. Inténtalo de nuevo.");
  }
  log("create_contact", "creado");
  return { action: "create_contact", ...fraseCreado(v.contacto) };
}

async function findContact(args: Record<string, unknown>, ctx: AgentContext): Promise<ToolResult> {
  const d = await resolver("find_contact", "buscar", args, ctx);
  if (!d.ok) return d.res;
  return {
    action: "find_contact",
    ...fraseNumero(d),
    accion: { tipo: "numero", ...base(d), url: urlLlamar(d.e164), urlWhatsapp: urlWhatsapp(d.e164) },
  };
}

async function whatsappContact(args: Record<string, unknown>, ctx: AgentContext): Promise<ToolResult> {
  // El mensaje se revisa antes de buscar: uno desbocado no merece una consulta a la base.
  const texto = limpiarMensaje(args.mensaje);
  if ([...texto].length > MAX_MENSAJE) return err("El mensaje quedó muy largo. Dímelo más corto.");
  const d = await resolver("whatsapp_contact", "escribir", args, ctx);
  if (!d.ok) return d.res;
  return {
    action: "whatsapp_contact",
    ...fraseWhatsapp(d.nombre, texto),
    accion: { tipo: "whatsapp", ...base(d), url: urlWhatsapp(d.e164, texto), ...(texto ? { texto } : {}) },
  };
}

async function callContact(args: Record<string, unknown>, ctx: AgentContext): Promise<ToolResult> {
  const d = await resolver("call_contact", "llamar", args, ctx);
  if (!d.ok) return d.res;
  return { action: "call_contact", ...fraseLlamar(d.nombre), accion: { tipo: "llamar", ...base(d), url: urlLlamar(d.e164) } };
}

type Handler = (args: Record<string, unknown>, ctx: AgentContext) => Promise<ToolResult>;
/** Un fallo inesperado se registra sin datos y se dice genérico: nunca un error técnico. */
const guard = (nombre: string, fn: Handler): Handler => async (args, ctx) => {
  try {
    return await fn(args, ctx);
  } catch (e) {
    console.error(`contactos ${nombre}:`, e instanceof Error ? e.message : String(e));
    return err("Algo falló con tus contactos. Inténtalo de nuevo.");
  }
};

const nombre = { type: "string", description: "Como David nombró a la persona, solo el nombre o apodo (ej. 'Marco', 'mi mamá')" };
const relacion = { type: "string", description: "Quién es o de dónde, en pocas palabras (ej. 'de Saya', 'mi primo'); vacío si no lo dijo. Para elegir entre dos con el mismo nombre." };
const telefono = { type: "string", description: "SOLO si David dictó un número en este mensaje: ese número tal cual. Vacío si no; nunca lo inventes ni lo saques de otro lado." };

export const contactos: AgentModule = {
  id: "contactos",
  rules,
  definitions: [
    tool("create_contact", "Guarda un contacto en la agenda de Wabid: 'guarda a Marco con el 999 888 777, es de Saya'.", {
      nombre, telefono, relacion,
      alias: { type: "array", items: { type: "string" }, description: "Otros nombres con que David lo llama (ej. ['mamá']); vacío si no dijo" },
    }, ["nombre"]),
    tool("find_contact", "Muestra el número de un contacto guardado: '¿cuál es el número de Marco?', '¿tengo a Marco?'.", { nombre, relacion }, ["nombre"]),
    tool("whatsapp_contact", "Prepara un WhatsApp para un contacto: 'escríbele a Marco que llego 10 minutos tarde', 'mándale un WhatsApp a mi mamá'. No lo envía: David toca el botón.", {
      nombre,
      mensaje: { type: "string", description: "El mensaje tal como lo enviaría David: primera persona, corto, natural. Sin firma, sin 'de parte de David', sin comillas. Vacío si solo pidió abrir el chat." },
      relacion, telefono,
    }, ["nombre"]),
    tool("call_contact", "Prepara una llamada a un contacto: 'llama a Marco'. No llama: David toca el botón.", { nombre, relacion, telefono }, ["nombre"]),
  ],
  handlers: {
    create_contact: guard("create_contact", createContact),
    find_contact: guard("find_contact", findContact),
    whatsapp_contact: guard("whatsapp_contact", whatsappContact),
    call_contact: guard("call_contact", callContact),
  },
};

