// node --experimental-strip-types --test supabase/functions/_shared/google/events.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { GoogleInputError } from "./errors.ts";
import {
  compareEvents, deterministicRequestId, findOverlaps, mapEvent, matchEvents, moveBody, normalizeMove, normalizeNewEvent, type CalEvent, type RawEvent,
} from "./events.ts";

const raw = (over: Partial<RawEvent> = {}): RawEvent => ({
  id: "ev1",
  summary: "Maqui CO — mensual",
  start: { dateTime: "2026-10-05T09:00:00-05:00", timeZone: "America/Lima" },
  end: { dateTime: "2026-10-05T10:00:00-05:00", timeZone: "America/Lima" },
  ...over,
});
const ev = (over: Partial<RawEvent> = {}) => mapEvent(raw(over)) as CalEvent;

describe("mapEvent", () => {
  it("evento con hora: horas de pared de Lima y día de inicio", () => {
    const e = ev({ location: " Oficina ", hangoutLink: "https://meet.google.com/abc-defg-hij", htmlLink: "https://calendar.google.com/x" });
    assert.equal(e.title, "Maqui CO — mensual");
    assert.deepEqual([e.all_day, e.day_key, e.end_day_key, e.start_hm, e.end_hm], [false, "2026-10-05", "2026-10-05", "09:00", "10:00"]);
    assert.equal(e.location, "Oficina");
    assert.equal(e.meet_url, "https://meet.google.com/abc-defg-hij");
    assert.equal(e.link, "https://calendar.google.com/x");
  });

  it("convierte a Lima aunque Google responda en UTC u otro desfase", () => {
    const e = ev({ start: { dateTime: "2026-10-05T14:00:00Z" }, end: { dateTime: "2026-10-05T15:30:00Z" } });
    assert.deepEqual([e.start_hm, e.end_hm, e.day_key], ["09:00", "10:30", "2026-10-05"]);
    const tarde = ev({ start: { dateTime: "2026-10-06T03:30:00Z" }, end: { dateTime: "2026-10-06T04:30:00Z" } }); // 22:30 del lunes en Lima
    assert.deepEqual([tarde.day_key, tarde.start_hm], ["2026-10-05", "22:30"]);
  });

  it("todo el día: end.date es exclusivo", () => {
    const uno = ev({ start: { date: "2026-10-05" }, end: { date: "2026-10-06" } });
    assert.deepEqual([uno.all_day, uno.day_key, uno.end_day_key, uno.start_hm], [true, "2026-10-05", "2026-10-05", ""]);
    const tres = ev({ start: { date: "2026-10-05" }, end: { date: "2026-10-08" } });
    assert.equal(tres.end_day_key, "2026-10-07");
  });

  it("invitados: no cuenta a David ni las salas; guarda hasta 4 nombres", () => {
    const e = ev({
      attendees: [
        { email: "david@sayainvestments.co", self: true, responseStatus: "accepted" },
        { email: "monica@tdv.com", displayName: "Mónica" },
        { email: "juanjo@tdv.com" },
        { email: "sala-3@resource.calendar.google.com", resource: true },
      ],
    });
    assert.equal(e.guests, 2);
    assert.deepEqual(e.guest_names, ["Mónica", "juanjo@tdv.com"]);
    assert.equal(e.my_response, "accepted");
    assert.equal(ev().guests, 0);
  });

  it("Meet desde conferenceData cuando no hay hangoutLink", () => {
    const e = ev({ conferenceData: { entryPoints: [{ entryPointType: "phone", uri: "tel:+1" }, { entryPointType: "video", uri: "https://meet.google.com/zzz" }] } });
    assert.equal(e.meet_url, "https://meet.google.com/zzz");
  });

  it("descarta cancelados, ubicación de trabajo, cumpleaños y eventos sin id o fechas", () => {
    assert.equal(mapEvent(raw({ status: "cancelled" })), null);
    assert.equal(mapEvent(raw({ eventType: "workingLocation" })), null);
    assert.equal(mapEvent(raw({ eventType: "birthday" })), null);
    assert.equal(mapEvent(raw({ id: undefined })), null);
    assert.equal(mapEvent(raw({ start: undefined })), null);
    assert.equal(mapEvent(raw({ start: { dateTime: "no-es-fecha" } })), null);
  });

  it("tipos que sí se muestran y título por defecto", () => {
    assert.equal(ev({ eventType: "outOfOffice" }).kind, "outOfOffice");
    assert.equal(ev({ eventType: "focusTime" }).kind, "focusTime");
    assert.equal(ev({ eventType: "default" }).kind, "default");
    assert.equal(ev({ summary: "  " }).title, "(sin título)");
  });

  it("compareEvents: todo el día primero, luego por hora", () => {
    const a = ev({ id: "a", start: { dateTime: "2026-10-05T11:30:00-05:00" }, end: { dateTime: "2026-10-05T12:00:00-05:00" } });
    const b = ev({ id: "b" });
    const c = ev({ id: "c", start: { date: "2026-10-05" }, end: { date: "2026-10-06" } });
    assert.deepEqual([a, b, c].sort(compareEvents).map((e) => e.id), ["c", "b", "a"]);
  });
});

