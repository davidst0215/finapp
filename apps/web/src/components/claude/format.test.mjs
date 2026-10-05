// Corre en Node: node --experimental-strip-types --test apps/web/src/components/claude/format.test.mjs
// Es .mjs a propósito: `tsc -b` no incluye .mjs, así que no necesita @types/node en la app web.
import assert from "node:assert/strict";
import { test } from "node:test";
import { countdown, describeSession, isTaskActive, limaClock, limaDayClock, messageStatusLabel, taskDuration, taskStatusLabel, timeAgo, toolLabel } from "./format.ts";

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

const session = (over = {}) => ({
  id: "s", device_id: "d", project: "finapp", cwd: null, status: "trabajando", summary: null,
  started_at: "2026-10-04T18:00:00.000Z", last_event_at: "2026-10-04T19:18:00.000Z", ended_at: null, ...over,
});

test("describeSession cubre cada estado", () => {
  assert.deepEqual(describeSession(session(), undefined, NOW), { tone: "active", text: "Trabajando · hace 12 min" });
  assert.deepEqual(describeSession(session({ status: "esperando" }), undefined, NOW), { tone: "waiting", text: "Esperando tu instrucción · hace 12 min" });
  assert.deepEqual(
    describeSession(session({ status: "terminada", ended_at: "2026-10-04T19:20:00.000Z" }), undefined, NOW),
    { tone: "done", text: "Terminó 14:20" },
  );
  assert.deepEqual(describeSession(session({ status: "error", last_event_at: "2026-10-04T18:05:00.000Z" }), undefined, NOW), { tone: "error", text: "Falló · 13:05" });
});

test("una aprobación pendiente manda sobre el estado guardado", () => {
  assert.deepEqual(describeSession(session({ status: "esperando" }), { id: "a" }, NOW), { tone: "asking", text: "Pide permiso" });
});

test("una sesión sin señal por más de 6 h ya no figura como trabajando", () => {
  const old = session({ last_event_at: "2026-10-04T10:00:00.000Z" });
  assert.deepEqual(describeSession(old, undefined, NOW), { tone: "stale", text: "Sin actividad desde 05:00" });
  assert.equal(describeSession({ ...old, status: "esperando" }, undefined, NOW).tone, "stale");
  assert.equal(describeSession({ ...old, status: "error" }, undefined, NOW).tone, "error", "una falla no se disfraza de inactividad");
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
  assert.equal(messageStatusLabel("vencido"), "Vencido");
  assert.equal(taskStatusLabel("rechazada"), "Rechazada por la laptop");
  assert.equal(isTaskActive("ejecutando"), true);
  assert.equal(isTaskActive("en_cola"), true);
  assert.equal(isTaskActive("terminada"), false);
});
