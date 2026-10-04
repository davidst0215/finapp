import { test } from "node:test";
import assert from "node:assert/strict";
import { bearer, jwtSub } from "./jwt.ts";

const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (payload: unknown) => `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url(payload)}.firma`;

test("jwtSub devuelve el sub de un usuario autenticado", () => {
  assert.equal(jwtSub(jwt({ role: "authenticated", sub: "a1b2-c3" })), "a1b2-c3");
});

test("jwtSub rechaza la anon key y el service role", () => {
  assert.equal(jwtSub(jwt({ role: "anon", iss: "supabase" })), null);
  assert.equal(jwtSub(jwt({ role: "service_role" })), null);
});

test("jwtSub rechaza tokens mal formados", () => {
  assert.equal(jwtSub(""), null);
  assert.equal(jwtSub("abc"), null);
  assert.equal(jwtSub("a.b.c"), null);
  assert.equal(jwtSub(jwt({ role: "authenticated", sub: 42 })), null);
  assert.equal(jwtSub(jwt({ role: "authenticated", sub: "" })), null);
});

test("jwtSub decodifica base64url con - y _ y texto UTF-8", () => {
  for (const sub of ["~~~>>>???", "ñandú-ü"]) assert.equal(jwtSub(jwt({ role: "authenticated", sub })), sub);
});

test("bearer extrae el token o devuelve vacío", () => {
  assert.equal(bearer(new Request("https://x", { headers: { Authorization: "Bearer abc.def.ghi" } })), "abc.def.ghi");
  assert.equal(bearer(new Request("https://x", { headers: { Authorization: "Basic xyz" } })), "");
  assert.equal(bearer(new Request("https://x")), "");
});
