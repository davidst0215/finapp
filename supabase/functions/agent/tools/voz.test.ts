// node --experimental-strip-types --test supabase/functions/agent/tools/voz.test.ts
// Largos de lo que se ve (`message`) y de lo que se dice (`voz`) con respuestas realistas. ElevenLabs cobra por carácter:
// lo que se envía nunca pasa de 100 y, en las listas, la voz es una fracción de la pantalla.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mapEvent } from "../../_shared/google/events.ts";
import type { MailItem } from "../../_shared/google/mail.ts";
import { resumenAgenda, resumenCorreo, vozAgenda, vozCorreo } from "../../_shared/google/speech.ts";
import { mensajeVoz, mensajeVozCorto, type Saldo } from "../../_shared/saldo.ts";
import { mensajeMemoria, vozMemoria } from "../../_shared/vault/search.ts";
import { prepararVoz, VOZ_MAX } from "../../_shared/voz.ts";
import { PERSONA } from "../prompt.ts";
import { loQueSeDice } from "../respuesta.ts";
import { resumenRecurrentes, type Recurrente, vozRecurrentes } from "./recurrentes.ts";

const AQUI = dirname(fileURLToPath(import.meta.url));
const LUNES_8AM = new Date("2026-10-05T13:00:00Z");

const ev = (id: string, summary: string, from: string, to: string) =>
  mapEvent({ id, summary, start: { dateTime: `2026-10-06T${from}:00-05:00` }, end: { dateTime: `2026-10-06T${to}:00-05:00` } })!;
const eventos = [
  ev("1", "Daily de Maqui Colombia", "09:00", "09:30"),
  ev("2", "Comité de cobranzas con Marco", "11:00", "12:00"),
  ev("3", "Revisión Early Warning TDV", "14:00", "15:00"),
  ev("4", "Llamada con el contador", "16:00", "16:30"),
  ev("5", "Gimnasio", "19:00", "20:00"),
];

const mail = (o: Partial<MailItem>): MailItem => ({
  id: "1", thread_id: "t", from_name: "", from_email: "x@y.co", subject: "Asunto", snippet: "", received_at: "", unread: true, important: true, alarm: false, ...o,
});
const correos = [
  mail({ id: "1", from_name: "Mónica Pérez", subject: "Informe 03 de costos listo para revisión" }),
  mail({ id: "2", from_name: "SMV", subject: "Respuesta a consulta de fondos colectivos", unread: false }),
  mail({ id: "3", from_name: "BCP", subject: "Cargo no reconocido en tu tarjeta", alarm: true }),
  mail({ id: "4", from_name: "Daniel Rojas", subject: "Precios del cotizador" }),
  mail({ id: "5", from_name: "Vercel", subject: "Deploy fallido en finapp" }),
];

const r = (id: string, description: string, amount: number, next_due_date: string): Recurrente =>
  ({ recurring_id: id, description, amount, frequency: "monthly", next_due_date });
const pagos = [
  r("1", "Netflix", 45.9, "2026-10-15"), r("2", "Spotify", 26, "2026-10-03"), r("3", "Luz del Sur", 118.45, "2026-10-20"),
  r("4", "Internet", 99, "2026-10-25"), r("5", "Gimnasio", 150, "2026-10-28"), r("6", "iCloud", 12.9, "2026-10-30"),
];

const saldo: Saldo = {
  openrouter: {
    estado: "ok", restante: 9.73, credito: 20, hoy: 0.01, semana: 0.12, mes: 0.27,
    proyeccion: { tipo: "dias", dias: 270 }, alcance: "A este ritmo te alcanza para unos nueve meses", bajo: false,
  },
  elevenlabs: { estado: "ok", usados: 1200, limite: 10000, renueva: null, plan: "free" },
  actualizado: "2026-10-11T00:00:00Z",
};

const respuestaMemoria =
  "NovaFondos está en producción en Cloud Run con la consola de operaciones al día. Falta calibrar la matriz con bien junto con Maqui antes del lanzamiento.";

