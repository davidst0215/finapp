// node --experimental-strip-types --test apps/web/tests/google/agendaModel.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { defaultStart, durationMinutes, eventMeta, eventsOnDay, guestSummary, timelineRows } from '../../src/components/agenda/agendaModel.ts';
import type { CalEvent } from '../../src/components/google/types.ts';

const ev = (id: string, start_hm: string, end_hm: string, over: Partial<CalEvent> = {}): CalEvent => ({
  id, title: `Evento ${id}`, all_day: false,
  start: `2026-10-05T${start_hm}:00-05:00`, end: `2026-10-05T${end_hm}:00-05:00`,
  day_key: '2026-10-05', end_day_key: '2026-10-05', start_hm, end_hm,
  location: '', meet_url: '', guests: 0, guest_names: [], my_response: '', busy: true, kind: 'default', link: '', ...over,
});
const allDay = (id: string, from: string, to: string): CalEvent =>
  ev(id, '', '', { all_day: true, start: from, end: to, day_key: from, end_day_key: to, start_hm: '', end_hm: '' });

const kinds = (rows: ReturnType<typeof timelineRows>) => rows.map((r) => (r.kind === 'now' ? 'NOW' : r.event.id));

describe('eventos de un día', () => {
  it('filtra por día, deja primero los de todo el día y ordena por hora', () => {
    const events = [ev('b', '11:30', '12:00'), ev('a', '09:00', '10:00'), allDay('d', '2026-10-05', '2026-10-05'), ev('otro', '09:00', '10:00', { day_key: '2026-10-06', end_day_key: '2026-10-06' })];
    assert.deepEqual(eventsOnDay(events, '2026-10-05').map((e) => e.id), ['d', 'a', 'b']);
    assert.deepEqual(eventsOnDay(events, '2026-10-06').map((e) => e.id), ['otro']);
    assert.deepEqual(eventsOnDay(events, '2026-10-07'), []);
  });

  it('un evento de todo el día de varios días aparece en cada uno', () => {
    const viaje = allDay('viaje', '2026-10-05', '2026-10-07');
    for (const key of ['2026-10-05', '2026-10-06', '2026-10-07']) assert.equal(eventsOnDay([viaje], key).length, 1, key);
    assert.equal(eventsOnDay([viaje], '2026-10-08').length, 0);
  });
});

describe('línea de tiempo con "ahora"', () => {
  const dia = [ev('a', '09:00', '10:00'), ev('b', '11:30', '12:30'), ev('c', '15:00', '16:00')];

  it('la marca va entre lo que ya empezó y lo que falta', () => {
    assert.deepEqual(kinds(timelineRows(dia, '2026-10-05', '2026-10-05', '08:42')), ['NOW', 'a', 'b', 'c']);
    assert.deepEqual(kinds(timelineRows(dia, '2026-10-05', '2026-10-05', '09:30')), ['a', 'NOW', 'b', 'c']);
    assert.deepEqual(kinds(timelineRows(dia, '2026-10-05', '2026-10-05', '13:00')), ['a', 'b', 'NOW', 'c']);
    assert.deepEqual(kinds(timelineRows(dia, '2026-10-05', '2026-10-05', '18:00')), ['a', 'b', 'c', 'NOW']);
  });

  it('un evento que empieza justo ahora cuenta como empezado', () => {
    assert.deepEqual(kinds(timelineRows(dia, '2026-10-05', '2026-10-05', '09:00')), ['a', 'NOW', 'b', 'c']);
  });

  it('solo se marca en hoy', () => {
    assert.deepEqual(kinds(timelineRows(dia, '2026-10-05', '2026-10-06', '08:42')), ['a', 'b', 'c']);
    assert.deepEqual(kinds(timelineRows([], '2026-10-05', '2026-10-05', '08:42')), []);
  });

  it('los de todo el día quedan arriba y no cuentan para colocar la marca', () => {
    assert.deepEqual(kinds(timelineRows([allDay('d', '2026-10-05', '2026-10-05'), ...dia], '2026-10-05', '2026-10-05', '08:42')), ['d', 'NOW', 'a', 'b', 'c']);
    // solo de todo el día: sin marca (no hay nada con hora)
    assert.deepEqual(kinds(timelineRows([allDay('d', '2026-10-05', '2026-10-05')], '2026-10-05', '2026-10-05', '08:42')), ['d']);
  });
});

describe('textos de la fila', () => {
  it('invitados', () => {
    assert.equal(guestSummary({ guests: 2, guest_names: ['Mónica', 'Juanjo'] }), 'Mónica, Juanjo');
    assert.equal(guestSummary({ guests: 5, guest_names: ['Mónica', 'Juanjo', 'Ana', 'Luis'] }), 'Mónica, Juanjo y 3 más');
    assert.equal(guestSummary({ guests: 1, guest_names: [] }), '1 invitado');
    assert.equal(guestSummary({ guests: 3, guest_names: [] }), '3 invitados');
  });

  it('segunda línea: estado, Meet, lugar e invitados', () => {
    assert.equal(eventMeta(ev('a', '09:00', '10:00')), '');
    assert.equal(eventMeta(ev('a', '09:00', '10:00', { meet_url: 'https://meet.google.com/x', guests: 2, guest_names: ['Mónica', 'Juanjo'] })), 'Meet · Mónica, Juanjo');
    assert.equal(eventMeta(ev('a', '09:00', '10:00', { location: 'Oficina', my_response: 'declined' })), 'Declinado · Oficina');
    assert.equal(eventMeta(ev('a', '09:00', '10:00', { kind: 'focusTime' })), 'Concentración');
  });

  it('duración en minutos', () => {
    assert.equal(durationMinutes(ev('a', '09:00', '10:30')), 90);
    assert.equal(durationMinutes({ start: '2026-10-05', end: '2026-10-06' }), 1440);
    assert.equal(durationMinutes({ start: 'x', end: 'y' }), 0);
    assert.equal(durationMinutes({ start: '2026-10-05T10:00:00-05:00', end: '2026-10-05T09:00:00-05:00' }), 0);
  });

  it('hora por defecto de un evento nuevo', () => {
    assert.equal(defaultStart('2026-10-06', '2026-10-05', '08:42'), '09:00');
    assert.equal(defaultStart('2026-10-05', '2026-10-05', '08:42'), '09:00');
    assert.equal(defaultStart('2026-10-05', '2026-10-05', '09:00'), '09:30');
    assert.equal(defaultStart('2026-10-05', '2026-10-05', '09:30'), '10:00');
    assert.equal(defaultStart('2026-10-05', '2026-10-05', '23:50'), '23:30');
  });
});
