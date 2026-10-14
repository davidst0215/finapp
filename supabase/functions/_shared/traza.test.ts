// node --experimental-strip-types --test supabase/functions/_shared/traza.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { argsTraza, filaTraza, guardarTraza, MAX_TRAZA_TEXTO, textoTraza } from "./traza.ts";

test("el texto dicho conserva lo que dijo David pero enmascara los teléfonos", () => {
  assert.equal(textoTraza("escríbele a Melissa que llego tarde"), "escríbele a Melissa que llego tarde");
  const t = textoTraza("guarda a Marco con el 999 888 777, es de Saya");
  assert.ok(!/\d{3}/.test(t), `sin dígitos seguidos: ${t}`);
  assert.match(t, /\[número\]/);
  assert.match(t, /Marco/);
  assert.ok(!textoTraza("llámame al 999/888/777 o al +51 999-888-777").match(/\d{3}/));
  // Montos chicos y fechas siguen legibles: el gasto de S/ 45 es lo que se necesita para depurar.
  assert.equal(textoTraza("gasté 45 soles en el almuerzo"), "gasté 45 soles en el almuerzo");
});

test("acota el largo y tolera lo que no es texto", () => {
  assert.equal(textoTraza("a".repeat(MAX_TRAZA_TEXTO + 500)).length, MAX_TRAZA_TEXTO);
  assert.equal(textoTraza(undefined), "");
  assert.equal(textoTraza(null), "");
  assert.equal(textoTraza(123), "");
});

test("los argumentos nunca guardan el teléfono (ni enmascarado) y enmascaran números dentro del texto", () => {
  const a = argsTraza({ nombre: "Melissa", relacion: "mi novia", telefono: "999888777", mensaje: "llámame al 999 111 222", alias: ["Meli"] }) as Record<string, unknown>;
  assert.equal("telefono" in a, false);
  assert.equal(a.nombre, "Melissa");
  assert.deepEqual(a.alias, ["Meli"]);
  assert.ok(!String(a.mensaje).match(/\d{3}/));
  assert.equal("Phone" in (argsTraza({ Phone: "999888777" }) as object), false, "sin importar mayúsculas");
});

test("los argumentos tienen tope de profundidad, largo y claves", () => {
  const hondo = argsTraza({ a: { b: { c: { d: "x" } } } }) as { a: { b: { c: unknown } } };
  assert.equal(hondo.a.b.c, null);
  assert.equal((argsTraza({ lista: Array.from({ length: 50 }, (_, i) => i) }) as { lista: unknown[] }).lista.length, 20);
  assert.equal(Object.keys(argsTraza(Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`k${i}`, i]))) as object).length, 30);
  assert.equal(((argsTraza({ t: "z".repeat(5000) }) as { t: string }).t).length, 500);
  assert.equal(argsTraza(null), null);
  assert.equal(argsTraza(undefined), null);
  assert.equal(argsTraza(12.5), 12.5);
});

test("filaTraza: fila completa, con nulos donde no hay dato", () => {
  const f = filaTraza({
    texto: "hola 999888777", fn: "find_contact", args: { nombre: "Melissa" }, resultado: "clarify", mensaje: "No tengo a Melissa.",
    prov: "Io Net", respaldo: false, voz: true, voz_chars: 70.4, medidas: { llm: 1300, total: 1800 },
  });
  assert.equal(f.texto, "hola [número]");
  assert.equal(f.fn, "find_contact");
  assert.deepEqual(f.args, { nombre: "Melissa" });
  assert.equal(f.voz_chars, 70);
  assert.equal(f.error, null);
  const vacia = filaTraza({ texto: "x" });
  assert.deepEqual(vacia, { texto: "x", fn: null, args: null, resultado: null, mensaje: null, error: null, prov: null, respaldo: false, voz: false, voz_chars: null, medidas: null });
  assert.equal(filaTraza({ texto: "x", error: "excepcion: fallo con 999888777" }).error, "excepcion: fallo con [número]");
});

test("guardarTraza inserta con el dueño y NUNCA lanza ni deja pasar el error", async () => {
  const filas: Record<string, unknown>[] = [];
  const ok = { from: (t: string) => ({ insert: async (f: Record<string, unknown>) => { assert.equal(t, "agent_trazas"); filas.push(f); return { error: null }; } }) };
  await guardarTraza(ok, "u1", { texto: "gasté 45 soles", fn: "create_transaction" });
  assert.equal(filas.length, 1);
  assert.equal(filas[0]!.user_id, "u1");
  assert.equal(filas[0]!.fn, "create_transaction");

  const errores: unknown[][] = [];
  const original = console.error;
  console.error = (...a: unknown[]) => { errores.push(a); };
  try {
    // Tabla sin migrar / RLS: el error va al log y no se propaga.
    await guardarTraza({ from: () => ({ insert: async () => ({ error: { code: "42P01", message: "relation does not exist" } }) }) }, "u1", { texto: "x" });
    // Red caída: lanza dentro del insert.
    await guardarTraza({ from: () => ({ insert: async () => { throw new Error("fetch failed"); } }) }, "u1", { texto: "x" });
    // El cliente mismo roto.
    await guardarTraza({ from: () => { throw new Error("sin cliente"); } }, "u1", { texto: "x" });
  } finally {
    console.error = original;
  }
  assert.equal(errores.length, 3);
});
