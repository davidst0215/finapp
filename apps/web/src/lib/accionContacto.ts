// La acción que el agente adjunta a su respuesta (`accion`, ver supabase/functions/agent/types.ts) antes de pintarla como botón.
// El enlace lo arma el servidor, pero la app solo abre lo que reconoce: WhatsApp (api.whatsapp.com/send) y el marcador (tel:).
// Cualquier otra cosa (un esquema javascript:, otro dominio, un teléfono mal formado) se descarta y no se muestra ningún botón.
// Puro: se prueba con Node (accionContacto.test.ts).
import { formatearTelefono } from './telefono.ts'; // con extensión: las pruebas corren en Node

export type AccionContacto = {
  tipo: 'whatsapp' | 'llamar' | 'numero';
  contacto: string;
  relacion?: string;
  /** Para leerlo en la tarjeta ("+51 999 888 777"); sale de la URL, no del servidor. */
  numero: string;
  url: string;
  /** Solo en "numero": el segundo botón. */
  urlWhatsapp?: string;
  /** El mensaje tal como lo dijo David, en primera persona (whatsapp). */
  texto?: string;
};

// El texto va con encodeURIComponent: solo puede traer los caracteres que esa función deja sin codificar (A-Z a-z 0-9 - _ . ! ~ * ' ( ))
// y los escapes %XX. Cualquier otro carácter crudo (una letra con tilde, un espacio, "#", "&", "<") hace que la URL se descarte.
const URL_WHATSAPP = /^https:\/\/api\.whatsapp\.com\/send\?phone=[1-9]\d{7,14}(?:&text=(?:[A-Za-z0-9\-_.!~*'()]|%[0-9A-Fa-f]{2})*)?$/;
const URL_LLAMAR = /^tel:\+[1-9]\d{7,14}$/;

const texto = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.trim() && v.length <= max ? v : undefined);

export const esUrlWhatsapp = (u: unknown): u is string => typeof u === 'string' && u.length <= 8000 && URL_WHATSAPP.test(u);
export const esUrlLlamar = (u: unknown): u is string => typeof u === 'string' && URL_LLAMAR.test(u);

// El teléfono sale de la URL que se va a abrir (ya validada), no del campo `numero` que manda el servidor: lo que la tarjeta muestra
// y lo que el botón marca o escribe no pueden diferir.
const telefonoDeWhatsapp = (u: string): string => `+${/phone=(\d+)/.exec(u)![1]}`;
const telefonoDeTel = (u: string): string => u.slice('tel:'.length);

/** `null` si lo recibido no es una acción que la app sepa abrir. El `numero` de la acción es el de la URL, formateado. */
export function accionSegura(crudo: unknown): AccionContacto | null {
  if (!crudo || typeof crudo !== 'object') return null;
  const a = crudo as Record<string, unknown>;
  const contacto = texto(a.contacto, 200);
  if (!contacto) return null;
  const relacion = texto(a.relacion, 200);
  const datos = (e164: string) => ({ contacto, numero: formatearTelefono(e164), ...(relacion ? { relacion } : {}) });

  if (a.tipo === 'whatsapp') {
    if (!esUrlWhatsapp(a.url)) return null;
    const t = texto(a.texto, 2000);
    return { tipo: 'whatsapp', ...datos(telefonoDeWhatsapp(a.url)), url: a.url, ...(t ? { texto: t } : {}) };
  }
  if (a.tipo === 'llamar') {
    return esUrlLlamar(a.url) ? { tipo: 'llamar', ...datos(telefonoDeTel(a.url)), url: a.url } : null;
  }
  if (a.tipo === 'numero') {
    if (!esUrlLlamar(a.url) || !esUrlWhatsapp(a.urlWhatsapp)) return null;
    // Los dos botones deben ir al mismo teléfono.
    if (telefonoDeTel(a.url) !== telefonoDeWhatsapp(a.urlWhatsapp)) return null;
    return { tipo: 'numero', ...datos(telefonoDeTel(a.url)), url: a.url, urlWhatsapp: a.urlWhatsapp };
  }
  return null;
}
