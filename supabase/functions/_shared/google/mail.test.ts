// node --experimental-strip-types --test supabase/functions/_shared/google/mail.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { base64ToBytes, base64UrlToBytes, base64UrlToUtf8, bytesToBase64Url, utf8ToBase64Url } from "./b64.ts";
import {
  buildMime, buildRaw, decodeEntities, decodeWords, encodeWord, formatAddress, htmlToText, isAlarm, isEmail, mapDraft, mapMessage,
  matchMail, parseAddress, parseAddressList, rebuildDraft, replySubject, replyTarget, sanitizeHeader, textFromPayload,
  type GDraft, type GMessage, type MailItem,
} from "./mail.ts";

const utf8 = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array | null) => new TextDecoder().decode(b ?? new Uint8Array());
const b64u = (s: string) => utf8ToBase64Url(s);

// Separa un MIME armado en { headers, body } y decodifica el cuerpo base64.
function parseMime(mime: string) {
  const [head, ...rest] = mime.split("\r\n\r\n");
  const headers: Record<string, string> = {};
  // desplegar líneas plegadas (continuación con espacio)
  for (const line of (head as string).replace(/\r\n[ \t]+/g, " ").split("\r\n")) {
    const i = line.indexOf(":");
    headers[line.slice(0, i).toLowerCase()] = line.slice(i + 1).trim();
  }
  return { headers, bodyText: dec(base64ToBytes(rest.join("\r\n\r\n"))), rawBody: rest.join("\r\n\r\n"), head: head as string };
}

describe("base64url", () => {
  it("ida y vuelta con tildes, ñ, emoji y bytes que en base64 estándar dan + y /", () => {
    for (const s of ["Hola Mónica, ¿cómo estás? ñandú 😀", "", "a", "ab", "abc", "???>>>"]) {
      assert.equal(base64UrlToUtf8(utf8ToBase64Url(s)), s);
    }
    const bytes = Uint8Array.from([0xfb, 0xff, 0xfe, 0x3e, 0x3f]); // base64 estándar: "+//+Pj8="
    const url = bytesToBase64Url(bytes);
    assert.equal(url, "-__-Pj8");
    assert.deepEqual([...(base64UrlToBytes(url) as Uint8Array)], [...bytes]);
  });

  it("no usa +, / ni = (sin relleno)", () => {
    for (let n = 0; n < 40; n++) {
      const url = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(n)));
      assert.match(url, /^[A-Za-z0-9_-]*$/);
    }
  });

  it("maneja datos grandes sin reventar la pila", () => {
    const big = new Uint8Array(300_000).fill(7);
    assert.equal(base64UrlToBytes(bytesToBase64Url(big))?.length, 300_000);
  });

  it("rechaza texto que no es base64url", () => {
    assert.equal(base64UrlToBytes("a+b"), null);
    assert.equal(base64UrlToBytes("ab=="), null);
    assert.equal(base64UrlToBytes("a"), null);
  });
});

describe("encabezados", () => {
  it("sanitizeHeader quita saltos de línea y controles", () => {
    assert.equal(sanitizeHeader("Hola\r\nBcc: x@y.com"), "Hola Bcc: x@y.com");
    assert.equal(sanitizeHeader("  a\t\tb\u0000c  "), "a b c");
  });

  it("encodeWord deja el ASCII y codifica lo demás en palabras RFC 2047 de ≤ 75 caracteres", () => {
    assert.equal(encodeWord("Re: Informe 03"), "Re: Informe 03");
    const largo = "Reunión de coordinación año 2026 — ¿cómo vamos con la propuesta? 😀😀😀 más texto largo para partir";
    const enc = encodeWord(largo);
    for (const w of enc.split("\r\n ")) {
      assert.match(w, /^=\?UTF-8\?B\?[A-Za-z0-9+/]+=*\?=$/);
      assert.ok(w.length <= 75, `palabra de ${w.length} caracteres`);
    }
    assert.equal(decodeWords(enc.replace(/\r\n /g, " ")), largo); // nunca parte un carácter de varios bytes
  });

  it("decodeWords entiende B y Q, varias palabras seguidas y otras codificaciones", () => {
    assert.equal(decodeWords("=?UTF-8?B?TcOzbmljYQ==?="), "Mónica");
    assert.equal(decodeWords("=?UTF-8?Q?M=C3=B3nica_P=C3=A9rez?="), "Mónica Pérez");
    assert.equal(decodeWords("=?UTF-8?B?TcOz?= =?UTF-8?B?bmljYQ==?="), "Mónica");
    assert.equal(decodeWords("=?ISO-8859-1?Q?Informaci=F3n?="), "Información");
    assert.equal(decodeWords("Texto normal"), "Texto normal");
    assert.equal(decodeWords("=?charset-raro?B?xxxx?="), "=?charset-raro?B?xxxx?="); // no lanza
  });

  it("replySubject no duplica Re:", () => {
    assert.equal(replySubject("Informe 03"), "Re: Informe 03");
    assert.equal(replySubject("Re: Informe 03"), "Re: Informe 03");
    assert.equal(replySubject("RE: x"), "RE: x");
    assert.equal(replySubject("RV: x"), "RV: x");
    assert.equal(replySubject("Hola\r\nBcc: x@y.com"), "Re: Hola Bcc: x@y.com");
  });
});

