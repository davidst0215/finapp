// node --experimental-strip-types --test supabase/functions/agent/tools/hechos.test.ts
// Memoria personal de punta a punta con una tabla en memoria que imita lo que PostgREST + RLS hacen con `wabid_hechos`: recordar,
// actualizar en vez de duplicar, olvidar (preguntando si es ambiguo), listar y el bloque de contexto con su caché. Nada toca la base.
import test from "node:test";
import assert from "node:assert/strict";
import { capturarLog, OWNER } from "./testlib.ts";
import { prepararVoz, VOZ_MAX } from "../../_shared/voz.ts";
import { loQueSeDice } from "../respuesta.ts";
import { MAX_CHARS_CONTEXTO, MAX_HECHOS } from "../../_shared/hechos.ts";

const { hechos } = await import("./hechos.ts");

type Fila = { hecho_id: string; user_id: string; texto: string; categoria: string | null; creado: string; actualizado: string };

/**
 * `wabid_hechos` en memoria. Respeta lo que importa de la tabla real: filtra por los `.eq()` (el agente SIEMPRE filtra por user_id), ordena
 * como la consulta, rechaza el texto repetido sin importar mayúsculas (23505) y cuenta cuántas lecturas hizo (para probar la caché).
 */
function tabla(inicial: { texto: string; user_id?: string; categoria?: string | null }[] = []) {
  const filas: Fila[] = [];
  let n = 0;
  const base = Date.UTC(2026, 9, 1);
  const nueva = (texto: string, user_id: string, categoria: string | null = null): Fila => {
    const t = new Date(base + ++n * 60_000).toISOString(); // cada alta es un minuto más reciente
    return { hecho_id: `h${n}`, user_id, texto, categoria, creado: t, actualizado: t };
  };
  for (const f of inicial) filas.push(nueva(f.texto, f.user_id ?? OWNER, f.categoria ?? null));
  const estado = { lecturas: 0, escrituras: 0, falla: null as null | { code?: string; message: string }, sinTabla: false };
  const filtrar = (eqs: [string, unknown][]) => filas.filter((f) => eqs.every(([c, v]) => (f as unknown as Record<string, unknown>)[c] === v));

  // deno-lint-ignore no-explicit-any
  const consulta = (op: "select" | "update" | "delete", patch?: Record<string, unknown>): any => {
    const eqs: [string, unknown][] = [];
    let orden: [string, boolean][] = [];
    let tope = Infinity;
    const ejecutar = () => {
      if (estado.sinTabla) return { data: null, error: { code: "42P01", message: 'relation "wabid_hechos" does not exist' } };
      if (estado.falla) return { data: null, error: estado.falla };
      const sel = filtrar(eqs);
      if (op === "select") {
        estado.lecturas++;
        const out = [...sel].sort((a, b) => {
          for (const [c, asc] of orden) {
            const x = String((a as unknown as Record<string, unknown>)[c]), y = String((b as unknown as Record<string, unknown>)[c]);
            if (x !== y) return (x < y ? -1 : 1) * (asc ? 1 : -1);
          }
          return 0;
        });
        return { data: out.slice(0, tope).map((f) => ({ ...f })), error: null };
      }
      estado.escrituras++;
      if (op === "update") for (const f of sel) Object.assign(f, patch);
      else for (const f of sel) filas.splice(filas.indexOf(f), 1);
      return { data: null, error: null };
    };
    // deno-lint-ignore no-explicit-any
    const q: any = {
      eq: (c: string, v: unknown) => (eqs.push([c, v]), q),
      order: (c: string, o?: { ascending?: boolean }) => (orden.push([c, o?.ascending !== false]), q),
      limit: (k: number) => ((tope = k), q),
      then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(ejecutar()).then(ok, ko),
    };
    return q;
  };
  const db = {
    from: (t: string) => {
      assert.equal(t, "wabid_hechos");
      return {
        select: () => consulta("select"),
        update: (patch: Record<string, unknown>) => consulta("update", patch),
        delete: () => consulta("delete"),
        insert: (row: { user_id: string; texto: string; categoria: string | null }) => {
          if (estado.sinTabla) return Promise.resolve({ error: { code: "42P01", message: "no existe" } });
          if (estado.falla) return Promise.resolve({ error: estado.falla });
          if (filas.some((f) => f.user_id === row.user_id && f.texto.toLowerCase() === row.texto.toLowerCase())) {
            return Promise.resolve({ error: { code: "23505", message: "duplicate key value violates unique constraint" } });
          }
          estado.escrituras++;
          filas.push(nueva(row.texto, row.user_id, row.categoria));
          return Promise.resolve({ error: null });
        },
      };
    },
  };
  return { db, filas, estado, textos: (user = OWNER) => filas.filter((f) => f.user_id === user).map((f) => f.texto) };
}

