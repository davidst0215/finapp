// Correo: direcciones, armado de MIME para borradores (base64url) y lectura de mensajes de Gmail.
// Lógica pura (sin Deno, sin red). Todo lo que viene de fuera se trata como no confiable:
// los encabezados se limpian de saltos de línea (inyección de encabezados) antes de armarse.
import { base64ToBytes, base64UrlToBytes, bytesToBase64, utf8ToBase64Url } from "./b64.ts";
import { bestMatches, norm } from "./text.ts";

export type Address = { name: string; email: string };

// ---------------------------------------------------------------- encabezados

// Quita controles (incluye CR y LF): un valor así nunca puede abrir un encabezado nuevo.
export const sanitizeHeader = (v: string) => v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();

const EMAIL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;
export const isEmail = (s: string) => s.length <= 254 && EMAIL.test(s);

const ASCII = /^[\x20-\x7e]*$/;
const utf8 = (s: string) => new TextEncoder().encode(s);

// RFC 2047: texto con tildes/ñ en un encabezado va como palabras codificadas (=?UTF-8?B?…?=).
export function encodeWord(text: string): string {
  if (ASCII.test(text)) return text;
  const words: string[] = [];
  let chunk = "";
  let bytes = 0;
  for (const ch of text) { // por punto de código: nunca parte un carácter de varios bytes
    const n = utf8(ch).length;
    if (bytes + n > 42) {
      words.push(chunk);
      chunk = "";
      bytes = 0;
    }
    chunk += ch;
    bytes += n;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${bytesToBase64(utf8(w))}?=`).join("\r\n ");
}

const hex2 = /^[0-9A-Fa-f]{2}$/;

export function decodeWords(value: string): string {
  const joined = value.replace(/(\?=)\s+(?==\?)/g, "$1"); // entre palabras codificadas contiguas el espacio no cuenta
  return joined.replace(/=\?([^?\s]+)\?([bBqQ])\?([^?\s]*)\?=/g, (whole: string, charset: string, enc: string, data: string) => {
    try {
      let bytes: Uint8Array | null;
      if (enc.toUpperCase() === "B") {
        bytes = base64ToBytes(data + "=".repeat((4 - (data.length % 4)) % 4));
      } else {
        const s = data.replace(/_/g, " ");
        const out: number[] = [];
        for (let i = 0; i < s.length; i++) {
          if (s[i] === "=" && hex2.test(s.slice(i + 1, i + 3))) {
            out.push(parseInt(s.slice(i + 1, i + 3), 16));
            i += 2;
          } else {
            out.push(...utf8(s[i] as string));
          }
        }
        bytes = Uint8Array.from(out);
      }
      return bytes ? new TextDecoder(charset.toLowerCase()).decode(bytes) : whole;
    } catch {
      return whole;
    }
  });
}

// ---------------------------------------------------------------- direcciones

function splitList(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i] as string;
    if (c === "\\" && quoted) {
      cur += c + (s[i + 1] ?? "");
      i++;
      continue;
    }
    if (c === '"') quoted = !quoted;
    else if (!quoted && c === "<") depth++;
    else if (!quoted && c === ">") depth = Math.max(0, depth - 1);
    if (c === "," && !quoted && depth === 0) {
      out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

// "Mónica Pérez <monica@tdv.com>", "\"Pérez, M.\" <m@x.com>", "m@x.com" → { name, email }
export function parseAddress(value: string): Address | null {
  const v = value.replace(/\([^)]*\)/g, "").trim(); // quita comentarios (…)
  const m = /^(.*?)<([^<>]+)>\s*$/s.exec(v);
  const email = (m ? (m[2] as string) : v.replace(/^<|>$/g, "")).trim();
  if (!isEmail(email)) return null;
  const rawName = m ? (m[1] as string).trim().replace(/^"(.*)"$/s, "$1").replace(/\\(.)/g, "$1") : "";
  return { name: sanitizeHeader(decodeWords(rawName)), email };
}

export function parseAddressList(value: string): Address[] {
  return splitList(value).map(parseAddress).filter((a): a is Address => a !== null);
}

export function formatAddress(a: Address): string {
  const name = sanitizeHeader(a.name);
  if (!name) return a.email;
  if (ASCII.test(name)) return `"${name.replace(/(["\\])/g, "\\$1")}" <${a.email}>`;
  return `${encodeWord(name)} <${a.email}>`;
}

export const displayName = (a: Address) => a.name || a.email;

// ---------------------------------------------------------------- MIME de borradores

export function replySubject(subject: string): string {
  const s = sanitizeHeader(subject);
  if (!s) return "Re:";
  return /^(re|rv|aw|sv)\s*:/i.test(s) ? s : `Re: ${s}`;
}

const MSG_ID = /^<[^<>\s]+>$/;
const cleanMsgId = (v?: string) => {
  const s = sanitizeHeader(v ?? "");
  return MSG_ID.test(s) ? s : "";
};
const cleanReferences = (v?: string) => {
  const ids = sanitizeHeader(v ?? "").split(" ").filter((t) => MSG_ID.test(t));
  let out = ids.join(" ");
  while (out.length > 900 && ids.length > 1) { // la cadena larga se recorta por el principio
    ids.shift();
    out = ids.join(" ");
  }
  return out;
};

