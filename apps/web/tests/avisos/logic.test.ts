// Lógica pura de la pantalla de avisos. Corre en Node:
//   node --experimental-strip-types --test apps/web/tests/avisos/logic.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  base64UrlToBytes,
  bytesToBase64Url,
  canToggle,
  describeTest,
  devicePhase,
  deviceText,
  formatRelative,
  isAppPath,
  kindLabel,
  sameKey,
} from "../../src/components/avisos/logic.ts";

test("base64url: valores conocidos en ambos sentidos", () => {
  assert.deepEqual([...base64UrlToBytes("AQID")], [1, 2, 3]);
  assert.deepEqual([...base64UrlToBytes("-__-")], [251, 255, 254]); // "+//+" en base64 estándar
  assert.deepEqual([...base64UrlToBytes("AQI=")], [1, 2]);
  assert.equal(bytesToBase64Url(Uint8Array.of(251, 255, 254)), "-__-");
  assert.equal(bytesToBase64Url(Uint8Array.of(1, 2).buffer), "AQI");
  assert.throws(() => base64UrlToBytes("no+es/base64url"));
});

test("sameKey: compara la clave con la que se suscribió el navegador", () => {
  const clave = "AQID";
  assert.equal(sameKey(Uint8Array.of(1, 2, 3).buffer, clave), true);
  assert.equal(sameKey(Uint8Array.of(1, 2, 4).buffer, clave), false);
  assert.equal(sameKey(null, clave), false);
  assert.equal(sameKey(undefined, clave), false);
});

// 4-oct-2026 15:00 UTC = 10:00 en Lima (UTC-5)
const AHORA = new Date("2026-10-04T15:00:00Z");

test("formatRelative: minutos, horas y días en español", () => {
  const casos: Array<[string, string]> = [
    ["2026-10-04T14:59:40Z", "ahora"],
    ["2026-10-04T14:55:00Z", "hace 5 min"],
    ["2026-10-04T14:01:00Z", "hace 59 min"],
    ["2026-10-04T12:00:00Z", "hace 3 h"],
    ["2026-10-03T14:00:00Z", "ayer"],
    ["2026-10-02T20:00:00Z", "hace 2 d"],
    ["2026-09-28T20:00:00Z", "hace 6 d"],
    ["2026-09-20T20:00:00Z", "20 sep"],
    ["2025-12-31T20:00:00Z", "31 dic 2025"],
  ];
  for (const [iso, esperado] of casos) assert.equal(formatRelative(iso, AHORA), esperado, iso);
});

test("formatRelative: 'ayer' es el día calendario de Lima, no 24 horas", () => {
  const pasadaLaMedianoche = new Date("2026-10-04T05:30:00Z"); // 00:30 del 4 en Lima
  assert.equal(formatRelative("2026-10-04T04:30:00Z", pasadaLaMedianoche), "hace 1 h"); // 23:30 del 3, solo 1 h antes
  assert.equal(formatRelative("2026-10-03T04:30:00Z", pasadaLaMedianoche), "hace 2 d"); // 23:30 del 2: 25 h antes, pero dos días de calendario
  assert.equal(formatRelative("2026-10-03T22:00:00Z", new Date("2026-10-05T04:30:00Z")), "ayer"); // en UTC van dos días; en Lima, 17:00 del 3 vs 23:30 del 4
  assert.equal(formatRelative("2026-10-03T15:00:00Z", new Date("2026-10-04T23:00:00Z")), "ayer"); // 37 h antes, pero ayer
});

test("formatRelative: una fecha futura (reloj desfasado) se lee como ahora", () => {
  assert.equal(formatRelative("2026-10-04T15:05:00Z", AHORA), "ahora");
});

test("isAppPath: tocar un aviso nunca saca al usuario de la app", () => {
  for (const ok of ["/tareas", "/tareas?id=7#nota", "/"]) assert.equal(isAppPath(ok), true, ok);
  for (const mal of ["https://evil.example/x", "//evil.example", "/\\evil.example", "javascript:alert(1)", "tareas", "/con espacio", "", null, undefined]) {
    assert.equal(isAppPath(mal), false, String(mal));
  }
});