let k = 0;
/** Un usuario distinto por prueba: la caché del módulo es por usuario y por instancia. */
const nuevoUsuario = () => `${String(++k).padStart(8, "0")}-0000-4000-8000-000000000000`;
const ctx = (db: unknown, text: string, user = OWNER) =>
  ({ supabase: db as never, user: { id: user } as never, text, limaNow: new Date("2026-10-11T12:00:00Z") });
const voz = (r: { voz?: string; message: string }) => prepararVoz(loQueSeDice(r as never));

const BBVA = "La tarjeta principal de David es la BBVA";

test("«recuerda que mi tarjeta principal es la BBVA»: guarda la frase del usuario, dice «Lo recordaré.» y no duplica", async () => {
  const u = nuevoUsuario();
  const t = tabla();
  const r = await hechos.handlers.remember_fact({ hecho: BBVA, categoria: "finanzas" }, ctx(t.db, "recuerda que mi tarjeta principal es la BBVA", u), undefined);
  assert.equal(r.action, "remember_fact");
  assert.equal(r.voz, "Lo recordaré.");
  assert.equal(r.message, `Lo recordaré: «${BBVA}».`);
  assert.deepEqual(t.filas.map((f) => [f.user_id, f.texto, f.categoria]), [[u, BBVA, "finanzas"]]);

  // otra vez, igual → no escribe; reformulado → no duplica y deja la redacción nueva
  const igual = await hechos.handlers.remember_fact({ hecho: BBVA }, ctx(t.db, "recuerda", u), undefined);
  assert.equal(igual.voz, "Ya lo sabía.");
  const escrituras = t.estado.escrituras;
  const reformulado = await hechos.handlers.remember_fact({ hecho: "Tarjeta principal: BBVA" }, ctx(t.db, "recuerda", u), undefined);
  assert.equal(reformulado.voz, "Actualizado.");
  assert.deepEqual(t.textos(u), ["Tarjeta principal: BBVA"], "una sola fila");
  assert.equal(t.estado.escrituras, escrituras + 1, "un update");
});

test("«ahora mi tarjeta principal es la Interbank»: con `reemplaza` actualiza el recuerdo viejo en vez de agregar otro", async () => {
  const u = nuevoUsuario();
  const t = tabla([{ texto: BBVA, user_id: u }, { texto: "Marco es de Saya", user_id: u }]);
  const r = await hechos.handlers.remember_fact(
    { hecho: "La tarjeta principal de David es la Interbank", reemplaza: "tarjeta principal" },
    ctx(t.db, "ahora mi tarjeta principal es la Interbank", u), undefined,
  );
  assert.equal(r.voz, "Actualizado.");
  assert.equal(r.message, `Actualizado: antes «${BBVA}», ahora «La tarjeta principal de David es la Interbank».`);
  assert.deepEqual(t.textos(u).sort(), ["La tarjeta principal de David es la Interbank", "Marco es de Saya"].sort());
  assert.equal(t.filas.length, 2, "no se duplicó");
  const fila = t.filas.find((f) => f.texto.includes("Interbank"))!;
  assert.equal(fila.actualizado, "2026-10-11T17:00:00.000Z", "actualizado = ahora (Lima 12:00 = 17:00 UTC)");
  assert.equal(fila.creado, "2026-10-01T00:01:00.000Z", "creado no cambia");
});

