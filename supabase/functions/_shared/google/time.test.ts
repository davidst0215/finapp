// node --experimental-strip-types --test supabase/functions/_shared/google/time.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  addDays, addMinutes, isDateKey, isHM, limaDateKey, limaDateTime, limaDayRange, limaHM, limaParts, limaRange, parseDayRef, parseTime, weekdayOf,
} from "./time.ts";

// lunes 5 de octubre de 2026, 08:00 en Lima = 13:00 UTC
const LUNES_8AM = new Date("2026-10-05T13:00:00Z");

describe("hora de Lima", () => {
  it("el día de Lima cambia a las 05:00 UTC, no a medianoche UTC", () => {
    assert.equal(limaDateKey(new Date("2026-10-05T04:59:59Z")), "2026-10-04"); // 23:59 del domingo en Lima
    assert.equal(limaDateKey(new Date("2026-10-05T05:00:00Z")), "2026-10-05"); // 00:00 del lunes en Lima
    assert.equal(limaDateKey(new Date("2026-10-06T02:00:00Z")), "2026-10-05"); // 21:00 del lunes en Lima
  });

  it("hora y minutos de pared", () => {
    assert.equal(limaHM(LUNES_8AM), "08:00");
    assert.deepEqual(limaParts(new Date("2026-10-06T04:30:00Z")), { dateKey: "2026-10-05", hm: "23:30", minutes: 23 * 60 + 30 });
    assert.equal(limaHM(new Date("2026-10-05T05:00:00Z")), "00:00");
  });

  it("rango de un día: [00:00, 00:00 siguiente) con desfase -05:00", () => {
    assert.deepEqual(limaDayRange("2026-10-05"), { timeMin: "2026-10-05T00:00:00-05:00", timeMax: "2026-10-06T00:00:00-05:00" });
  });

  it("rango de varios días y bordes de mes, año y bisiesto", () => {
    assert.deepEqual(limaRange("2026-10-04", 9), { timeMin: "2026-10-04T00:00:00-05:00", timeMax: "2026-10-13T00:00:00-05:00" });
    assert.equal(limaRange("2026-12-31").timeMax, "2027-01-01T00:00:00-05:00");
    assert.equal(limaRange("2028-02-28").timeMax, "2028-02-29T00:00:00-05:00");
    assert.equal(limaRange("2027-02-28").timeMax, "2027-03-01T00:00:00-05:00");
    assert.equal(limaRange("2026-10-05", 0).timeMax, "2026-10-06T00:00:00-05:00"); // mínimo 1 día
  });

  it("el rango en UTC corresponde exactamente al día de Lima", () => {
    const { timeMin, timeMax } = limaDayRange("2026-10-05");
    assert.equal(new Date(timeMin).toISOString(), "2026-10-05T05:00:00.000Z");
    assert.equal(new Date(timeMax).toISOString(), "2026-10-06T05:00:00.000Z");
  });

  it("limaDateTime arma RFC 3339 con el desfase de Lima", () => {
    assert.equal(limaDateTime("2026-10-05", "16:30"), "2026-10-05T16:30:00-05:00");
    assert.equal(new Date(limaDateTime("2026-10-05", "16:30")).toISOString(), "2026-10-05T21:30:00.000Z");
  });

  it("addDays y día de la semana", () => {
    assert.equal(addDays("2026-10-31", 1), "2026-11-01");
    assert.equal(addDays("2026-01-01", -1), "2025-12-31");
    assert.equal(weekdayOf("2026-10-05"), 1); // lunes
    assert.equal(weekdayOf("2026-10-04"), 0); // domingo
  });

  it("addMinutes cruza la medianoche", () => {
    assert.deepEqual(addMinutes("2026-10-05", "23:30", 90), { dateKey: "2026-10-06", hm: "01:00" });
    assert.deepEqual(addMinutes("2026-10-05", "09:00", 60), { dateKey: "2026-10-05", hm: "10:00" });
  });

  it("valida fechas y horas", () => {
    assert.ok(isDateKey("2028-02-29"));
    assert.ok(!isDateKey("2026-02-29"));
    assert.ok(!isDateKey("2026-02-31"));
    assert.ok(!isDateKey("2026-13-01"));
    assert.ok(!isDateKey("26-10-05"));
    assert.ok(!isDateKey(20261005));
    assert.ok(isHM("00:00") && isHM("23:59"));
    assert.ok(!isHM("24:00") && !isHM("9:00") && !isHM("12:60"));
  });
});

describe("parseTime", () => {
  const casos: [unknown, string | null][] = [
    ["16:30", "16:30"], ["9", "09:00"], ["09:05", "09:05"], ["4pm", "16:00"], ["4 pm", "16:00"], ["4:30 p.m.", "16:30"],
    ["12 am", "00:00"], ["12 pm", "12:00"], ["12:15am", "00:15"], ["16h30", "16:30"], ["mediodía", "12:00"], ["medianoche", "00:00"],
    ["0:00", "00:00"], ["23:59", "23:59"],
    ["24:00", null], ["25", null], ["13pm", null], ["0pm", null], ["9:60", null], ["", null], ["tarde", null], [null, null], [16, null],
  ];
  for (const [entrada, esperado] of casos) {
    it(`${JSON.stringify(entrada)} → ${esperado}`, () => assert.equal(parseTime(entrada), esperado));
  }
});

describe("parseDayRef (lunes 5 de oct 2026, 08:00 Lima)", () => {
  const casos: [string, string | null][] = [
    ["hoy", "2026-10-05"], ["Hoy", "2026-10-05"], ["mañana", "2026-10-06"], ["manana", "2026-10-06"], ["pasado mañana", "2026-10-07"], ["ayer", "2026-10-04"],
    ["viernes", "2026-10-09"], ["el viernes", "2026-10-09"], ["Miércoles", "2026-10-07"], ["sábado", "2026-10-10"], ["domingo", "2026-10-11"],
    ["lunes", "2026-10-12"], // hoy es lunes: "el lunes" es el de la semana siguiente
    ["este lunes", "2026-10-05"], ["próximo martes", "2026-10-06"], ["el viernes que viene", "2026-10-09"],
    ["en 3 días", "2026-10-08"], ["en 1 dia", "2026-10-06"],
    ["2026-10-07", "2026-10-07"], ["7 de octubre", "2026-10-07"], ["el 7 de octubre", "2026-10-07"], ["7 octubre", "2026-10-07"],
    ["3 de octubre", "2027-10-03"], // ya pasó este año → el siguiente
    ["1 de noviembre", "2026-11-01"], ["15 de setiembre de 2027", "2027-09-15"], ["29 de febrero de 2028", "2028-02-29"],
    ["31 de febrero", null], ["30 de brumario", null], ["quizás", null], ["", null],
  ];
  for (const [entrada, esperado] of casos) {
    it(`"${entrada}" → ${esperado}`, () => assert.equal(parseDayRef(entrada, LUNES_8AM), esperado));
  }

  it("usa el día de Lima, no el de UTC (21:00 del lunes en Lima ya es martes en UTC)", () => {
    const lunesNoche = new Date("2026-10-06T02:00:00Z");
    assert.equal(parseDayRef("hoy", lunesNoche), "2026-10-05");
    assert.equal(parseDayRef("mañana", lunesNoche), "2026-10-06");
  });

  it("no es texto → null", () => {
    assert.equal(parseDayRef(undefined, LUNES_8AM), null);
    assert.equal(parseDayRef(5, LUNES_8AM), null);
  });
});
