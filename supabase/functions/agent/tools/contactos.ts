// Contactos y WhatsApp por voz: la agenda propia de Wabid (tabla `contactos`, migración 018).
//   "Guarda a Marco con el 999 888 777, es de Saya" → create_contact
//   "¿Cuál es el número de Marco?"                    → find_contact   (tarjeta con el número y botones)
//   "Escríbele a Marco que llego 10 minutos tarde"    → whatsapp_contact (Wabid pasa lo dicho a primera persona; David toca «Abrir WhatsApp»)
//   "Llama a Marco"                                   → call_contact   (David toca «Llamar»)
// Wabid NUNCA envía ni llama: devuelve una `accion` con el enlace y la app muestra un botón (el navegador exige el toque).
//
// PRIVACIDAD. No hay loadContext: el modelo no recibe la agenda ni sus números en ningún pedido. Solo ve lo que David dice y,
// cuando hay que desempatar, el nombre y la relación que escribe este módulo en `message` ("Marco (de Saya)"). El teléfono se
// agrega aquí, en el servidor, dentro de `accion`; `message` y `voz` jamás lo llevan porque vuelven al modelo como historial.
//
// A QUIÉN SE ESCRIBE. Si el nombre está en la agenda, SIEMPRE gana el número de la agenda. Un número dictado solo se usa cuando
// el nombre no está, y solo si aparece en el mensaje ACTUAL de David (no en turnos anteriores ni en lo que el modelo "recuerde"):
// así un teléfono inventado, o el de otra persona dicho antes, nunca recibe el mensaje. La excepción es create_contact, que sí
// contrasta con los turnos anteriores porque el número pudo venir antes de que David aclarara la relación.
import {
  buscarContacto, type Contacto, fraseCreado, fraseLlamar, fraseNumero, fraseWhatsapp, frasesNoEsta, type Gestion, limpiarMensaje, MAX_CONTACTOS,
  nombreDecible, palabrasContacto, preguntaCual, tieneNumero, validarContactoNuevo,
} from "../../_shared/contactos.ts";
import { formatearTelefono, MAX_MENSAJE, normalizarTelefono, numeroDelDictado, telefonosEnTexto, urlLlamar, urlWhatsapp } from "../../_shared/telefono.ts";
import { limpiarEspacios } from "../../_shared/texto.ts";
import { type AccionCliente, type AgentContext, type AgentModule, type ToolResult, tool } from "../types.ts";

const rules = `CONTACTOS Y WHATSAPP (agenda propia de Wabid; no conoces a los contactos ni sus números, el sistema los busca):
- "guarda / anota / agrega a Marco con el 999 888 777, es de Saya" = create_contact. telefono = SOLO el número que David dijo, tal cual; si no lo dijo, déjalo vacío (el sistema lo pregunta). relacion = pocas palabras ("de Saya", "mi primo").
- "cuál es el número de Marco", "tengo a Marco" = find_contact. "escríbele / mándale un WhatsApp / dile a Marco que llego tarde" = whatsapp_contact. "llama a Marco" = call_contact.
- mensaje de WhatsApp: SOLO lo que David dijo, pasado a primera persona ("que llego 10 minutos tarde" = "Llego 10 minutos tarde"). Corrige lo mínimo y NO agregues saludos, frases, emojis ni detalles que no dijo. Sin comillas, sin firma ni "de parte de David": tú no firmas. "Escríbele a Marco" a secas = sin mensaje. Es correo solo si dice correo o email (mail_draft_reply). Una llamada o reunión agendada ("llamada con Marco el jueves") es calendar_create_event.
- nombre = como David nombró a la persona ("Marco", "mi mamá"), nunca un número; "Marco de Saya" = nombre Marco y relacion "de Saya". Si David solo dictó un número ("llama al 999 888 777"), deja nombre vacío y pon el número en telefono.
- Si el sistema pregunta cuál ("¿Cuál Marco: de Saya o del gimnasio?") o pide el número, y David responde, repite la MISMA tool con el nombre, el mensaje original (mira el historial) y la relacion o el telefono que dijo. Nunca inventes ni completes un número.
- Voz: una frase.`;

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const err = (message: string): ToolResult => ({ action: "error", message });
const sinContacto = "No pude leer tus contactos ahora. Inténtalo de nuevo.";
const NO_SEGURA = "No estoy segura del número que entendí. Dímelo otra vez, dígito por dígito.";
const VARIOS_NUMEROS = "Veo más de un número en lo que dijiste. Dime solo el de quien recibe el mensaje.";

/**
 * Una línea por pedido, sin nombres ni números: sirve para ver cuántas veces no se encuentra o queda ambiguo. `extra` solo lleva
 * conteos (nunca texto): cuántos contactos hay, si el modelo mandó pista de relación y cuántos comparten al menos una palabra.
 */
