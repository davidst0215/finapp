// node --experimental-strip-types --test supabase/functions/_shared/google/speech.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mapEvent, type CalEvent, type RawEvent } from "./events.ts";
import type { MailItem } from "./mail.ts";
import { diaHablado, horaHablada, remitenteCorto, resumenAgenda, resumenCorreo, vozAgenda, vozCorreo } from "./speech.ts";

const LUNES_8AM = new Date("2026-10-05T13:00:00Z"); // lunes 5 de octubre de 2026, 08:00 en Lima

const ev = (id: string, summary: string, from: string, to: string, extra: Partial<RawEvent> = {}) =>
  mapEvent({ id, summary, start: { dateTime: `2026-10-05T${from}:00-05:00` }, end: { dateTime: `2026-10-05T${to}:00-05:00` }, ...extra }) as CalEvent;

describe("hora hablada", () => {
  const casos: [string, string][] = [
    ["09:00", "las nueve de la mañana"], ["11:30", "las once y media de la mañana"], ["15:00", "las tres de la tarde"],
    ["13:00", "la una de la tarde"], ["13:15", "la una y cuarto de la tarde"], ["12:00", "las doce del día"], ["12:30", "las doce y media del día"],
    ["00:00", "las doce de la noche"], ["00:10", "las doce y diez de la noche"], ["03:30", "las tres y media de la madrugada"],
    ["01:00", "la una de la madrugada"], ["19:00", "las siete de la noche"], ["20:45", "las ocho y cuarenta y cinco de la noche"],
    ["18:59", "las seis y cincuenta y nueve de la tarde"], ["06:00", "las seis de la mañana"], ["16:21", "las cuatro y veintiuno de la tarde"],
  ];
  for (const [hm, esperado] of casos) it(`${hm} → ${esperado}`, () => assert.equal(horaHablada(hm), esperado));
});

describe("día hablado", () => {
  const hoy = "2026-10-05";
  it("hoy, mañana, pasado mañana, ayer y fechas", () => {
    assert.equal(diaHablado("2026-10-05", hoy), "hoy");
    assert.equal(diaHablado("2026-10-06", hoy), "mañana");
    assert.equal(diaHablado("2026-10-07", hoy), "pasado mañana");
    assert.equal(diaHablado("2026-10-04", hoy), "ayer");
    assert.equal(diaHablado("2026-10-09", hoy), "el viernes 9 de octubre");
    assert.equal(diaHablado("2026-11-01", hoy), "el domingo primero de noviembre");
    assert.equal(diaHablado("2027-01-15", hoy), "el viernes 15 de enero de 2027");
  });
});

describe("resumen de la agenda", () => {
  const maqui = ev("1", "Maqui CO — mensual", "09:00", "10:00");
  const tdv = ev("2", "TDV — Early Warning", "11:30", "12:30");
  const nova = ev("3", "Novafondos — consola", "15:00", "16:00");

  it("lista lo que viene, con horas habladas", () => {
    assert.equal(
      resumenAgenda([maqui, tdv, nova], "2026-10-05", LUNES_8AM),
      "Te quedan 3 eventos hoy: a las nueve de la mañana, Maqui CO — mensual; a las once y media de la mañana, TDV — Early Warning; a las tres de la tarde, Novafondos — consola.",
    );
  });

  it("hoy solo cuenta lo que no terminó (uno en curso todavía cuenta)", () => {
    const mediodia = new Date("2026-10-05T17:00:00Z"); // 12:00 en Lima: TDV (11:30–12:30) sigue en curso
    assert.equal(
      resumenAgenda([maqui, tdv, nova], "2026-10-05", mediodia),
      "Te quedan 2 eventos hoy: a las once y media de la mañana, TDV — Early Warning; a las tres de la tarde, Novafondos — consola.",
    );
    const tarde = new Date("2026-10-05T18:00:00Z"); // 13:00 en Lima
    assert.equal(resumenAgenda([maqui, tdv, nova], "2026-10-05", tarde), "Te queda 1 evento hoy: a las tres de la tarde, Novafondos — consola.");
    const noche = new Date("2026-10-06T00:00:00Z"); // 19:00 en Lima
    assert.equal(resumenAgenda([maqui, tdv, nova], "2026-10-05", noche), "Ya no te quedan eventos hoy.");
  });

  it("otros días: nombre del día y cuántos", () => {
    const e = { ...ev("4", "Cobranzas Maqui", "10:00", "11:00"), day_key: "2026-10-06", end_day_key: "2026-10-06" };
    assert.equal(resumenAgenda([e], "2026-10-06", LUNES_8AM), "Mañana tienes 1 evento: a las diez de la mañana, Cobranzas Maqui.");
  });

  it("vacío, declinados y límite de 4 + 'y N más'", () => {
    assert.equal(resumenAgenda([], "2026-10-05", LUNES_8AM), "No tienes nada en la agenda hoy.");
    assert.equal(resumenAgenda([], "2026-10-06", LUNES_8AM), "No tienes nada en la agenda mañana.");
    const declinado = ev("5", "Webinar", "14:00", "15:00", { attendees: [{ self: true, responseStatus: "declined" }] });
    assert.equal(resumenAgenda([declinado], "2026-10-05", LUNES_8AM), "No tienes nada en la agenda hoy.");
    const seis = Array.from({ length: 6 }, (_, i) => ev(`x${i}`, `Evento ${i}`, `${String(9 + i).padStart(2, "0")}:00`, `${String(9 + i).padStart(2, "0")}:30`));
    const texto = resumenAgenda(seis, "2026-10-05", LUNES_8AM);
    assert.match(texto, /^Te quedan 6 eventos hoy: /);
    assert.match(texto, /; y 2 más\.$/);
    assert.ok(!texto.includes("Evento 4"));
  });

  it("los de todo el día van primero", () => {
    const dia = ev("6", "Feriado", "00:00", "00:00");
    const todoElDia = { ...dia, all_day: true, start_hm: "", end_hm: "" };
    assert.match(resumenAgenda([tdv, todoElDia], "2026-10-05", LUNES_8AM), /^Te quedan 2 eventos hoy: todo el día, Feriado; a las once y media/);
  });
});

