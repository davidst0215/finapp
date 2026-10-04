// node --experimental-strip-types --test supabase/functions/_shared/vault/fechas.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import {
  addDays, diffDays, etiquetaFecha, fechaCorta, fechaHablada, isIsoDate, limaToday, resolveDue, weekday,
} from "./fechas.ts";

const HOY = "2026-10-05"; // lunes

test("limaToday resta cinco horas al instante UTC", () => {
  assert.equal(limaToday(new Date("2026-10-05T03:30:00Z")), "2026-10-04"); // 22:30 del domingo en Lima
  assert.equal(limaToday(new Date("2026-10-05T05:00:00Z")), "2026-10-05"); // 00:00 en Lima
  assert.equal(limaToday(new Date("2026-12-31T23:59:00Z")), "2026-12-31");
});

test("isIsoDate valida el calendario real", () => {
  assert.equal(isIsoDate("2026-10-05"), true);
  assert.equal(isIsoDate("2028-02-29"), true);
  assert.equal(isIsoDate("2026-02-29"), false);
  assert.equal(isIsoDate("2026-02-30"), false);
  assert.equal(isIsoDate("2026-1-5"), false);
  assert.equal(isIsoDate(20261005), false);
  assert.equal(isIsoDate(undefined), false);
});

test("addDays, diffDays y weekday", () => {
  assert.equal(addDays("2026-10-31", 1), "2026-11-01");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
  assert.equal(diffDays("2026-10-09", HOY), 4);
  assert.equal(diffDays("2026-09-30", HOY), -5);
  assert.equal(weekday(HOY), 1);
  assert.equal(weekday("2026-10-04"), 0);
});

test("fechaCorta imita a Norte: 'lunes 31 ago', con año solo si cambia", () => {
  assert.equal(fechaCorta("2026-08-31", HOY), "lunes 31 ago");
  assert.equal(fechaCorta("2026-10-09", HOY), "viernes 9 oct");
  assert.equal(fechaCorta("2027-01-04", HOY), "lunes 4 ene 2027");
});

test("etiquetaFecha: vencidas, hoy, mañana y futuras", () => {
  assert.deepEqual(etiquetaFecha("2026-10-04", HOY, true), { label: "Venció ayer", overdue: true });
  assert.deepEqual(etiquetaFecha("2026-10-02", HOY, true), { label: "Venció hace 3 días", overdue: true });
  assert.deepEqual(etiquetaFecha("2026-09-01", HOY, true), { label: "Venció el martes 1 sep", overdue: true });
  assert.deepEqual(etiquetaFecha(HOY, HOY, true), { label: "hoy", overdue: false });
  assert.deepEqual(etiquetaFecha("2026-10-06", HOY, true), { label: "mañana", overdue: false });
  assert.deepEqual(etiquetaFecha("2026-10-09", HOY, true), { label: "viernes 9 oct", overdue: false });
  // una tarea cerrada nunca está vencida
  assert.deepEqual(etiquetaFecha("2026-10-04", HOY, false), { label: "domingo 4 oct", overdue: false });
});

test("fechaHablada: cómo se dice en voz", () => {
  assert.equal(fechaHablada(HOY, HOY), "hoy");
  assert.equal(fechaHablada("2026-10-06", HOY), "mañana");
  assert.equal(fechaHablada("2026-10-04", HOY), "ayer");
  assert.equal(fechaHablada("2026-10-09", HOY), "el viernes 9 de octubre");
  assert.equal(fechaHablada("2026-11-01", HOY), "el primero de noviembre");
  assert.equal(fechaHablada("2026-08-31", HOY), "el 31 de agosto");
  assert.equal(fechaHablada("2027-01-04", HOY), "el 4 de enero de 2027");
});

test("resolveDue entiende lo que David dice", () => {
  assert.equal(resolveDue("hoy", HOY), HOY);
  assert.equal(resolveDue("Mañana", HOY), "2026-10-06");
  assert.equal(resolveDue("pasado mañana", HOY), "2026-10-07");
  assert.equal(resolveDue("+3", HOY), "2026-10-08");
  assert.equal(resolveDue("en 2 días", HOY), "2026-10-07");
  assert.equal(resolveDue("en dos semanas", HOY), "2026-10-19");
  assert.equal(resolveDue("viernes", HOY), "2026-10-09");
  assert.equal(resolveDue("el próximo martes", HOY), "2026-10-06");
  assert.equal(resolveDue("el miércoles.", HOY), "2026-10-07");
  assert.equal(resolveDue("lunes", HOY), "2026-10-12"); // hoy es lunes: la próxima ocurrencia es la siguiente
  assert.equal(resolveDue("fin de mes", HOY), "2026-10-31");
  assert.equal(resolveDue("2026-12-25", HOY), "2026-12-25");
});

test("resolveDue: día y mes ('15 de octubre', '15/10', 'el 15'), siempre hacia adelante", () => {
  assert.equal(resolveDue("15 de octubre", HOY), "2026-10-15");
  assert.equal(resolveDue("el 15 de octubre.", HOY), "2026-10-15");
  assert.equal(resolveDue("5 de octubre", HOY), "2026-10-05"); // hoy cuenta
  assert.equal(resolveDue("3 de octubre", HOY), "2027-10-03"); // ya pasó: el próximo año
  assert.equal(resolveDue("1 nov", HOY), "2026-11-01");
  assert.equal(resolveDue("el 3 de setiembre de 2027", HOY), "2027-09-03");
  assert.equal(resolveDue("15/10", HOY), "2026-10-15");
  assert.equal(resolveDue("15-10-2026", HOY), "2026-10-15");
  assert.equal(resolveDue("el 15", HOY), "2026-10-15");
  assert.equal(resolveDue("el 3", HOY), "2026-11-03"); // el 3 de este mes ya pasó
  assert.equal(resolveDue("el 31", "2026-11-05"), "2026-12-31");
  assert.equal(resolveDue("el 31", "2026-12-05"), "2026-12-31");
  assert.equal(resolveDue("el 31", "2026-12-31"), "2026-12-31");
});

test("resolveDue: día y mes imposibles → null", () => {
  assert.equal(resolveDue("31 de abril", HOY), null);
  assert.equal(resolveDue("30 de febrero", HOY), null);
  assert.equal(resolveDue("15/13", HOY), null);
  assert.equal(resolveDue("15 de brumario", HOY), null);
  assert.equal(resolveDue("el 32", HOY), null);
  assert.equal(resolveDue("29 de febrero", "2027-01-10"), "2028-02-29"); // bisiesto: salta al año que sí existe
});

test("resolveDue no adivina", () => {
  assert.equal(resolveDue("2026-02-30", HOY), null);
  assert.equal(resolveDue("cuando pueda", HOY), null);
  assert.equal(resolveDue("", HOY), null);
  assert.equal(resolveDue(undefined, HOY), null);
  assert.equal(resolveDue(42, HOY), null);
});