export type MimeInput = {
  to: Address[];
  cc?: Address[];
  bcc?: Address[];
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string;
};

export function buildMime(h: MimeInput): string {
  for (const a of [...h.to, ...(h.cc ?? []), ...(h.bcc ?? [])]) {
    if (!isEmail(a.email)) throw new Error("Dirección de correo inválida");
  }
  const lines = ["MIME-Version: 1.0"];
  if (h.to.length) lines.push(`To: ${h.to.map(formatAddress).join(", ")}`);
  if (h.cc?.length) lines.push(`Cc: ${h.cc.map(formatAddress).join(", ")}`);
  if (h.bcc?.length) lines.push(`Bcc: ${h.bcc.map(formatAddress).join(", ")}`);
  lines.push(`Subject: ${encodeWord(sanitizeHeader(h.subject))}`);
  const inReplyTo = cleanMsgId(h.inReplyTo);
  if (inReplyTo) lines.push(`In-Reply-To: ${inReplyTo}`);
  const refs = cleanReferences(h.references);
  if (refs) lines.push(`References: ${refs}`);
  lines.push('Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64", "");
  const body = h.body.replace(/\r\n|\r|\n/g, "\r\n"); // texto canónico: CRLF
  const b64 = bytesToBase64(utf8(body));
  lines.push(...(b64.match(/.{1,76}/g) ?? [""]));
  return lines.join("\r\n");
}

// Valor del campo `raw` de Gmail: el mensaje RFC 2822 en base64url.
export const buildRaw = (h: MimeInput) => utf8ToBase64Url(buildMime(h));

// ---------------------------------------------------------------- mensajes de Gmail

export type GHeader = { name?: string; value?: string };
export type GPart = {
  mimeType?: string;
  headers?: GHeader[];
  filename?: string;
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: GPart[];
};
export type GMessage = {
  id?: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string; // milisegundos desde 1970, como texto
  payload?: GPart;
};
export type GDraft = { id?: string; message?: GMessage };

export function header(headers: GHeader[] | undefined, name: string): string {
  const n = name.toLowerCase();
  return headers?.find((h) => h.name?.toLowerCase() === n)?.value ?? "";
}

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…", ndash: "–", mdash: "—",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", iquest: "¿", iexcl: "¡", aacute: "á", eacute: "é", iacute: "í",
  oacute: "ó", uacute: "ú", ntilde: "ñ", Aacute: "Á", Eacute: "É", Iacute: "Í", Oacute: "Ó", Uacute: "Ú", Ntilde: "Ñ",
};

// El `snippet` de Gmail llega con entidades HTML (&#39;, &amp;…).
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole: string, e: string) => {
    if (e.startsWith("#")) {
      const code = e[1]?.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    return NAMED[e] ?? NAMED[e.toLowerCase()] ?? whole;
  });
}

export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(style|script)[\s\S]*?<\/\1>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
      .replace(/<[^>]+>/g, ""),
  ).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
}

function findPart(p: GPart, type: string): GPart | null {
  if ((p.mimeType ?? "").toLowerCase() === type && p.body?.data) return p;
  for (const c of p.parts ?? []) {
    const f = findPart(c, type);
    if (f) return f;
  }
  return null;
}

function decodePart(p: GPart): string {
  const bytes = base64UrlToBytes(p.body?.data ?? "");
  if (!bytes) return "";
  const charset = /charset="?([^";\s]+)/i.exec(header(p.headers, "Content-Type"))?.[1] ?? "utf-8";
  try {
    return new TextDecoder(charset.toLowerCase()).decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}

// Texto legible del cuerpo: prefiere text/plain; si solo hay HTML lo convierte.
export function textFromPayload(payload: GPart | undefined): string {
  if (!payload) return "";
  const plain = findPart(payload, "text/plain");
  if (plain) return decodePart(plain).trim();
  const html = findPart(payload, "text/html");
  return html ? htmlToText(decodePart(html)).trim() : "";
}

// Alarmas de dinero o seguridad (cargo no reconocido, acceso sospechoso…). Son lo único que se pinta en rojo.
const ALARM = new RegExp(
  [
    "cargo no reconocido", "no reconoc", "transaccion sospechosa", "actividad sospechosa", "movimiento sospechoso",
    "inicio de sesion (?:sospechoso|no reconocido|inusual)", "acceso no autorizado", "intento de fraude", "posible fraude",
    "alerta de seguridad", "cuenta (?:bloqueada|suspendida|comprometida)", "security alert", "unauthorized", "suspicious",
  ].join("|"),
);
export const isAlarm = (subject: string, snippet = "") => ALARM.test(norm(`${subject} ${snippet}`));

export type MailItem = {
  id: string;
  thread_id: string;
  from_name: string;
  from_email: string;
  subject: string;
  snippet: string;
  received_at: string; // ISO
  unread: boolean;
  important: boolean;
  alarm: boolean;
};

