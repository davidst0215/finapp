import { test } from "node:test";
import assert from "node:assert/strict";
import { bearer, jwtSub } from "./jwt.ts";

const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (payload: unknown) => `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url(payload)}.firma`;
const ID = "e4b35bad-709a-4585-b0f9-99377435bdc2";

test("jwtSub devuelve el sub de un usuario autenticado", () => {
  assert.equal(jwtSub(jwt({ role: "authenticated", sub: ID })), ID);
  assert.equal(jwtSub(jwt({ role: "authenticated", sub: ID.toUpperCase() })), ID.toUpperCase());
});

test("jwtSub rechaza la anon key y el service role", () => {
  assert.equal(jwtSub(jwt({ role: "anon", iss: "supabase" })), null);
  assert.equal(jwtSub(jwt({ role: "service_role", sub: ID })), null);
});

test("jwtSub rechaza tokens mal formados", () => {
  assert.equal(jwtSub(""), null);
  assert.equal(jwtSub("abc"), null);
  assert.equal(jwtSub("a.b.c"), null);
  assert.equal(jwtSub(jwt({ role: "authenticated", sub: 42 })), null);
  assert.equal(jwtSub(jwt({ role: "authenticated", sub: "" })), null);
});

test("jwtSub exige UUID: nada que se pueda colar en un filtro de PostgREST", () => {
  assert.equal(jwtSub(jwt({ role: "authenticated", sub: "x,user_id.is.not.null" })), null);
  assert.equal(jwtSub(jwt({ role: "authenticated", sub: `${ID})` })), null);
  assert.equal(jwtSub(jwt({ role: "authenticated", sub: "a1b2-c3" })), null);
});

test("jwtSub decodifica payloads base64url con - y _ y texto UTF-8", () => {
  // El nombre fuerza caracteres - y _ en el base64url del payload.
  assert.equal(jwtSub(jwt({ role: "authenticated", sub: ID, nombre: "ñandú ~~~>>>???" })), ID);
});

test("bearer extrae el token o devuelve vacío", () => {
  assert.equal(bearer(new Request("https://x", { headers: { Authorization: "Bearer abc.def.ghi" } })), "abc.def.ghi");
  assert.equal(bearer(new Request("https://x", { headers: { Authorization: "Basic xyz" } })), "");
  assert.equal(bearer(new Request("https://x")), "");
});