describe("direcciones", () => {
  it("isEmail", () => {
    for (const ok of ["a@b.co", "monica.perez+tdv@empresa.com.pe", "o'brien@x.org"]) assert.ok(isEmail(ok), ok);
    for (const bad of ["", "a@b", "a b@c.com", "a@b.com\r\nBcc: x@y.com", "@x.com", "a@@x.com", "a@x..com", "<a@x.com>"]) assert.ok(!isEmail(bad), bad);
  });

  it("parseAddress: con nombre, con comillas, codificada y sin nombre", () => {
    assert.deepEqual(parseAddress("Mónica Pérez <monica@tdv.com>"), { name: "Mónica Pérez", email: "monica@tdv.com" });
    assert.deepEqual(parseAddress('"Pérez, Mónica" <monica@tdv.com>'), { name: "Pérez, Mónica", email: "monica@tdv.com" });
    assert.deepEqual(parseAddress("=?UTF-8?B?TcOzbmljYQ==?= <monica@tdv.com>"), { name: "Mónica", email: "monica@tdv.com" });
    assert.deepEqual(parseAddress("monica@tdv.com"), { name: "", email: "monica@tdv.com" });
    assert.deepEqual(parseAddress("<monica@tdv.com>"), { name: "", email: "monica@tdv.com" });
    assert.deepEqual(parseAddress("monica@tdv.com (Mónica)"), { name: "", email: "monica@tdv.com" });
    assert.equal(parseAddress("sin correo"), null);
    assert.equal(parseAddress(""), null);
  });

  it("parseAddressList respeta comas dentro de comillas", () => {
    const list = parseAddressList('"Pérez, Mónica" <m@x.com>, Juan <j@x.com>, z@x.com');
    assert.deepEqual(list.map((a) => a.email), ["m@x.com", "j@x.com", "z@x.com"]);
    assert.equal(list[0]?.name, "Pérez, Mónica");
  });

  it("formatAddress: ASCII entre comillas, no ASCII codificado, ida y vuelta", () => {
    assert.equal(formatAddress({ name: "", email: "a@b.co" }), "a@b.co");
    assert.equal(formatAddress({ name: 'Ana "la jefa"', email: "a@b.co" }), '"Ana \\"la jefa\\"" <a@b.co>');
    const withAccent = formatAddress({ name: "Mónica Pérez", email: "m@x.com" });
    assert.match(withAccent, /^=\?UTF-8\?B\?.+\?= <m@x\.com>$/);
    assert.deepEqual(parseAddress(withAccent), { name: "Mónica Pérez", email: "m@x.com" });
    assert.deepEqual(parseAddress(formatAddress({ name: 'Ana "la jefa"', email: "a@b.co" })), { name: 'Ana "la jefa"', email: "a@b.co" });
  });
});