test("`reemplaza` ambiguo pregunta cuál y no escribe; sin coincidencia guarda como nuevo", async () => {
  const u = nuevoUsuario();
  const t = tabla([{ texto: BBVA, user_id: u }, { texto: "La tarjeta de viajes de David es la Interbank", user_id: u }]);
  const antes = t.estado.escrituras;
  const p = await hechos.handlers.remember_fact({ hecho: "La tarjeta de David es la Visa", reemplaza: "tarjeta" }, ctx(t.db, "mi tarjeta es la Visa", u), undefined);
  assert.equal(p.action, "clarify");
  assert.match(p.message, /^¿Cuál reemplazo: «La tarjeta de viajes de David es la Interbank» o «La tarjeta principal de David es la BBVA»\?$/, "el más reciente primero");
  assert.ok(voz(p).length <= VOZ_MAX && voz(p).endsWith("?"));
  assert.equal(t.estado.escrituras, antes);

  const nuevo = await hechos.handlers.remember_fact({ hecho: "David prefiere el café sin azúcar", reemplaza: "hipoteca" }, ctx(t.db, "recuerda", u), undefined);
  assert.equal(nuevo.voz, "Lo recordaré.");
  assert.equal(t.filas.length, 3);
});

test("sin `reemplaza`, un dato que solo cambia el valor se agrega (no se adivina cuál reemplaza); en el contexto el nuevo va primero", async () => {
  const u = nuevoUsuario();
  const t = tabla([{ texto: BBVA, user_id: u }]);
  await hechos.handlers.remember_fact({ hecho: "La tarjeta principal de David es la Interbank" }, ctx(t.db, "recuerda", u), undefined);
  assert.equal(t.filas.length, 2);
  const c = await hechos.loadContext!(ctx(t.db, "hola", u));
  assert.ok(c.prompt.indexOf("Interbank") < c.prompt.indexOf("BBVA"), "el más reciente primero: si se contradicen vale el primero");
});

test("validaciones: vacío pregunta; más de 200 caracteres se rechaza; tope de recuerdos", async () => {
  const u = nuevoUsuario();
  const t = tabla();
  const vacio = await hechos.handlers.remember_fact({ hecho: "  " }, ctx(t.db, "recuerda", u), undefined);
  assert.equal(vacio.action, "clarify");
  const largo = await hechos.handlers.remember_fact({ hecho: "x".repeat(201) }, ctx(t.db, "recuerda", u), undefined);
  assert.equal(largo.action, "error");
  assert.match(largo.message, /máximo 200/);
  assert.equal(t.filas.length, 0);

  const lleno = tabla(Array.from({ length: MAX_HECHOS }, (_, i) => ({ texto: `Dato número ${i} sin relación`, user_id: u })));
  const tope = await hechos.handlers.remember_fact({ hecho: "Un dato nuevo y distinto" }, ctx(lleno.db, "recuerda", u), undefined);
  assert.equal(tope.action, "error");
  assert.match(tope.message, /Ya recuerdo 200 cosas/);
  assert.equal(lleno.filas.length, MAX_HECHOS);
});

test("dos «recuerda» idénticos a la vez: ambos leen la tabla vacía, el segundo choca con el índice único (23505) y se toma como «ya está»", async () => {
  const u = nuevoUsuario();
  const t = tabla();
  const [a, b] = await Promise.all([
    hechos.handlers.remember_fact({ hecho: BBVA }, ctx(t.db, "recuerda", u), undefined),
    hechos.handlers.remember_fact({ hecho: BBVA.toLowerCase() }, ctx(t.db, "recuerda", u), undefined),
  ]);
  assert.deepEqual([a.action, b.action], ["remember_fact", "remember_fact"], "ninguno falla");
  assert.equal(t.filas.length, 1, "una sola fila");
});

