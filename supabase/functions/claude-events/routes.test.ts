// Corre en Node: node --experimental-strip-types --test supabase/functions/claude-events/routes.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { matchRoute } from "./routes.ts";

const ID = "3f2b8c1e-5d4a-4e7b-9c0d-1a2b3c4d5e6f";

test("rutas del dispositivo", () => {
  assert.deepEqual(matchRoute("GET", "/device/ping"), { name: "device.ping" });
  assert.deepEqual(matchRoute("POST", "/device/events"), { name: "device.event" });
  assert.deepEqual(matchRoute("GET", `/device/approvals/${ID}`), { name: "device.approval", id: ID });
});

test("rutas de la app", () => {
  assert.deepEqual(matchRoute("GET", "/ui/overview"), { name: "ui.overview" });
  assert.deepEqual(matchRoute("GET", "/ui/sessions/abc-123_x.y/events"), { name: "ui.sessionEvents", sessionId: "abc-123_x.y" });
  assert.deepEqual(matchRoute("POST", "/ui/devices"), { name: "ui.deviceCreate" });
  assert.deepEqual(matchRoute("PATCH", `/ui/devices/${ID}`), { name: "ui.devicePatch", id: ID });
  assert.deepEqual(matchRoute("DELETE", `/ui/devices/${ID}`), { name: "ui.deviceRevoke", id: ID });
  assert.deepEqual(matchRoute("POST", `/ui/approvals/${ID}/decision`), { name: "ui.approvalDecision", id: ID });
});

test("ignora el prefijo de la función, la barra final y mayúsculas del método", () => {
  assert.deepEqual(matchRoute("get", "/claude-events/device/ping/"), { name: "device.ping" });
  assert.deepEqual(matchRoute("GET", "/functions/v1/claude-events/device/ping"), { name: "device.ping" });
  assert.deepEqual(matchRoute("GET", "/claude-events"), "not_found");
});

test("método incorrecto en una ruta que existe → method_not_allowed", () => {
  assert.equal(matchRoute("GET", "/device/events"), "method_not_allowed");
  assert.equal(matchRoute("POST", "/device/ping"), "method_not_allowed");
  assert.equal(matchRoute("DELETE", "/ui/overview"), "method_not_allowed");
  assert.equal(matchRoute("GET", `/ui/approvals/${ID}/decision`), "method_not_allowed");
});

test("rutas inexistentes o con identificadores inválidos → not_found", () => {
  const nope = [
    "/",
    "/otra",
    "/device",
    "/device/approvals/no-es-uuid",
    `/device/approvals/${ID}/extra`,
    `/ui/devices/${ID.toUpperCase()}`,
    "/ui/devices/1",
    "/ui/sessions//events",
    "/ui/sessions/con espacio/events",
    "/ui/sessions/../../etc/passwd/events",
    `/ui/approvals/${ID}`,
  ];
  for (const p of nope) assert.equal(matchRoute("GET", p), "not_found", p);
});