describe("MIME del borrador", () => {
  const base = { to: [{ name: "Mónica Pérez", email: "monica@tdv.com" }], subject: "Re: Informe 03", body: "Hola Mónica,\nel Informe 03 ya toma septiembre.\nSaludos, David." };

  it("arma los encabezados y el cuerpo en base64 con líneas de ≤ 76", () => {
    const { headers, bodyText, head } = parseMime(buildMime({ ...base, inReplyTo: "<abc@mail.gmail.com>", references: "<x@y.com> <abc@mail.gmail.com>" }));
    assert.equal(headers["mime-version"], "1.0");
    assert.equal(headers["subject"], "Re: Informe 03");
    assert.equal(headers["in-reply-to"], "<abc@mail.gmail.com>");
    assert.equal(headers["references"], "<x@y.com> <abc@mail.gmail.com>");
    assert.equal(headers["content-type"], 'text/plain; charset="UTF-8"');
    assert.equal(headers["content-transfer-encoding"], "base64");
    assert.deepEqual(parseAddress(headers["to"] as string), { name: "Mónica Pérez", email: "monica@tdv.com" });
    assert.equal(bodyText, "Hola Mónica,\r\nel Informe 03 ya toma septiembre.\r\nSaludos, David."); // CRLF canónico
    assert.ok(!/^From:/mi.test(head), "no fija From: Gmail pone el de la cuenta");
  });

  it("las líneas del cuerpo base64 miden como máximo 76", () => {
    const mime = buildMime({ ...base, body: "Palabra ñ ".repeat(500) });
    for (const line of parseMime(mime).rawBody.split("\r\n")) assert.ok(line.length <= 76);
    assert.equal(parseMime(mime).bodyText, "Palabra ñ ".repeat(500));
  });

  it("asunto con tildes va en palabra codificada y se lee igual", () => {
    const { headers } = parseMime(buildMime({ ...base, subject: "Re: Reunión — cifras de septiembre ✓" }));
    assert.match(headers["subject"] as string, /^=\?UTF-8\?B\?/);
    assert.equal(decodeWords(headers["subject"] as string), "Re: Reunión — cifras de septiembre ✓");
  });

  it("buildRaw es base64url y se decodifica al mismo MIME", () => {
    const raw = buildRaw(base);
    assert.match(raw, /^[A-Za-z0-9_-]+$/);
    assert.equal(base64UrlToUtf8(raw), buildMime(base));
  });

  it("no deja inyectar encabezados por el asunto, el nombre ni el cuerpo", () => {
    const mime = buildMime({
      to: [{ name: "Mónica\r\nBcc: evil@x.com", email: "monica@tdv.com" }],
      subject: "Hola\r\nBcc: evil@x.com\r\nX-Evil: 1",
      body: "texto\r\nBcc: no-es-encabezado",
      inReplyTo: "<ok@x.com>\r\nBcc: evil@x.com",
      references: "<a@b.c>\r\nBcc: evil@x.com <d@e.f>",
    });
    const headerLines = mime.split("\r\n\r\n")[0]?.split("\r\n") ?? [];
    assert.ok(!headerLines.some((l) => /^bcc:/i.test(l)), "no hay línea Bcc");
    assert.ok(!headerLines.some((l) => /^x-evil:/i.test(l)));
    assert.equal(headerLines.filter((l) => /^subject:/i.test(l)).length, 1);
    assert.ok(!headerLines.some((l) => /^in-reply-to:/i.test(l)), "un Message-ID con basura se descarta entero");
    const refs = headerLines.find((l) => /^references:/i.test(l)) ?? "";
    assert.ok(refs.includes("<a@b.c>") && refs.includes("<d@e.f>") && !/evil/.test(refs));
  });

  it("direcciones inválidas hacen fallar el armado (no se envía a medias)", () => {
    assert.throws(() => buildMime({ ...base, to: [{ name: "", email: "monica@tdv.com\r\nBcc: evil@x.com" }] }), /inválida/);
    assert.throws(() => buildMime({ ...base, to: [{ name: "", email: "no-es-correo" }] }), /inválida/);
    assert.throws(() => buildMime({ ...base, cc: [{ name: "", email: "x" }] }), /inválida/);
  });

  it("incluye Cc y Bcc cuando existen (borradores con copias)", () => {
    const { headers } = parseMime(buildMime({ ...base, cc: [{ name: "", email: "c@x.com" }], bcc: [{ name: "", email: "b@x.com" }] }));
    assert.equal(headers["cc"], "c@x.com");
    assert.equal(headers["bcc"], "b@x.com");
  });

  it("un Message-ID largo en References se recorta por el principio", () => {
    const ids = Array.from({ length: 80 }, (_, i) => `<id${String(i).padStart(3, "0")}-${"x".repeat(20)}@mail.example.com>`);
    const refs = parseMime(buildMime({ ...base, references: ids.join(" ") })).headers["references"] as string;
    assert.ok(refs.length <= 900);
    assert.ok(refs.endsWith(ids[79] as string));
    assert.ok(!refs.includes(ids[0] as string));
  });
});