test("kindLabel: nombre legible de cada tipo de aviso", () => {
  assert.equal(kindLabel("brief"), "Brief");
  assert.equal(kindLabel("pago"), "Pago");
  assert.equal(kindLabel("tarea"), "Tarea");
  assert.equal(kindLabel("espera"), "Espera");
  assert.equal(kindLabel("agenda"), "Agenda");
  assert.equal(kindLabel("correo"), "Correo");
  assert.equal(kindLabel("claude"), "Claude Code");
  assert.equal(kindLabel("sistema"), "Sistema");
  assert.equal(kindLabel("inventado"), "Aviso");
});

const base = { checking: false, supported: true, hasWorker: true, permission: "default" as const, subscribed: false };

test("devicePhase: en qué estado está este dispositivo", () => {
  assert.equal(devicePhase({ ...base, checking: true }), "checking");
  assert.equal(devicePhase({ ...base, supported: false }), "unsupported");
  assert.equal(devicePhase({ ...base, hasWorker: false }), "no-worker");
  assert.equal(devicePhase({ ...base, permission: "denied" }), "blocked");
  assert.equal(devicePhase({ ...base, permission: "denied", subscribed: true }), "blocked", "sin permiso la suscripción no sirve");
  assert.equal(devicePhase({ ...base, permission: "default" }), "off");
  assert.equal(devicePhase({ ...base, permission: "granted", subscribed: false }), "off");
  assert.equal(devicePhase({ ...base, permission: "granted", subscribed: true }), "on");
});

test("canToggle: el interruptor solo responde cuando se puede y no hay nada en curso", () => {
  assert.equal(canToggle("off", "idle"), true);
  assert.equal(canToggle("on", "idle"), true);
  assert.equal(canToggle("off", "enabling"), false);
  assert.equal(canToggle("on", "disabling"), false);
  for (const fase of ["checking", "unsupported", "no-worker", "blocked"] as const) assert.equal(canToggle(fase, "idle"), false, fase);
});

test("deviceText: cada estado dice qué pasa y qué hacer", () => {
  assert.match(deviceText("on", "idle"), /^Activados/);
  assert.match(deviceText("off", "idle"), /^Desactivados/);
  assert.match(deviceText("off", "enabling"), /^Activando/);
  assert.match(deviceText("on", "disabling"), /^Desactivando/);
  assert.match(deviceText("blocked", "idle"), /Bloqueaste/);
  assert.match(deviceText("blocked", "idle"), /Ajustes/, "dice dónde permitirlas");
  assert.match(deviceText("unsupported", "idle"), /no admite/);
  assert.match(deviceText("no-worker", "idle"), /service worker/);
  assert.match(deviceText("checking", "idle"), /Comprobando/);
});

test("describeTest: qué le dice la pantalla a David después de pedir un aviso de prueba", () => {
  const ok = { configured: true, devices: 1, sent: 1, removed: 0, failed: 0, statuses: [201] };
  assert.deepEqual(describeTest(ok), { tone: "ok", message: "Aviso enviado. Debería llegarte en unos segundos." });
  assert.deepEqual(describeTest({ ...ok, devices: 2, sent: 2, statuses: [201, 201] }), {
    tone: "ok",
    message: "Aviso enviado a 2 dispositivos. Debería llegarte en unos segundos.",
  });
  assert.equal(describeTest({ ...ok, devices: 2, sent: 1, failed: 1, statuses: [201, 503] }).tone, "ok");
  assert.match(describeTest({ ...ok, devices: 2, sent: 1, failed: 1, statuses: [201, 503] }).message, /1 dispositivo no respondió/);

  assert.equal(describeTest({ ...ok, configured: false, devices: 0, sent: 0, statuses: [] }).tone, "warn");
  assert.match(describeTest({ ...ok, configured: false, devices: 0, sent: 0, statuses: [] }).message, /VAPID/);
  assert.equal(describeTest({ ...ok, devices: 0, sent: 0, statuses: [] }).tone, "warn");
  assert.match(describeTest({ ...ok, devices: 0, sent: 0, statuses: [] }).message, /ningún dispositivo/);

  const rechazado = describeTest({ ...ok, sent: 0, failed: 1, statuses: [403] });
  assert.equal(rechazado.tone, "error");
  assert.match(rechazado.message, /403/);
  const sinRed = describeTest({ ...ok, sent: 0, failed: 1, statuses: [null] });
  assert.equal(sinRed.tone, "error");
  assert.doesNotMatch(sinRed.message, /null|código/);

  const caducado = describeTest({ ...ok, sent: 0, removed: 1, statuses: [410] });
  assert.equal(caducado.tone, "warn");
  assert.match(caducado.message, /Desactiva y vuelve a activar/);
});