// Cada caso: lo que se ve, lo que se dice y el tope de lo que llega a ElevenLabs (convertido a palabras).
const CASOS: { nombre: string; msg: string; voz: string; esperado: string }[] = [
  {
    nombre: "agenda de mañana (5 eventos)",
    msg: resumenAgenda(eventos, "2026-10-06", LUNES_8AM),
    voz: vozAgenda(eventos, "2026-10-06", LUNES_8AM),
    esperado: "Mañana tienes 5 eventos: a las nueve de la mañana, Daily de Maqui Colombia; y 4 más.",
  },
  {
    nombre: "correos importantes (5, con una alarma)",
    msg: resumenCorreo(correos),
    voz: vozCorreo(correos),
    esperado: "Tienes 5 correos importantes, 4 sin leer. Ojo: BCP avisa «Cargo no reconocido».",
  },
  {
    nombre: "pagos pendientes (6)",
    msg: resumenRecurrentes(pagos, new Set(), "2026-10-05", "pending"),
    voz: vozRecurrentes(pagos, new Set(), "2026-10-05", "pending"),
    esperado: "Te faltan unos S/ 452: Spotify S/ 26, vencido; y 5 más.",
  },
  {
    nombre: "saldo de IA",
    msg: mensajeVoz(saldo),
    voz: mensajeVozCorto(saldo),
    esperado: "Te quedan unos US$ 10; alcanza para unos nueve meses.",
  },
  {
    nombre: "memoria (dos oraciones)",
    msg: mensajeMemoria(respuestaMemoria, "NovaFondos · EAFC"),
    voz: vozMemoria(respuestaMemoria),
    esperado: "NovaFondos está en producción en Cloud Run con la consola de operaciones al día.",
  },
];

describe("lo que se dice nunca pasa del tope y es mucho más corto que lo que se ve", () => {
  for (const c of CASOS) {
    it(c.nombre, () => {
      assert.equal(c.voz, c.esperado);
      const enviado = prepararVoz(loQueSeDice({ message: c.msg, voz: c.voz }), VOZ_MAX);
      assert.ok(enviado.length <= VOZ_MAX, `${enviado.length}: ${enviado}`);
      assert.ok(c.voz.length <= VOZ_MAX, `${c.voz.length}`);
      assert.ok(c.voz.length < c.msg.length, "la voz debe ser más corta que la pantalla");
    });
  }

  it("sin `voz`, lo que se ve también se recorta al tope en la oración que cabe (cliente y handlers viejos)", () => {
    const enviado = prepararVoz(loQueSeDice({ message: CASOS[0]!.msg }), VOZ_MAX);
    assert.ok(enviado.length <= VOZ_MAX && enviado.endsWith("."), enviado);
  });

  it("la tabla: largos de pantalla, voz y envío", () => {
    const largos = CASOS.map((c) => ({ caso: c.nombre, pantalla: c.msg.length, voz: c.voz.length, enviado: prepararVoz(c.voz).length }));
    // Referencia (si cambia una plantilla, este cuadro cambia a propósito): la voz es ≤ 100 y casi siempre < 90.
    assert.deepEqual(largos.map((l) => l.voz <= 90), [true, true, true, true, true]);
    assert.ok(largos.every((l) => l.enviado <= VOZ_MAX));
  });
});

describe("el prompt pide una sola frase corta y las reglas de cada módulo lo repiten", () => {
  it("PERSONA: una frase, 80 ideal, 100 máximo, sin relleno y cifras redondas", () => {
    assert.match(PERSONA, /UNA frase/);
    assert.match(PERSONA, /80 caracteres o menos, nunca más de 100/);
    assert.match(PERSONA, /Claro.*Listo,.*Perfecto.*Por supuesto/s);
    assert.match(PERSONA, /sin repetir la pregunta y sin despedidas/);
    assert.match(PERSONA, /Cifras redondas/);
    assert.doesNotMatch(PERSONA, /¿Te detallo\?/); // el detalle va en `detalle` (pantalla): no se ofrece algo que la voz no puede dar
    assert.match(PERSONA, /unos 35 caracteres/);
    assert.match(PERSONA, /60 caracteres escritos o menos/);
    assert.match(PERSONA, /campo detalle/);
    assert.doesNotMatch(PERSONA, /3-4 oraciones/);
    // Siguen: seguridad y formato de dinero.
    assert.match(PERSONA, /SEGURIDAD:/);
    assert.match(PERSONA, /Borrar, editar o transferir solo si David lo pide en su ÚLTIMO mensaje/);
    assert.match(PERSONA, /formato S\/ 45\.90/);
  });

  for (const modulo of ["agenda", "brief", "correo", "finanzas", "reuniones", "tareas", "memoria", "internet", "saldo"]) {
    it(`reglas de ${modulo}`, () => {
      const src = readFileSync(join(AQUI, `${modulo}.ts`), "utf8");
      const reglas = /const rules = `([\s\S]*?)`;/.exec(src)?.[1] ?? "";
      assert.ok(reglas.length > 0, "no encontré las reglas");
      assert.match(reglas, /una frase|se dice|titular/i, `${modulo}: falta la pauta de respuesta corta`);
    });
  }
});