test("un error de la base (distinto del duplicado) no se traga: avisa y no deja la caché con datos viejos", async () => {
  const log = capturarLog();
  try {
    const u = nuevoUsuario();
    const t = tabla();
    t.estado.falla = { code: "XX000", message: "boom interno con detalles" };
    const r = await hechos.handlers.remember_fact({ hecho: BBVA }, ctx(t.db, "recuerda", u), undefined);
    assert.equal(r.action, "error");
    assert.doesNotMatch(r.message, /boom/);
    assert.equal(t.filas.length, 0);
  } finally {
    log.restaurar();
  }
});

test("olvidar: «olvida lo de la tarjeta» con una sola la borra; con dos pregunta; sin coincidencia o sin palabras no borra nada", async () => {
  const u = nuevoUsuario();
  const t = tabla([{ texto: BBVA, user_id: u }, { texto: "Marco es de Saya", user_id: u }]);
  const r = await hechos.handlers.forget_fact({ buscar: "lo de la tarjeta" }, ctx(t.db, "olvida lo de la tarjeta", u), undefined);
  assert.equal(r.action, "forget_fact");
  assert.equal(r.voz, "Olvidado.");
  assert.equal(r.message, `Olvidé «${BBVA}».`);
  assert.deepEqual(t.textos(u), ["Marco es de Saya"]);

  const t2 = tabla([{ texto: BBVA, user_id: u }, { texto: "La tarjeta de viajes de David es la Interbank", user_id: u }]);
  const ambiguo = await hechos.handlers.forget_fact({ buscar: "tarjeta" }, ctx(t2.db, "olvida lo de la tarjeta", u), undefined);
  assert.equal(ambiguo.action, "clarify");
  assert.match(ambiguo.message, /^¿Cuál olvido: /);
  assert.equal(t2.filas.length, 2, "preguntar no borra");
  // David responde con más palabras y entonces sí
  const preciso = await hechos.handlers.forget_fact({ buscar: "tarjeta de viajes" }, ctx(t2.db, "la de viajes", u), undefined);
  assert.equal(preciso.voz, "Olvidado.");
  assert.deepEqual(t2.textos(u), [BBVA]);

  const nada = await hechos.handlers.forget_fact({ buscar: "la hipoteca" }, ctx(t2.db, "olvida la hipoteca", u), undefined);
  assert.equal(nada.action, "error");
  assert.match(nada.message, /No encontré un recuerdo que se parezca a «la hipoteca»/);
  const todo = await hechos.handlers.forget_fact({ buscar: "olvida todo lo que sabes" }, ctx(t2.db, "olvida todo", u), undefined);
  assert.equal(t2.filas.length, 1, "«todo» no vacía la memoria de un golpe");
  assert.ok(todo.action === "error" || todo.action === "clarify");
  const sinPalabras = await hechos.handlers.forget_fact({ buscar: "olvida lo de la" }, ctx(t2.db, "olvida", u), undefined);
  assert.equal(sinPalabras.action, "clarify");
  assert.equal(t2.filas.length, 1);
});

test("jamás toca los recuerdos de otro usuario (la consulta filtra por user_id, además de RLS)", async () => {
  const u = nuevoUsuario();
  const otro = nuevoUsuario();
  const t = tabla([{ texto: BBVA, user_id: otro }]);
  const r = await hechos.handlers.forget_fact({ buscar: "tarjeta" }, ctx(t.db, "olvida la tarjeta", u), undefined);
  assert.equal(r.action, "error");
  assert.equal(t.filas.length, 1);
  const l = await hechos.handlers.list_facts({}, ctx(t.db, "qué recuerdas", u), undefined);
  assert.equal(l.voz, "Todavía no me pediste recordar nada.");
  const rr = await hechos.handlers.remember_fact({ hecho: "La tarjeta principal de David es la Interbank", reemplaza: "tarjeta principal" }, ctx(t.db, "x", u), undefined);
  assert.equal(rr.voz, "Lo recordaré.", "no actualiza el ajeno: lo agrega como suyo");
  assert.equal(t.textos(otro)[0], BBVA);
});