describe("snippet, cuerpo y alarmas", () => {
  it("decodeEntities", () => {
    assert.equal(decodeEntities("Tom &amp; Jerry &#39;hola&#39; &quot;x&quot; &lt;b&gt; &#x41; &nbsp;fin"), "Tom & Jerry 'hola' \"x\" <b> A  fin");
    assert.equal(decodeEntities("&iquest;Qu&eacute; tal?"), "¿Qué tal?");
    assert.equal(decodeEntities("&desconocida; &#99999999999;"), "&desconocida; &#99999999999;");
  });

  it("textFromPayload prefiere text/plain y cae a HTML", () => {
    const plain: GMessage["payload"] = {
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "text/plain", headers: [{ name: "Content-Type", value: 'text/plain; charset="UTF-8"' }], body: { data: b64u("Hola Mónica\nTexto plano") } },
        { mimeType: "text/html", body: { data: b64u("<p>Hola <b>Mónica</b></p>") } },
      ],
    };
    assert.equal(textFromPayload(plain), "Hola Mónica\nTexto plano");
    const html: GMessage["payload"] = { mimeType: "text/html", body: { data: b64u("<style>p{}</style><p>Hola&nbsp;<b>Mónica</b></p><p>Adiós</p>") } };
    assert.equal(textFromPayload(html), "Hola Mónica\nAdiós");
    assert.equal(textFromPayload(undefined), "");
    assert.equal(htmlToText("a<br>b<script>x()</script>c"), "a\nbc");
  });

  it("isAlarm: dinero y seguridad sí; correo normal no", () => {
    assert.ok(isAlarm("BCP — Cargo no reconocido", "S/ 249.00"));
    assert.ok(isAlarm("Alerta de seguridad", ""));
    assert.ok(isAlarm("Inicio de sesión sospechoso en tu cuenta", ""));
    assert.ok(isAlarm("Tu cuenta fue bloqueada", "cuenta bloqueada por seguridad"));
    assert.ok(isAlarm("Security alert", "new sign-in"));
    assert.ok(!isAlarm("Mónica (TDV) — Informe 03", "Pide cifras al cierre de septiembre"));
    assert.ok(!isAlarm("Cómo evitar el fraude en tu negocio", "newsletter"));
    assert.ok(!isAlarm("SMV — respuesta a consulta", "adjunto PDF"));
  });
});

const header = (name: string, value: string) => ({ name, value });
const msg = (over: Partial<GMessage> & { from: string; subject?: string; id?: string; extra?: { name: string; value: string }[] }): GMessage => ({
  id: over.id ?? "m1",
  threadId: over.threadId ?? "t1",
  labelIds: over.labelIds ?? ["INBOX", "UNREAD", "IMPORTANT"],
  snippet: over.snippet ?? "Pide cifras al cierre de septiembre",
  internalDate: over.internalDate ?? String(Date.UTC(2026, 9, 5, 13, 0, 0)),
  payload: { headers: [header("From", over.from), header("Subject", over.subject ?? "Informe 03"), ...(over.extra ?? [])] },
});

describe("mapMessage", () => {
  it("normaliza remitente, asunto, snippet, fecha y banderas", () => {
    const item = mapMessage(msg({ from: "=?UTF-8?B?TcOzbmljYQ==?= <monica@tdv.com>", subject: "=?UTF-8?Q?Informaci=C3=B3n_03?=", snippet: "Pide cifras &amp; m&aacute;s" }));
    assert.deepEqual(item, {
      id: "m1", thread_id: "t1", from_name: "Mónica", from_email: "monica@tdv.com", subject: "Información 03",
      snippet: "Pide cifras & más", received_at: "2026-10-05T13:00:00.000Z", unread: true, important: true, alarm: false,
    });
  });

  it("marca la alarma y respeta no leído / no importante", () => {
    const item = mapMessage(msg({ from: "BCP <alertas@bcp.com.pe>", subject: "Cargo no reconocido", labelIds: ["INBOX"] })) as MailItem;
    assert.equal(item.alarm, true);
    assert.equal(item.unread, false);
    assert.equal(item.important, false);
  });

  it("sin id/threadId devuelve null; sin asunto pone (sin asunto)", () => {
    assert.equal(mapMessage({}), null);
    const item = mapMessage({ id: "a", threadId: "b", payload: { headers: [] } }) as MailItem;
    assert.equal(item.subject, "(sin asunto)");
  });
});

