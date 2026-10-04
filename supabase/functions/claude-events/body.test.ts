// Corre en Node: node --experimental-strip-types --test supabase/functions/claude-events/body.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { readBodyLimited } from "./body.ts";

const post = (body: BodyInit | null, headers: Record<string, string> = {}) =>
  new Request("https://x.test/claude-events/device/events", { method: "POST", body, headers, duplex: "half" } as RequestInit);

test("lee un cuerpo pequeño con tildes y emojis intactos", async () => {
  assert.equal(await readBodyLimited(post('{"m":"canción ñandú 😀"}'), 1000), '{"m":"canción ñandú 😀"}');
});

test("sin cuerpo devuelve cadena vacía", async () => {
  assert.equal(await readBodyLimited(new Request("https://x.test", { method: "GET" }), 1000), "");
});

test("un cuerpo que pasa el tope devuelve null", async () => {
  assert.equal(await readBodyLimited(post("x".repeat(1001)), 1000), null);
  assert.equal(await readBodyLimited(post("x".repeat(1000)), 1000), "x".repeat(1000));
});

test("corta la lectura apenas se pasa del tope, sin leer el resto del flujo", async () => {
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled++;
      controller.enqueue(new TextEncoder().encode("x".repeat(400)));
      if (pulled > 1000) controller.close();
    },
  });
  assert.equal(await readBodyLimited(post(stream), 1000), null);
  assert.ok(pulled < 20, `leyó ${pulled} trozos de un flujo casi infinito`);
});

test("si Content-Length ya declara un cuerpo enorme, ni siquiera lo lee", async () => {
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled++;
      controller.enqueue(new TextEncoder().encode("x"));
    },
  });
  assert.equal(await readBodyLimited(post(stream, { "content-length": "5000000" }), 1000), null);
  assert.ok(pulled <= 1, `leyó ${pulled} trozos (el único permitido es el pull inicial que hace el propio flujo)`);
});