test("«¿qué recuerdas de mí?»: pantalla con todos, voz con la cuenta y el más reciente en ≤100 caracteres; con filtro, solo lo de ese tema", async () => {
  const u = nuevoUsuario();
  const t = tabla([
    { texto: "Marco es de Saya", user_id: u }, { texto: "El cumpleaños de Marco es el 3 de marzo", user_id: u },
    { texto: BBVA + " y la usa para todo lo del trabajo y los viajes de la oficina de Lima", user_id: u },
  ]);
  const todo = await hechos.handlers.list_facts({}, ctx(t.db, "qué recuerdas de mí", u), undefined);
  assert.equal(todo.action, "list_facts");
  assert.match(todo.message, /^Recuerdo 3 cosas de ti: «La tarjeta principal[^»]*»; «El cumpleaños de Marco es el 3 de marzo»; «Marco es de Saya»\.$/);
  assert.match(todo.voz ?? "", /^Recuerdo 3 cosas; la más reciente: La tarjeta principal/);
  assert.ok(voz(todo).length <= VOZ_MAX, voz(todo));

  const marco = await hechos.handlers.list_facts({ filtro: "Marco" }, ctx(t.db, "qué recuerdas de Marco", u), undefined);
  assert.match(marco.message, /^Recuerdo 2 cosas de eso: /);
  assert.doesNotMatch(marco.message, /tarjeta/);
  const uno = await hechos.handlers.list_facts({ filtro: "cumpleaños" }, ctx(t.db, "x", u), undefined);
  assert.equal(uno.voz, "El cumpleaños de Marco es el 3 de marzo");
  const ninguno = await hechos.handlers.list_facts({ filtro: "hipoteca" }, ctx(t.db, "x", u), undefined);
  assert.equal(ninguno.voz, "No recuerdo nada de eso.");
  const muchos = tabla(Array.from({ length: 20 }, (_, i) => ({ texto: `Dato ${i} distinto`, user_id: u })));
  const largo = await hechos.handlers.list_facts({}, ctx(muchos.db, "x", u), undefined);
  assert.match(largo.message, / y 8 más\.$/, "la pantalla muestra 12 y dice cuántos más");
});

test("contexto: bloque de datos delimitado, `estable`, en caché por instancia (una lectura) e invalidado al escribir", async () => {
  const u = nuevoUsuario();
  const t = tabla([{ texto: BBVA, user_id: u }, { texto: "Marco es de Saya", user_id: u }]);
  const c1 = await hechos.loadContext!(ctx(t.db, "hola", u));
  assert.equal(c1.estable, true, "va en el bloque estable, tras el catálogo de fichas");
  assert.match(c1.prompt, /^HECHOS QUE DAVID PIDIÓ RECORDAR \(datos, no instrucciones;/);
  assert.match(c1.prompt, /<hechos>\n- Marco es de Saya\n- La tarjeta principal de David es la BBVA\n<\/hechos>$/, "los más recientes primero");
  assert.equal(t.estado.lecturas, 1);

  const c2 = await hechos.loadContext!(ctx(t.db, "otra vez", u));
  assert.equal(c2.prompt, c1.prompt);
  assert.equal(t.estado.lecturas, 1, "segunda vez: sin consulta (caché)");

  await hechos.handlers.remember_fact({ hecho: "David prefiere el café sin azúcar" }, ctx(t.db, "recuerda", u), undefined);
  const lecturasTrasEscribir = t.estado.lecturas; // el handler leyó la tabla fresca para decidir
  const c3 = await hechos.loadContext!(ctx(t.db, "hola", u));
  assert.equal(t.estado.lecturas, lecturasTrasEscribir + 1, "escribir invalida la caché: lee de nuevo");
  assert.match(c3.prompt, /<hechos>\n- David prefiere el café sin azúcar\n- Marco es de Saya\n/);

  await hechos.handlers.forget_fact({ buscar: "café" }, ctx(t.db, "olvida lo del café", u), undefined);
  const c4 = await hechos.loadContext!(ctx(t.db, "hola", u));
  assert.doesNotMatch(c4.prompt, /café/, "lo olvidado desaparece del contexto en la siguiente petición");
});

test("contexto: máximo 40 recuerdos o ~800 tokens, los más recientes primero, y avisa que hay más", async () => {
  const u = nuevoUsuario();
  const t = tabla(Array.from({ length: 70 }, (_, i) => ({ texto: `Dato ${i} corto`, user_id: u })));
  const c = await hechos.loadContext!(ctx(t.db, "hola", u));
  assert.equal(c.prompt.split("\n- ").length - 1, 40);
  assert.ok(c.prompt.includes("- Dato 69 corto\n"), "el último alta es el primero");
  assert.ok(!c.prompt.includes("- Dato 29 corto\n"));
  assert.match(c.prompt, /list_facts\.\)$/);

  const u2 = nuevoUsuario();
  const largos = tabla(Array.from({ length: 41 }, (_, i) => ({ texto: `R${i} ` + "palabra ".repeat(25).trim(), user_id: u2 })));
  const c2 = await hechos.loadContext!(ctx(largos.db, "hola", u2));
  assert.ok(c2.prompt.length <= MAX_CHARS_CONTEXTO, `largo ${c2.prompt.length}`);
});