describe("responder en el hilo", () => {
  const ME = "david@sayainvestments.co";
  const thread = {
    id: "t1",
    messages: [
      msg({ id: "m1", from: "Mónica <monica@tdv.com>", subject: "Informe 03", internalDate: "1000", extra: [header("Message-ID", "<m1@mail.gmail.com>")] }),
      msg({ id: "m2", from: `David <${ME}>`, subject: "Re: Informe 03", internalDate: "2000", labelIds: ["SENT"], extra: [header("To", "Mónica <monica@tdv.com>"), header("Message-ID", "<m2@mail.gmail.com>"), header("References", "<m1@mail.gmail.com>")] }),
      msg({ id: "m3", from: "Mónica <monica@tdv.com>", subject: "Re: Informe 03", internalDate: "3000", extra: [header("Message-ID", "<m3@mail.gmail.com>"), header("References", "<m1@mail.gmail.com> <m2@mail.gmail.com>"), header("Reply-To", "Mónica TDV <respuestas@tdv.com>")] }),
    ],
  };

  it("responde al remitente (From) por defecto, con In-Reply-To y References", () => {
    const t = replyTarget(thread, ME);
    assert.deepEqual(t, {
      message_id: "m3", thread_id: "t1",
      to: [{ name: "Mónica", email: "monica@tdv.com" }],
      subject: "Re: Informe 03",
      in_reply_to: "<m3@mail.gmail.com>",
      references: "<m1@mail.gmail.com> <m2@mail.gmail.com> <m3@mail.gmail.com>",
      reply_to_differs: false,
      reply_to_email: "respuestas@tdv.com",
    });
  });

  it("con useReplyTo usa Reply-To; avisa si su dominio difiere del de From", () => {
    const t = replyTarget(thread, ME, undefined, true);
    assert.deepEqual(t?.to, [{ name: "Mónica TDV", email: "respuestas@tdv.com" }]);
    assert.equal(t?.reply_to_differs, false); // mismo dominio tdv.com
    const raro = { id: "t", messages: [msg({ id: "x", from: "A <a@banco.com>", extra: [header("Reply-To", "evil@otro.net"), header("Message-ID", "<x@b.c>")] })] };
    const r = replyTarget(raro, ME, undefined, true);
    assert.deepEqual([r?.to[0]?.email, r?.reply_to_differs], ["evil@otro.net", true]);
    assert.equal(replyTarget(raro, ME)?.to[0]?.email, "a@banco.com");
  });

  it("puede apuntar a un mensaje concreto (y sin Reply-To usa From)", () => {
    const t = replyTarget(thread, ME, "m1");
    assert.equal(t?.message_id, "m1");
    assert.deepEqual(t?.to, [{ name: "Mónica", email: "monica@tdv.com" }]);
    assert.equal(t?.references, "<m1@mail.gmail.com>");
  });

  it("si el último es tuyo, responde a sus destinatarios (sin ti)", () => {
    const t = replyTarget(thread, ME, "m2");
    assert.deepEqual(t?.to, [{ name: "Mónica", email: "monica@tdv.com" }]);
  });

  it("nunca se responde a uno mismo ni a un hilo vacío", () => {
    const soloMio = { id: "t", messages: [msg({ id: "x", from: `David <${ME}>`, labelIds: ["SENT"], extra: [header("To", ME)] })] };
    assert.equal(replyTarget(soloMio, ME), null);
    assert.equal(replyTarget({ id: "t", messages: [] }, ME), null);
    assert.equal(replyTarget(thread, ME, "no-existe"), null);
  });

  it("un Message-ID sospechoso no entra a In-Reply-To", () => {
    const t = replyTarget({ id: "t", messages: [msg({ id: "z", from: "a@b.co", extra: [header("Message-ID", "sin-corchetes")] })] }, ME);
    assert.equal(t?.in_reply_to, "");
  });
});

