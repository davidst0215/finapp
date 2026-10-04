// Corre en Node: node --experimental-strip-types --test supabase/functions/claude-events/redact.test.ts
// Los casos viven en tools/claude-hooks/redaction-cases.json y también los corre el hook de la laptop:
// así las dos implementaciones (JS en la laptop, TS aquí) no se pueden desviar sin que una prueba falle.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { clipMiddle, normalizeForStorage, redactSecrets, sanitizeText } from "./redact.ts";

type Cases = {
  redact: { name: string; input: string; output: string }[];
  unchanged: { name: string; input: string }[];
  sanitize: { name: string; input: string; output: string }[];
  clipMiddle: { name: string; args: { text: string; max: number; head: number; tail: number }; output: string }[];
};

const cases: Cases = JSON.parse(
  readFileSync(new URL("../../../tools/claude-hooks/redaction-cases.json", import.meta.url), "utf8"),
);

for (const c of cases.redact) {
  test(`redactSecrets: ${c.name}`, () => assert.equal(redactSecrets(c.input), c.output));
}

for (const c of cases.unchanged) {
  test(`redactSecrets deja intacto: ${c.name}`, () => assert.equal(redactSecrets(c.input), c.input));
}

for (const c of cases.sanitize) {
  test(`sanitizeText: ${c.name}`, () => assert.equal(sanitizeText(c.input), c.output));
}

for (const c of cases.clipMiddle) {
  test(`clipMiddle: ${c.name}`, () => {
    const { text, max, head, tail } = c.args;
    assert.equal(clipMiddle(text, max, head, tail).text, c.output);
  });
}

test("clipMiddle no deja medio emoji huérfano en el corte", () => {
  const out = clipMiddle("😀".repeat(20), 10, 3, 3).text; // 3 unidades cortan un emoji (2 unidades) a la mitad
  assert.equal(out.isWellFormed(), true);
});

test("clipMiddle avisa si recortó", () => {
  assert.equal(clipMiddle("corto", 10, 4, 3).truncated, false);
  assert.equal(clipMiddle("abcdefghijklmnopqrstuvwxyz", 10, 4, 3).truncated, true);
});

test("redactSecrets es idempotente: pasarlo dos veces no cambia nada", () => {
  for (const c of cases.redact) assert.equal(redactSecrets(redactSecrets(c.input)), c.output);
});

test("redactSecrets no se cuelga con entradas patológicas", () => {
  const started = Date.now();
  const hostile = [
    "a.".repeat(4000),
    "A".repeat(8000),
    "token=".repeat(1500),
    "-----BEGIN PRIVATE KEY-----".repeat(300),
    "http://".repeat(1000),
    "eyJ" + "a".repeat(7000),
    "x_KEY=".repeat(1200),
  ];
  for (const h of hostile) redactSecrets(h);
  assert.ok(Date.now() - started < 2000, "la redacción de entradas hostiles tardó demasiado");
});

test("normalizeForStorage: limpia, redacta y recorta sin dejar partido un secreto en el corte", () => {
  const secret = "sk-ant-api03-" + "Z".repeat(60);
  // El corte (head = 700) cae a los 20 caracteres de la llave: si se recortara primero, quedaría un
  // pedazo de 20 caracteres demasiado corto para que la regla lo reconozca. Se redacta ANTES de recortar.
  const input = "a".repeat(679) + " " + secret + " " + "b".repeat(1500);
  const { text, truncated } = normalizeForStorage(input, { max: 1000, head: 700, tail: 200 });
  assert.equal(truncated, true);
  assert.ok(!text.includes("sk-ant"), "el prefijo de la llave no puede quedar en el texto guardado");
  assert.ok(!text.includes("ZZZZZZ"), "ningún pedazo de la llave puede quedar en el texto guardado");
  assert.ok(text.includes("[oculto]"));
  assert.ok(text.includes("caracteres omitidos"));
});

test("normalizeForStorage deja pasar un comando normal tal cual", () => {
  const out = normalizeForStorage("vercel env add VITE_SUPABASE_URL production", { max: 2000, head: 1400, tail: 500 });
  assert.deepEqual(out, { text: "vercel env add VITE_SUPABASE_URL production", truncated: false });
});