describe("cruces y búsqueda", () => {
  const a = ev({ id: "a" }); // 09:00–10:00
  const ms = (iso: string) => Date.parse(iso);

  it("detecta cruces; lo que solo se toca en el borde no cruza", () => {
    assert.deepEqual(findOverlaps([a], ms("2026-10-05T09:30:00-05:00"), ms("2026-10-05T10:30:00-05:00")).map((e) => e.id), ["a"]);
    assert.deepEqual(findOverlaps([a], ms("2026-10-05T10:00:00-05:00"), ms("2026-10-05T11:00:00-05:00")), []);
    assert.deepEqual(findOverlaps([a], ms("2026-10-05T08:00:00-05:00"), ms("2026-10-05T09:00:00-05:00")), []);
    assert.equal(findOverlaps([a], ms("2026-10-05T08:59:00-05:00"), ms("2026-10-05T09:01:00-05:00")).length, 1);
  });

  it("ignora los declinados, los de todo el día y los marcados como libres", () => {
    const declinado = ev({ id: "d", attendees: [{ self: true, responseStatus: "declined" }] });
    const dia = ev({ id: "t", start: { date: "2026-10-05" }, end: { date: "2026-10-06" } });
    const libre = ev({ id: "l", transparency: "transparent" });
    assert.equal(libre.busy, false);
    assert.equal(a.busy, true);
    assert.deepEqual(findOverlaps([declinado, dia, libre], ms("2026-10-05T09:00:00-05:00"), ms("2026-10-05T10:00:00-05:00")), []);
  });

  it("matchEvents encuentra por palabras del título, sin tildes ni mayúsculas", () => {
    const tdv = ev({ id: "tdv", summary: "TDV — Early Warning" });
    const nova = ev({ id: "nova", summary: "Novafondos — consola" });
    const todo = ev({ id: "x", summary: "TDV feriado", start: { date: "2026-10-05" }, end: { date: "2026-10-06" } });
    assert.deepEqual(matchEvents([tdv, nova, todo], "la reunión de tdv").map((e) => e.id), ["tdv"]); // el de todo el día no se mueve
    assert.deepEqual(matchEvents([tdv, nova], "NOVAFONDOS").map((e) => e.id), ["nova"]);
    assert.deepEqual(matchEvents([tdv, nova], "early warning").map((e) => e.id), ["tdv"]);
    assert.deepEqual(matchEvents([tdv, nova], "dentista"), []);
  });
});

describe("normalizeNewEvent", () => {
  const ok = { title: "Reunión con Daniel", date: "2026-10-06", start_time: "16:00" };

  it("por defecto dura 60 min y arma las horas de Lima", () => {
    const n = normalizeNewEvent(ok);
    assert.deepEqual([n.title, n.date, n.start_hm, n.end_hm, n.end_date], ["Reunión con Daniel", "2026-10-06", "16:00", "17:00", "2026-10-06"]);
    assert.equal(n.start, "2026-10-06T16:00:00-05:00");
    assert.equal(n.end, "2026-10-06T17:00:00-05:00");
    assert.equal(n.event_id, undefined);
  });

  it("acepta duración, hora de fin, formatos de hora flexibles y cruza la medianoche", () => {
    assert.equal(normalizeNewEvent({ ...ok, duration_min: 90 }).end_hm, "17:30");
    assert.equal(normalizeNewEvent({ ...ok, end_time: "5pm" }).end, "2026-10-06T17:00:00-05:00");
    assert.equal(normalizeNewEvent({ ...ok, start_time: "4 pm" }).start_hm, "16:00");
    const noche = normalizeNewEvent({ ...ok, start_time: "23:30", duration_min: 90 });
    assert.deepEqual([noche.end_date, noche.end_hm], ["2026-10-07", "01:00"]);
  });

  it("limpia el título y los textos", () => {
    const n = normalizeNewEvent({ ...ok, title: "  Hola\r\n\tmundo \u0007 ", location: "Oficina\n2", description: "linea1\nlinea2\u0000" });
    assert.equal(n.title, "Hola mundo");
    assert.equal(n.location, "Oficina 2");
    assert.equal(n.description, "linea1\nlinea2");
    assert.equal(normalizeNewEvent({ ...ok, title: "x".repeat(500) }).title.length, 200);
  });

  it("request_id válido da un id idempotente (UUID sin guiones, base32hex válido)", () => {
    const n = normalizeNewEvent({ ...ok, request_id: "6F1C2D3E-4A5B-4C6D-8E7F-0A1B2C3D4E5F" });
    assert.equal(n.event_id, "6f1c2d3e4a5b4c6d8e7f0a1b2c3d4e5f");
    assert.match(n.event_id as string, /^[0-9a-v]{5,1024}$/);
    assert.equal(normalizeNewEvent({ ...ok, request_id: "no-uuid" }).event_id, undefined);
  });

  it("rechaza datos inválidos con un mensaje claro", () => {
    const falla = (extra: Record<string, unknown>, re: RegExp) =>
      assert.throws(() => normalizeNewEvent({ ...ok, ...extra }), (e: unknown) => e instanceof GoogleInputError && re.test(e.message));
    falla({ title: "   " }, /título/);
    falla({ date: "2026-02-31" }, /fecha/);
    falla({ date: undefined }, /fecha/);
    falla({ start_time: "25:00" }, /inicio/);
    falla({ end_time: "15:00" }, /después del inicio/);
    falla({ end_time: "16:00" }, /después del inicio/);
    falla({ end_time: "tarde" }, /fin/);
    falla({ duration_min: 2 }, /duración/);
    falla({ duration_min: 5000 }, /duración/);
    falla({ duration_min: "abc" }, /duración/);
  });

  it("jamás produce invitados: el resultado no tiene campo de asistentes", () => {
    const n = normalizeNewEvent({ ...ok, attendees: [{ email: "x@y.com" }], guests: ["x@y.com"] });
    assert.ok(!("attendees" in n) && !("guests" in n));
  });
});