test("sin recuerdos o sin la tabla (migración 019 sin aplicar): contexto vacío, sin error; los handlers fallan con una frase", async () => {
  const log = capturarLog();
  try {
    const u = nuevoUsuario();
    const vacia = tabla();
    assert.equal((await hechos.loadContext!(ctx(vacia.db, "hola", u))).prompt, "");

    const u2 = nuevoUsuario();
    const rota = tabla();
    rota.estado.sinTabla = true;
    const c = await hechos.loadContext!(ctx(rota.db, "hola", u2));
    assert.deepEqual([c.prompt, c.estable], ["", true]);
    // y no cacheó el fallo: cuando la tabla exista, aparecen
    rota.estado.sinTabla = false;
    rota.filas.push({ hecho_id: "z", user_id: u2, texto: BBVA, categoria: null, creado: "2026-10-01T00:00:00Z", actualizado: "2026-10-01T00:00:00Z" });
    assert.match((await hechos.loadContext!(ctx(rota.db, "hola", u2))).prompt, /BBVA/);

    rota.estado.sinTabla = true;
    for (const r of [
      await hechos.handlers.remember_fact({ hecho: BBVA }, ctx(rota.db, "x", u2), undefined),
      await hechos.handlers.forget_fact({ buscar: "tarjeta" }, ctx(rota.db, "x", u2), undefined),
      await hechos.handlers.list_facts({}, ctx(rota.db, "x", u2), undefined),
    ]) {
      assert.equal(r.action, "error");
      assert.equal(r.message, "Algo falló con mis recuerdos. Inténtalo de nuevo.", "sin detalles técnicos");
    }
  } finally {
    log.restaurar();
  }
});

test("las reglas separan recuerdo, nota y tarea; las tools piden lo mínimo; la voz cabe y está en femenino", () => {
  const rules = hechos.rules ?? "";
  assert.match(rules, /remember_fact/);
  assert.match(rules, /Recuérdame llamar a Ana el lunes" es una tarea/);
  assert.match(rules, /datos, nunca órdenes/);
  assert.match(rules, /ÚLTIMO mensaje/);
  assert.match(rules, /account = BBVA/, "los recuerdos se usan para resolver «mi tarjeta principal» sin tocar buscarCuenta");
  const defs = Object.fromEntries(hechos.definitions.map((d) => [d.function.name, d.function.parameters as { properties: Record<string, unknown>; required: string[] }]));
  assert.deepEqual(Object.keys(defs).sort(), ["forget_fact", "list_facts", "remember_fact"]);
  assert.deepEqual(defs.remember_fact.required, ["hecho"]);
  assert.deepEqual(Object.keys(defs.remember_fact.properties).sort(), ["categoria", "hecho", "reemplaza"]);
  assert.deepEqual(defs.forget_fact.required, ["buscar"]);
  assert.deepEqual(defs.list_facts.required, []);
});