const log = (fn: string, resultado: string, extra: Record<string, number | boolean> = {}) =>
  console.log(JSON.stringify({ evt: "contactos", fn, resultado, ...extra }));

/**
 * Un teléfono que se coló dentro de `nombre` («999 888 777», «Pedro 999888777», «999/888/777», «999–888–777»): se quita, con sus
 * separadores, para que no se diga ni se busque como nombre. Lo que queda ("Pedro") sí es un nombre.
 */
const quitarNumeros = (s: string) => limpiarEspacios(s.replace(/[+(]?\d[\d\s().,/_–—-]*/g, " ")).replace(/[\s,;:.–—-]+$/, "");

/**
 * Solo el handler lee la tabla (RLS con el JWT de David): ningún otro módulo ni contexto la consulta. Una sola lectura trae toda la
 * agenda: el tope (MAX_CONTACTOS = 1000) es el `max_rows` de PostgREST y lo hace cumplir un trigger de la base. El orden lleva
 * `contacto_id` de desempate para que dos «Marco» salgan siempre en el mismo orden.
 */
async function cargar(ctx: AgentContext): Promise<Contacto[] | null> {
  const { data, error } = await ctx.supabase.from("contactos").select("contacto_id, nombre, alias, telefono, relacion")
    .eq("user_id", ctx.user.id).order("nombre", { ascending: true }).order("contacto_id", { ascending: true }).limit(MAX_CONTACTOS);
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
 * A quién va el mensaje o la llamada.
 * 1. Si el nombre está en la agenda, ese contacto y su número (varios → se pregunta cuál; nunca se mezcla con un número dictado).
 * 2. Si no está y David dictó UN número en ESTE mensaje, ese número, sin guardarlo. Un teléfono que aparece dentro del mensaje
 *    («dile a Ramiro que me llame al 999 111 222») es contenido, no destinatario; y con dos teléfonos distintos se pide confirmar.
 * 3. Si no, se pide el número. Nunca se adivina.
 * `mensaje` es el texto ya limpio que irá en el WhatsApp ("" en llamar y buscar).
 */
async function resolver(fn: string, para: Gestion, args: Record<string, unknown>, ctx: AgentContext, mensaje = ""): Promise<Destino> {
  const nombreDicho = str(args.nombre).replace(/\s+/g, " ");
  // Un número en `nombre` no es un nombre: se busca por lo que quede y, si trae un teléfono, cuenta como el que David dictó.
  let nombre = tieneNumero(nombreDicho) ? quitarNumeros(nombreDicho) : nombreDicho;
  // «al», «el número», «mi»: sin ninguna palabra que nombre a alguien no hay nombre ("Llamar a al" no existe).
  if (palabrasContacto(nombre).length === 0) nombre = "";
  const candidato = para === "buscar" ? "" : String(args.telefono ?? "").trim() || telefonosEnTexto(nombreDicho)[0] || "";

  let diagnostico: Record<string, number | boolean> = {};
  if (nombre) {
    const lista = await cargar(ctx);
    if (!lista) return { ok: false, res: err(sinContacto) };
    const r = buscarContacto(nombre, lista, args.relacion);
    const q = palabrasContacto(nombre);
    diagnostico = {
      agenda: lista.length,
      pista: str(args.relacion) !== "",
      palabras: q.length,
      parcial: lista.filter((c) => [...palabrasContacto(c.nombre), ...c.alias.flatMap(palabrasContacto)].some((t) => q.includes(t))).length,
    };
    if (r.kind === "one") {
      log(fn, "uno");
      return { ok: true, nombre: r.contacto.nombre, relacion: r.contacto.relacion, e164: r.contacto.telefono };
    }
    if (r.kind === "many") {
      log(fn, `varios_${Math.min(r.contactos.length, 9)}`);
      return { ok: false, res: { action: "clarify", ...preguntaCual(r.contactos) } };
    }
  }

  // No está en la agenda. Un número solo vale si es EL que David dictó en este mensaje (y no parte de lo que se va a escribir).
  if (candidato) {
    const t = normalizarTelefono(candidato);
    const v = t.ok ? numeroDelDictado(t.e164, ctx.text, [], telefonosEnTexto(mensaje)) : null;
    if (t.ok && v?.ok) {
      log(fn, "telefono_dictado");
      return { ok: true, nombre: nombre || "ese número", relacion: null, e164: t.e164 };
    }
    // Si el modelo trae un teléfono pero David no dijo ninguno (o era el contenido del mensaje), es inventado o de un turno anterior:
    // se ignora y se pide el número. Si dijo otro, o dos, se avisa.
    const motivo = v && !v.ok ? v.motivo : telefonosEnTexto(ctx.text).length > 0 ? "distinto" : "ninguno";
    if (motivo === "varios") {
      log(fn, "telefono_varios");
      return { ok: false, res: { action: "clarify", message: VARIOS_NUMEROS } };
    }
    if (motivo === "distinto") {
      log(fn, "telefono_distinto");
      return { ok: false, res: { action: "clarify", message: NO_SEGURA } };
    }
    log(fn, "telefono_no_dictado");
  }
  if (!nombre) {
    log(fn, "sin_nombre", { nombre_chars: nombreDicho.length });
    return { ok: false, res: { action: "clarify", message: para === "buscar" ? "¿De quién?" : "¿A quién?" } };
  }
  log(fn, "ninguno", diagnostico);
  return { ok: false, res: { action: "clarify", ...frasesNoEsta(nombreDicho, para) } };
}

const base = (d: Extract<Destino, { ok: true }>): Pick<AccionCliente, "contacto" | "relacion" | "numero"> => ({
  contacto: nombreDecible(d.nombre), ...(d.relacion ? { relacion: d.relacion } : {}), numero: formatearTelefono(d.e164),
});

async function createContact(args: Record<string, unknown>, ctx: AgentContext): Promise<ToolResult> {
  const existentes = await cargar(ctx);
  if (!existentes) return err(sinContacto);
  const v = validarContactoNuevo(args, existentes, ctx.text, ctx.anteriores ?? []);
  if (!v.ok) {
    log("create_contact", v.pregunta ? "pregunta" : v.duplicado ? "duplicado" : "invalido");
    return { action: v.pregunta ? "clarify" : "error", message: v.error };
  }
  const { error } = await ctx.supabase.from("contactos").insert({ user_id: ctx.user.id, ...v.contacto });
  if (error) {
    console.error("create_contact:", error.code ?? "", error.message);
    // 23505 = el índice único (usuario, teléfono): otro alta llegó primero. 23514 = el trigger del tope de contactos (018).
    return err(
      error.code === "23505" ? "Ya tienes ese número guardado."
        : error.code === "23514" ? `Llegaste al límite de ${MAX_CONTACTOS} contactos. Borra alguno desde Contactos.`
        : "No pude guardar el contacto ahora. Inténtalo de nuevo.",
    );
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
  const d = await resolver("whatsapp_contact", "escribir", args, ctx, texto);
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

const nombre = { type: "string", description: "Como David nombró a la persona, solo el nombre o apodo (ej. 'Marco', 'mi mamá'). Nunca un número." };
const relacion = { type: "string", description: "Quién es o de dónde, en pocas palabras (ej. 'de Saya', 'mi primo'); vacío si no lo dijo. Para elegir entre dos con el mismo nombre." };
const telefono = { type: "string", description: "SOLO si David dictó un número en ESTE mensaje: ese número tal cual. Vacío si no; nunca lo inventes ni lo saques del historial." };

export const contactos: AgentModule = {
  id: "contactos",
  rules,
  definitions: [
    tool("create_contact", "Guarda un contacto en la agenda de Wabid: 'guarda a Marco con el 999 888 777, es de Saya'.", {
      nombre, telefono: { ...telefono, description: "El número que David dictó, tal cual. Vacío si no lo dijo; nunca lo inventes." }, relacion,
      alias: { type: "array", items: { type: "string" }, description: "Otros nombres con que David lo llama (ej. ['mamá']); vacío si no dijo" },
    }, ["nombre"]),
    tool("find_contact", "Muestra el número de un contacto guardado: '¿cuál es el número de Marco?', '¿tengo a Marco?'.", { nombre, relacion }, ["nombre"]),
    // `nombre` no es obligatorio en whatsapp ni en call: «escríbele al 999 888 777 que…» trae un número dictado y ningún nombre.
    tool("whatsapp_contact", "Prepara un WhatsApp para un contacto: 'escríbele a Marco que llego 10 minutos tarde', 'mándale un WhatsApp a mi mamá'. No lo envía: David toca el botón.", {
      nombre,
      mensaje: {
        type: "string",
        description: "Lo que David dijo que se escriba, con SUS palabras y en primera persona ('que llego 10 minutos tarde' = 'Llego 10 minutos tarde'). No agregues saludos, frases, emojis ni datos que no dijo; corrige lo mínimo (mayúscula, tildes, puntuación). Sin firma, sin 'de parte de David', sin comillas. Vacío si solo pidió abrir el chat.",
      },
      relacion, telefono,
    }),
    tool("call_contact", "Prepara una llamada a un contacto: 'llama a Marco'. No llama: David toca el botón.", { nombre, relacion, telefono }),
  ],
  handlers: {
    create_contact: guard("create_contact", createContact),
    find_contact: guard("find_contact", findContact),
    whatsapp_contact: guard("whatsapp_contact", whatsappContact),
    call_contact: guard("call_contact", callContact),
  },
};