describe("mover", () => {
  const current = ev({ id: "ev1" }); // 09:00–10:00 (60 min)

  it("normalizeMove valida id, fecha y hora; confirm_guests solo con true exacto", () => {
    const m = normalizeMove({ event_id: "ev1", date: "2026-10-06", start_time: "4pm", confirm_guests: "true" });
    assert.deepEqual(m, { event_id: "ev1", date: "2026-10-06", start_hm: "16:00", end_hm: undefined, confirm_guests: false });
    assert.equal(normalizeMove({ event_id: "ev1", date: "2026-10-06", start_time: "16:00", confirm_guests: true }).confirm_guests, true);
    for (const bad of [
      { event_id: "../../otro", date: "2026-10-06", start_time: "16:00" },
      { event_id: "a b", date: "2026-10-06", start_time: "16:00" },
      { event_id: "", date: "2026-10-06", start_time: "16:00" },
      { event_id: "ev1", date: "mañana", start_time: "16:00" },
      { event_id: "ev1", date: "2026-10-06", start_time: "nunca" },
      { event_id: "ev1", date: "2026-10-06", start_time: "16:00", end_time: "15:00" },
    ]) {
      assert.throws(() => normalizeMove(bad), GoogleInputError, JSON.stringify(bad));
    }
  });

  it("moveBody conserva la duración y manda zona horaria de Lima", () => {
    const b = moveBody(current, normalizeMove({ event_id: "ev1", date: "2026-10-06", start_time: "16:00" }));
    assert.deepEqual(b.start, { dateTime: "2026-10-06T16:00:00-05:00", timeZone: "America/Lima" });
    assert.deepEqual(b.end, { dateTime: "2026-10-06T17:00:00-05:00", timeZone: "America/Lima" });
  });

  it("moveBody respeta una hora de fin explícita y cruza la medianoche si hace falta", () => {
    const b = moveBody(current, normalizeMove({ event_id: "ev1", date: "2026-10-06", start_time: "16:00", end_time: "18:30" }));
    assert.equal(b.end.dateTime, "2026-10-06T18:30:00-05:00");
    const largo = ev({ end: { dateTime: "2026-10-05T11:30:00-05:00" } }); // 150 min
    const c = moveBody(largo, normalizeMove({ event_id: "ev1", date: "2026-10-06", start_time: "23:00" }));
    assert.equal(c.end.dateTime, "2026-10-07T01:30:00-05:00");
  });

  it("los eventos de todo el día no se mueven desde Wabid", () => {
    const dia = ev({ start: { date: "2026-10-05" }, end: { date: "2026-10-06" } });
    assert.throws(() => moveBody(dia, normalizeMove({ event_id: "ev1", date: "2026-10-06", start_time: "16:00" })), GoogleInputError);
  });
});

describe("id de envío determinista", () => {
  it("mismo pedido → mismo id con forma de UUID; otro pedido → otro id", async () => {
    const a = await deterministicRequestId("u1", "Reunión", "2026-10-06", "16:00", 60);
    assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.equal(a, await deterministicRequestId("u1", "Reunión", "2026-10-06", "16:00", 60));
    assert.notEqual(a, await deterministicRequestId("u1", "Reunión", "2026-10-06", "17:00", 60));
    assert.equal(normalizeNewEvent({ title: "x", date: "2026-10-06", start_time: "16:00", request_id: a }).event_id?.length, 32);
  });
});