describe("borradores", () => {
  const draft: GDraft = {
    id: "r-1",
    message: {
      id: "m10", threadId: "t1", snippet: "Hola Mónica", internalDate: String(Date.UTC(2026, 9, 5, 14, 0, 0)),
      payload: {
        mimeType: "text/plain",
        headers: [
          header("To", "Mónica <monica@tdv.com>"), header("Cc", "c@x.com"), header("Bcc", "b@x.com"), header("Subject", "Re: Informe 03"),
          header("In-Reply-To", "<m3@mail.gmail.com>"), header("References", "<m1@mail.gmail.com> <m3@mail.gmail.com>"),
        ],
        body: { data: b64u("Hola Mónica, texto original") },
      },
    },
  };

  it("mapDraft resume el borrador para la UI", () => {
    assert.deepEqual(mapDraft(draft), {
      draft_id: "r-1", message_id: "m10", thread_id: "t1", to: "Mónica", to_email: "monica@tdv.com", cc: "c@x.com", bcc: "b@x.com", subject: "Re: Informe 03",
      body: "Hola Mónica, texto original", snippet: "Hola Mónica", updated_at: "2026-10-05T14:00:00.000Z", editable: true,
    });
    assert.equal(mapDraft({ id: "x" }), null);
  });

  it("rebuildDraft conserva destinatarios, copias, asunto e hilo y cambia solo el cuerpo", () => {
    const { raw, threadId } = rebuildDraft(draft, "Texto nuevo ñ");
    assert.equal(threadId, "t1");
    const { headers, bodyText } = parseMime(base64UrlToUtf8(raw) as string);
    assert.deepEqual(parseAddress(headers["to"] as string), { name: "Mónica", email: "monica@tdv.com" });
    assert.equal(headers["cc"], "c@x.com");
    assert.equal(headers["bcc"], "b@x.com");
    assert.equal(headers["subject"], "Re: Informe 03");
    assert.equal(headers["in-reply-to"], "<m3@mail.gmail.com>");
    assert.equal(headers["references"], "<m1@mail.gmail.com> <m3@mail.gmail.com>");
    assert.equal(bodyText, "Texto nuevo ñ");
  });

  it("rebuildDraft falla si una dirección no se puede leer (no la pierde en silencio)", () => {
    const raro: GDraft = { id: "r", message: { id: "m", threadId: "t", payload: { headers: [header("To", "Mónica <monica@tdv.com>, esto-no-es-correo"), header("Subject", "x")], body: { data: b64u("x") } } } };
    assert.throws(() => rebuildDraft(raro, "nuevo"), /No pude leer una dirección/);
  });

  it("un borrador con adjuntos no es editable (reescribirlo los perdería)", () => {
    const withFile: GDraft = {
      id: "r-2",
      message: { id: "m11", threadId: "t2", payload: { mimeType: "multipart/mixed", headers: [], parts: [
        { mimeType: "text/plain", body: { data: b64u("hola") } },
        { mimeType: "application/pdf", filename: "informe.pdf", body: { attachmentId: "ANGj", size: 1234 } },
      ] } },
    };
    assert.equal(mapDraft(withFile)?.editable, false);
  });
});

describe("matchMail", () => {
  const item = (id: string, from_name: string, from_email: string, subject: string): MailItem => ({
    id, thread_id: `t-${id}`, from_name, from_email, subject, snippet: "", received_at: "", unread: false, important: false, alarm: false,
  });
  const pool = [
    item("1", "Mónica Pérez", "monica@tdv.com", "Informe 03"),
    item("2", "BCP", "alertas@bcp.com.pe", "Cargo no reconocido"),
    item("3", "SMV", "no-reply@smv.gob.pe", "Respuesta a consulta"),
    item("4", "Mónica Rojas", "mrojas@otro.com", "Cotización"),
  ];

  it("encuentra por remitente sin importar tildes ni mayúsculas", () => {
    assert.deepEqual(matchMail(pool, "BCP").map((m) => m.id), ["2"]);
    assert.deepEqual(matchMail(pool, "monica tdv").map((m) => m.id), ["1"]); // gana el que más palabras cumple
    assert.deepEqual(matchMail(pool, "el correo de la SMV").map((m) => m.id), ["3"]);
  });

  it("si empatan devuelve todos para que David elija; si no hay nada, vacío", () => {
    assert.deepEqual(matchMail(pool, "Mónica").map((m) => m.id), ["1", "4"]);
    assert.deepEqual(matchMail(pool, "zzz"), []);
    assert.deepEqual(matchMail(pool, "el de la"), []); // solo palabras vacías
  });
});