describe("resumen del correo", () => {
  const mail = (over: Partial<MailItem>): MailItem => ({
    id: "1", thread_id: "t", from_name: "", from_email: "x@y.co", subject: "Asunto", snippet: "", received_at: "", unread: true, important: true, alarm: false, ...over,
  });

  it("sin correos", () => assert.equal(resumenCorreo([]), "No tienes correos importantes recientes."));

  it("cuenta, no leídos y los primeros", () => {
    const items = [mail({ id: "1", from_name: "Mónica Pérez", from_email: "m@tdv.com", subject: "Informe 03" }), mail({ id: "2", from_name: "SMV", subject: "Respuesta a consulta", unread: false })];
    assert.equal(resumenCorreo(items), "Tienes 2 correos importantes, 1 sin leer. Mónica: Informe 03; SMV: Respuesta a consulta.");
  });

  it("una alarma va primero y con 'Ojo'", () => {
    const items = [
      mail({ id: "1", from_name: "Mónica", subject: "Informe 03" }),
      mail({ id: "2", from_name: "BCP", subject: "Cargo no reconocido", alarm: true }),
    ];
    assert.equal(resumenCorreo(items), "Tienes 2 correos importantes, 2 sin leer. Ojo: BCP avisa «Cargo no reconocido». Mónica: Informe 03.");
    assert.equal(resumenCorreo([mail({})]).startsWith("Tienes 1 correo importante, 1 sin leer."), true);
  });

  it("remitente corto: nombre de pila o usuario del correo", () => {
    assert.equal(remitenteCorto({ from_name: "Mónica Pérez", from_email: "m@x.co" }), "Mónica");
    assert.equal(remitenteCorto({ from_name: "", from_email: "alertas@bcp.com.pe" }), "alertas");
  });
});

describe("lo que se dice de la agenda y el correo (la pantalla conserva el detalle)", () => {
  const seis = Array.from({ length: 5 }, (_, i) =>
    ev(`v${i}`, i === 0 ? "Daily de Maqui Colombia" : `Evento ${i}`, `${String(9 + i).padStart(2, "0")}:00`, `${String(9 + i).padStart(2, "0")}:30`));

  it("agenda: el primer evento y «y N más»", () => {
    assert.equal(vozAgenda(seis, "2026-10-05", LUNES_8AM), "Te quedan 5 eventos hoy: a las nueve de la mañana, Daily de Maqui Colombia; y 4 más.");
    assert.match(resumenAgenda(seis, "2026-10-05", LUNES_8AM), /Evento 3; y 1 más\.$/); // la pantalla sigue con 4
    const otroDia = seis.map((e) => ({ ...e, day_key: "2026-10-06", end_day_key: "2026-10-06" }));
    assert.equal(vozAgenda(otroDia.slice(0, 1), "2026-10-06", LUNES_8AM), "Mañana tienes 1 evento: a las nueve de la mañana, Daily de Maqui Colombia.");
  });

  it("agenda: vacía, y título largo cortado en palabra", () => {
    assert.equal(vozAgenda([], "2026-10-06", LUNES_8AM), "No tienes nada en la agenda mañana.");
    const largo = { ...ev("9", "Revisión trimestral de resultados con el comité de dirección y los socios", "09:00", "10:00") };
    const v = vozAgenda([largo], "2026-10-05", LUNES_8AM);
    assert.equal(v, "Te queda 1 evento hoy: a las nueve de la mañana, Revisión trimestral.");
    assert.ok(v.length <= 100);
  });

  it("correo: cuántos y lo más urgente (la alarma, o el primero)", () => {
    const mail = (over: Partial<MailItem>): MailItem => ({
      id: "1", thread_id: "t", from_name: "", from_email: "x@y.co", subject: "Asunto", snippet: "", received_at: "", unread: true, important: true, alarm: false, ...over,
    });
    const items = [
      mail({ id: "1", from_name: "Mónica Pérez", subject: "Informe 03 de costos listo para revisión" }),
      mail({ id: "2", from_name: "BCP", subject: "Cargo no reconocido en tu tarjeta de crédito", alarm: true }),
    ];
    assert.equal(vozCorreo(items), "Tienes 2 correos importantes, 2 sin leer. Ojo: BCP avisa «Cargo no reconocido».");
    assert.equal(vozCorreo([items[0]!]), "Tienes 1 correo importante, 1 sin leer; el primero, de Mónica: Informe 03 de costos listo.");
    assert.equal(vozCorreo([]), "No tienes correos importantes recientes.");
    assert.ok(resumenCorreo(items).length > vozCorreo(items).length);
  });
});
