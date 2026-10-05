// Corre en Node: node --experimental-strip-types --test apps/web/src/components/claude/format.test.mjs
// Es .mjs a propósito: `tsc -b` no incluye .mjs, así que no necesita @types/node en la app web.
import assert from "node:assert/strict";
import { test } from "node:test";
import { countdown, dayLabel, isTaskActive, listTime, limaClock, limaDayClock, messageStatusLabel, taskDuration, taskStatusLabel, timeAgo, toolLabel } from "./format.ts";

const NOW = Date.parse("2026-10-04T19:30:00.000Z"); // 14:30 en Lima

test("countdown muestra m:ss y redondea hacia arriba", () => {
  assert.equal(countdown(120_000), "2:00");
  assert.equal(countdown(101_200), "1:42");
  assert.equal(countdown(59_001), "1:00");
  assert.equal(countdown(1), "0:01");
  assert.equal(countdown(0), "0:00");
  assert.equal(countdown(-5000), "0:00");
});

test("timeAgo en minutos, horas y días", () => {
  const ago = (ms) => timeAgo(new Date(NOW - ms).toISOString(), NOW);
  assert.equal(ago(30_000), "hace un momento");
  assert.equal(ago(3 * 60_000), "hace 3 min");
  assert.equal(ago(59 * 60_000 + 59_000), "hace 59 min");
  assert.equal(ago(2 * 3600_000), "hace 2 h");
  assert.equal(ago(25 * 3600_000), "hace 1 d");
  assert.equal(timeAgo(new Date(NOW + 5000).toISOString(), NOW), "hace un momento", "un reloj adelantado no da tiempos negativos");
});

test("las horas se muestran en Lima (UTC-5), no en la zona del celular", () => {
  assert.equal(limaClock("2026-10-04T19:20:00.000Z"), "14:20");
  assert.equal(limaClock("2026-10-05T04:59:00.000Z"), "23:59");
  assert.equal(limaClock("2026-10-05T05:00:00.000Z"), "00:00");
});

test("limaDayClock omite el día si es hoy en Lima y lo agrega si no", () => {
  assert.equal(limaDayClock("2026-10-04T19:20:00.000Z", NOW), "14:20");
  assert.equal(limaDayClock("2026-10-03T19:20:00.000Z", NOW), "3 oct 14:20");
  // 02:00 UTC del 5 de octubre sigue siendo el 4 en Lima.
  assert.equal(limaDayClock("2026-10-05T02:00:00.000Z", NOW), "21:00");
});

test("toolLabel nombra la acción en español y las herramientas MCP por su servidor", () => {
  assert.equal(toolLabel("Bash"), "Ejecutar un comando");
  assert.equal(toolLabel("PowerShell"), "Ejecutar un comando");
  assert.equal(toolLabel("Write"), "Crear o sobrescribir un archivo");
  assert.equal(toolLabel("mcp__notion__create_page"), "Usar create_page de notion");
  assert.equal(toolLabel("mcp__plugin_x_db__query"), "Usar query de plugin_x_db");
  assert.equal(toolLabel("AlgoNuevo"), "Usar AlgoNuevo");
});

test("taskDuration: segundos, minutos y horas; viva cuenta hasta ahora; sin inicio, vacío", () => {
  const at = (ms) => new Date(NOW - ms).toISOString();
  assert.equal(taskDuration({ started_at: null, finished_at: null }, NOW), "");
  assert.equal(taskDuration({ started_at: at(45_000), finished_at: null }, NOW), "45 s");
  assert.equal(taskDuration({ started_at: at(10 * 60_000), finished_at: at(7 * 60_000) }, NOW), "3 min");
  assert.equal(taskDuration({ started_at: at(65 * 60_000), finished_at: null }, NOW), "1 h 05 min");
});

test("etiquetas de estado y tareas vivas", () => {
  assert.equal(messageStatusLabel("en_cola"), "En cola");
  assert.equal(messageStatusLabel("vencido"), "No se entregó");
  assert.equal(messageStatusLabel("entregando"), "Entregando…");
  assert.equal(taskStatusLabel("rechazada"), "Rechazada por la laptop");
  assert.equal(isTaskActive("ejecutando"), true);
  assert.equal(isTaskActive("en_cola"), true);
  assert.equal(isTaskActive("terminada"), false);
});

test("listTime: como en un chat (Ahora, hora de hoy, Ayer, día de la semana, fecha)", () => {
  const at = (iso) => listTime(iso, NOW);
  assert.equal(at(new Date(NOW - 20_000).toISOString()), "Ahora");
  assert.equal(at("2026-10-04T19:20:00.000Z"), "14:20");
  assert.equal(at("2026-10-03T22:00:00.000Z"), "Ayer");
  assert.equal(at("2026-10-04T04:00:00.000Z"), "Ayer", "23:00 del 3 en Lima");
  assert.equal(at("2026-10-01T15:00:00.000Z"), "jue");
  assert.equal(at("2026-09-20T15:00:00.000Z"), "20 set");
});

test("dayLabel: Hoy, Ayer o el día completo", () => {
  assert.equal(dayLabel("2026-10-04T14:00:00.000Z", NOW), "Hoy");
  assert.equal(dayLabel("2026-10-03T22:00:00.000Z", NOW), "Ayer");
  assert.match(dayLabel("2026-09-29T15:00:00.000Z", NOW), /^martes,? 29 set/);
});