export function mapMessage(m: GMessage): MailItem | null {
  if (!m.id || !m.threadId) return null;
  const h = m.payload?.headers;
  const from = parseAddress(header(h, "From")) ?? { name: "", email: header(h, "From").trim() };
  const subject = sanitizeHeader(decodeWords(header(h, "Subject"))) || "(sin asunto)";
  const snippet = decodeEntities(m.snippet ?? "").trim();
  const ms = Number(m.internalDate);
  const labels = m.labelIds ?? [];
  return {
    id: m.id,
    thread_id: m.threadId,
    from_name: from.name,
    from_email: from.email,
    subject,
    snippet,
    received_at: Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : new Date(0).toISOString(),
    unread: labels.includes("UNREAD"),
    important: labels.includes("IMPORTANT"),
    alarm: isAlarm(subject, snippet),
  };
}

// ---------------------------------------------------------------- responder en el hilo

export type ReplyTarget = {
  message_id: string;
  thread_id: string;
  to: Address[];
  subject: string;
  in_reply_to: string;
  references: string;
};

// Elige a quién y a qué mensaje se responde. `me` = correo de la cuenta conectada (no se responde a uno mismo).
export function replyTarget(
  thread: { id?: string; messages?: GMessage[] },
  me: string,
  preferMessageId?: string,
): ReplyTarget | null {
  const msgs = [...(thread.messages ?? [])].sort((a, b) => Number(a.internalDate ?? 0) - Number(b.internalDate ?? 0));
  if (msgs.length === 0) return null;
  const mine = (m: GMessage) => {
    const from = parseAddress(header(m.payload?.headers, "From"));
    return (m.labelIds ?? []).includes("SENT") || from?.email.toLowerCase() === me.toLowerCase();
  };
  const target = preferMessageId
    ? msgs.find((m) => m.id === preferMessageId)
    : [...msgs].reverse().find((m) => !mine(m)) ?? msgs[msgs.length - 1];
  if (!target?.id || !target.threadId) return null;

  const h = target.payload?.headers;
  const candidates = mine(target)
    ? parseAddressList(header(h, "To"))
    : [parseAddress(header(h, "Reply-To")) ?? parseAddress(header(h, "From"))].filter((a): a is Address => a !== null);
  const to = candidates.filter((a) => a.email.toLowerCase() !== me.toLowerCase());
  if (to.length === 0) return null;

  const messageId = cleanMsgId(header(h, "Message-ID"));
  return {
    message_id: target.id,
    thread_id: target.threadId,
    to,
    subject: replySubject(decodeWords(header(h, "Subject"))),
    in_reply_to: messageId,
    references: `${header(h, "References")} ${messageId}`.trim(),
  };
}

// ---------------------------------------------------------------- borradores

export type DraftItem = {
  draft_id: string;
  message_id: string; // cambia cada vez que el borrador se edita: sirve para confirmar "esto es lo que viste"
  thread_id: string;
  to: string; // para mostrar: nombres
  to_email: string; // para confirmar: direcciones
  subject: string;
  body: string;
  snippet: string;
  updated_at: string;
  editable: boolean; // false si tiene adjuntos: reescribirlo desde Wabid los perdería
};

export const MAX_BODY_CHARS = 8000;

function hasAttachments(p: GPart | undefined): boolean {
  if (!p) return false;
  if (p.body?.attachmentId || (p.filename ?? "") !== "") return true;
  return (p.parts ?? []).some(hasAttachments);
}

export function mapDraft(d: GDraft): DraftItem | null {
  const m = d.message;
  if (!d.id || !m?.id) return null;
  const h = m.payload?.headers;
  const to = parseAddressList(header(h, "To"));
  const ms = Number(m.internalDate);
  return {
    draft_id: d.id,
    message_id: m.id,
    thread_id: m.threadId ?? "",
    to: to.map(displayName).join(", "),
    to_email: to.map((a) => a.email).join(", "),
    subject: sanitizeHeader(decodeWords(header(h, "Subject"))) || "(sin asunto)",
    body: textFromPayload(m.payload).slice(0, MAX_BODY_CHARS),
    snippet: decodeEntities(m.snippet ?? "").trim(),
    updated_at: Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : new Date(0).toISOString(),
    editable: !hasAttachments(m.payload),
  };
}

// Para editar: Gmail reemplaza el mensaje entero, así que se rearma con los mismos encabezados y el cuerpo nuevo.
export function rebuildDraft(d: GDraft, body: string): { raw: string; threadId?: string } {
  const h = d.message?.payload?.headers;
  const raw = buildRaw({
    to: parseAddressList(header(h, "To")),
    cc: parseAddressList(header(h, "Cc")),
    bcc: parseAddressList(header(h, "Bcc")),
    subject: decodeWords(header(h, "Subject")),
    body,
    inReplyTo: header(h, "In-Reply-To"),
    references: header(h, "References"),
  });
  return { raw, threadId: d.message?.threadId };
}

// Búsqueda por remitente o asunto entre correos ya cargados ("responde a Mónica").
export const matchMail = (items: MailItem[], who: string): MailItem[] =>
  bestMatches(items, who, (m) => `${m.from_name} ${m.from_email} ${m.subject}`);
