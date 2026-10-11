// node --experimental-strip-types --test supabase/functions/agent/tools/contactos.test.ts
// Handlers de contactos con una base falsa: nada toca Supabase. Se verifica QUÉ se inserta, QUÉ acción recibe la app y, sobre todo,
// que ni `message` ni `voz` (lo que vuelve al modelo como historial) ni el prompt llevan jamás un teléfono.
import "./testlib.ts"; // instala el Deno.env que leen los módulos al cargarse
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { contactos } from "./contactos.ts";
import { prepararVoz, VOZ_MAX } from "../../_shared/voz.ts";
import { loQueSeDice } from "../respuesta.ts";
import type { AgentContext, ToolResult } from "../types.ts";

type Fila = { contacto_id: string; nombre: string; alias: string[]; telefono: string; relacion: string | null };
const fila = (id: string, nombre: string, telefono: string, relacion: string | null = null, alias: string[] = []): Fila =>
  ({ contacto_id: id, nombre, telefono, relacion, alias });
const AGENDA: Fila[] = [
  fila("1", "Marco", "+51944100200", "de Saya"),
  fila("2", "Marco", "+51988111222", "del gimnasio"),
  fila("3", "Rosa Tarazona", "+51977333444", "mi madre", ["Mamá", "Mami"]),
  fila("4", "José Luis Pérez", "+51966555666", "dentista"),
];

function fakeDb(filas: Fila[], opciones: { errorLectura?: boolean; errorInsert?: { code?: string; message: string }; lanza?: boolean } = {}) {
  const inserts: { table: string; row: Record<string, unknown> }[] = [];
  const lecturas: { table: string; cols: string; userId?: unknown }[] = [];
  const db = {
    from: (table: string) => {
      if (opciones.lanza) throw new Error("conexión caída");
      let cols = "*";
      let userId: unknown;
      // deno-lint-ignore no-explicit-any
      const b: any = {
        select: (c: string) => ((cols = c), b),
        eq: (col: string, v: unknown) => ((userId = col === "user_id" ? v : userId), b),
        order: () => b,
        limit: () => b,
        insert: async (row: Record<string, unknown>) => {
          inserts.push({ table, row });
          return { error: opciones.errorInsert ?? null };
        },
        then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => {
          lecturas.push({ table, cols, userId });
          return Promise.resolve(opciones.errorLectura ? { data: null, error: { code: "42501", message: "denegado" } } : { data: filas, error: null }).then(ok, ko);
        },
      };
      return b;
    },
  };
  return { db, inserts, lecturas };
}
const ctx = (db: unknown, text: string, anteriores: string[] = []): AgentContext =>
  ({ supabase: db as AgentContext["supabase"], user: { id: "u1" } as AgentContext["user"], text, limaNow: new Date("2026-10-11T12:00:00Z"), anteriores });
const h = contactos.handlers;
type R = Awaited<ReturnType<(typeof h)[string]>>;
const ejecutar = (fn: string, args: Record<string, unknown>, text: string, filas: Fila[] = AGENDA, anteriores: string[] = []) => {
  const f = fakeDb(filas);
  return h[fn]!(args, ctx(f.db, text, anteriores), undefined).then((r) => ({ r, ...f }));
};

/** Todos los teléfonos de la agenda, en cada forma en que podrían colarse en una frase. */
const formas = (tels: string[]) => tels.flatMap((t) => [t, t.slice(1), t.slice(-9), `${t.slice(-9, -6)} ${t.slice(-6, -3)} ${t.slice(-3)}`, `${t.slice(-6)}`]);
const TELS = AGENDA.map((f) => f.telefono);
/** Lo que vuelve al modelo: `message` y la voz. */
const alModelo = (r: ToolResult) => `${r.message}\n${r.voz ?? ""}\n${loQueSeDice(r)}`;
function sinNumeros(r: ToolResult, extra: string[] = []) {
  const texto = alModelo(r);
  for (const f of formas([...TELS, ...extra])) assert.ok(!texto.includes(f), `«${f}» aparece en lo que vuelve al modelo: ${texto}`);
  assert.doesNotMatch(texto, /\d{5,}/, "ninguna cifra larga");
  assert.ok(prepararVoz(loQueSeDice(r)).length <= VOZ_MAX, "cabe en el tope de voz");
}
const sinAccion = (r: ToolResult) => assert.equal(r.accion, undefined, "no ofrece ningún botón");

// --- create_contact ---------------------------------------------------------------------------------------------------
test("create_contact: «Guarda a Marco con el 999 888 777, es de Saya» inserta lo normalizado y confirma sin el número", async () => {
  const { r, inserts } = await ejecutar("create_contact", { nombre: "Marco", telefono: "999 888 777", relacion: "es de Saya" }, "Guarda a Marco con el 999 888 777, es de Saya", []);
  assert.equal(r.action, "create_contact");
  assert.deepEqual(inserts, [{ table: "contactos", row: { user_id: "u1", nombre: "Marco", alias: [], telefono: "+51999888777", relacion: "de Saya" } }]);
  assert.equal(r.message, "Guardé a Marco (de Saya).");
  assert.equal(r.voz, "Listo, guardé a Marco.");
  sinNumeros(r, ["+51999888777"]);
  sinAccion(r);
});

test("create_contact: con apodos, y el número puede haberse dicho en el turno anterior", async () => {
  const { r, inserts } = await ejecutar(
    "create_contact", { nombre: "Rosa", telefono: "+57 300 123 4567", alias: ["Mamá", "mamá"] }, "sí, así", [],
    ["Guarda a Rosa con el +57 300 123 4567"],
  );
  assert.equal(r.action, "create_contact");
  assert.deepEqual(inserts[0]!.row, { user_id: "u1", nombre: "Rosa", alias: ["Mamá"], telefono: "+573001234567", relacion: null });
});

test("create_contact: un número que David no dijo NO se guarda (ni uno con un dígito cambiado)", async () => {
  for (const [tel, dictado] of [["999 888 777", "Guarda a Marco"], ["999 888 778", "Guarda a Marco con el 999 888 777"]] as const) {
    const { r, inserts } = await ejecutar("create_contact", { nombre: "Marco", telefono: tel }, dictado, []);
    assert.equal(r.action, "error", tel);
    assert.match(r.message, /No estoy segura del número/);
    assert.deepEqual(inserts, []);
  }
});

test("create_contact: falta el número → lo pregunta; número mal formado → lo dice; nada se inserta", async () => {
  const a = await ejecutar("create_contact", { nombre: "Marco" }, "Guarda a Marco, es de Saya", []);
  assert.equal(a.r.action, "clarify");
  assert.equal(a.r.message, "¿Cuál es su número?");
  const b = await ejecutar("create_contact", { nombre: "Marco", telefono: "999 888" }, "Guarda a Marco con el 999 888", []);
  assert.equal(b.r.action, "error");
  assert.match(b.r.message, /no está completo/);
  const c = await ejecutar("create_contact", { telefono: "999888777" }, "guarda el 999888777", []);
  assert.equal(c.r.message, "¿Cómo se llama?");
  assert.deepEqual([a.inserts, b.inserts, c.inserts], [[], [], []]);
});

test("create_contact: número repetido dice de quién es; un homónimo sin relación pregunta; ninguno de los dos inserta", async () => {
  const dup = await ejecutar("create_contact", { nombre: "Otro", telefono: "944 100 200" }, "Guarda a Otro con el 944 100 200");
  assert.equal(dup.r.action, "error");
  assert.equal(dup.r.message, "Ya tienes ese número guardado como Marco (de Saya).");
  const hom = await ejecutar("create_contact", { nombre: "José Luis Pérez", telefono: "955 000 111" }, "Guarda a José Luis Pérez con el 955 000 111");
  assert.equal(hom.r.action, "clarify");
  assert.match(hom.r.message, /Ya tienes a José Luis Pérez \(dentista\)/);
  assert.deepEqual([dup.inserts, hom.inserts], [[], []]);
  const ok = await ejecutar("create_contact", { nombre: "José Luis Pérez", telefono: "955 000 111", relacion: "primo" }, "Guarda a José Luis Pérez con el 955 000 111, es primo");
  assert.equal(ok.r.action, "create_contact");
  assert.equal(ok.inserts.length, 1);
});

test("create_contact: errores de la base se dicen sin tecnicismos", async () => {
  const f = fakeDb([], { errorInsert: { code: "23505", message: "duplicate key value violates unique constraint" } });
  const r = await h.create_contact!({ nombre: "Marco", telefono: "999 888 777" }, ctx(f.db, "guarda a Marco con el 999 888 777"), undefined);
  assert.equal(r.message, "Ya tienes ese número guardado.");
  const g = fakeDb([], { errorInsert: { code: "42501", message: "permission denied for table contactos" } });
  const r2 = await h.create_contact!({ nombre: "Marco", telefono: "999 888 777" }, ctx(g.db, "guarda a Marco con el 999 888 777"), undefined);
  assert.equal(r2.message, "No pude guardar el contacto ahora. Inténtalo de nuevo.");
  assert.doesNotMatch(r2.message, /permission|42501|contactos/);
});

// --- find_contact -----------------------------------------------------------------------------------------------------
test("find_contact: «¿cuál es el número de mi mamá?» → tarjeta con el número; la frase no lo lleva", async () => {
  const { r } = await ejecutar("find_contact", { nombre: "mi mamá" }, "¿Cuál es el número de mi mamá?");
  assert.equal(r.action, "find_contact");
  assert.deepEqual(r.accion, {
    tipo: "numero", contacto: "Rosa Tarazona", relacion: "mi madre", numero: "+51 977 333 444",
    url: "tel:+51977333444", urlWhatsapp: "https://api.whatsapp.com/send?phone=51977333444",
  });
  assert.equal(r.message, "Aquí está el contacto de Rosa Tarazona (mi madre).");
  assert.equal(r.voz, "Te dejo el número de Rosa Tarazona en pantalla.");
  sinNumeros(r);
});

test("find_contact: dos Marco → pregunta cuál (con la relación, sin números) y no ofrece botones", async () => {
  const { r } = await ejecutar("find_contact", { nombre: "Marco" }, "¿Cuál es el número de Marco?");
  assert.equal(r.action, "clarify");
  assert.equal(r.message, "Tengo a Marco (de Saya) y Marco (del gimnasio). ¿Cuál?");
  assert.equal(r.voz, "¿Cuál Marco: de Saya o del gimnasio?");
  sinAccion(r);
  sinNumeros(r);
});

test("find_contact: contesta «el de Saya» y la relación elige a uno", async () => {
  const { r } = await ejecutar("find_contact", { nombre: "Marco", relacion: "de Saya" }, "el de Saya", AGENDA, ["¿Cuál es el número de Marco?"]);
  assert.equal(r.action, "find_contact");
  assert.equal(r.accion?.url, "tel:+51944100200");
});

test("find_contact: sin coincidencia → pide el número, no adivina", async () => {
  const { r } = await ejecutar("find_contact", { nombre: "Pedro" }, "¿Cuál es el número de Pedro?");
  assert.equal(r.action, "clarify");
  assert.equal(r.message, "No tengo a Pedro guardado. Si me dices su número, lo anoto.");
  sinAccion(r);
  const sinNombre = await ejecutar("find_contact", {}, "el número");
  assert.equal(sinNombre.r.message, "¿De quién?");
});

// --- whatsapp_contact -------------------------------------------------------------------------------------------------
test("whatsapp_contact: «Escríbele a Rosa que llego 10 minutos tarde» → botón de WhatsApp con el texto; Wabid no firma", async () => {
  const { r, lecturas } = await ejecutar("whatsapp_contact", { nombre: "mi mamá", mensaje: "«Llego 10 minutos tarde»\n— Wabid" }, "Escríbele a mi mamá que llego 10 minutos tarde");
  assert.equal(r.action, "whatsapp_contact");
  assert.deepEqual(r.accion, {
    tipo: "whatsapp", contacto: "Rosa Tarazona", relacion: "mi madre", numero: "+51 977 333 444",
    url: "https://api.whatsapp.com/send?phone=51977333444&text=Llego%2010%20minutos%20tarde", texto: "Llego 10 minutos tarde",
  });
  assert.equal(r.message, "WhatsApp para Rosa Tarazona: «Llego 10 minutos tarde»");
  assert.equal(r.voz, "Listo, te dejo el WhatsApp de Rosa Tarazona.");
  sinNumeros(r);
  assert.deepEqual(lecturas.map((l) => [l.table, l.userId]), [["contactos", "u1"]], "una sola lectura, de la agenda de David");
});

test("whatsapp_contact: «Escríbele a José» sin mensaje abre el chat", async () => {
  const { r } = await ejecutar("whatsapp_contact", { nombre: "José" }, "Escríbele a José");
  assert.equal(r.accion?.url, "https://api.whatsapp.com/send?phone=51966555666");
  assert.equal(r.accion?.texto, undefined);
  assert.equal(r.message, "Chat de WhatsApp con José Luis Pérez.");
});

test("whatsapp_contact: emojis, tildes, saltos, & y # llegan intactos en la URL", async () => {
  const mensaje = "Llegué 😅 ¡ojo! Café & té #3\nSalgo a las 5";
  const { r } = await ejecutar("whatsapp_contact", { nombre: "José", mensaje }, "dile a José algo");
  const url = new URL(r.accion!.url);
  assert.equal(url.searchParams.get("text"), mensaje);
  assert.equal(url.searchParams.get("phone"), "51966555666");
  assert.ok(!r.accion!.url.includes("wa.me"));
});

test("whatsapp_contact: dos Marco → pregunta; con «el del gimnasio» (misma tool, mismo mensaje) elige al correcto", async () => {
  const msg = "Llego 10 minutos tarde";
  const a = await ejecutar("whatsapp_contact", { nombre: "Marco", mensaje: msg }, "Escríbele a Marco que llego 10 minutos tarde");
  assert.equal(a.r.action, "clarify");
  sinAccion(a.r);
  sinNumeros(a.r);
  const b = await ejecutar("whatsapp_contact", { nombre: "Marco", relacion: "el del gimnasio", mensaje: msg }, "el del gimnasio", AGENDA, ["Escríbele a Marco que llego 10 minutos tarde"]);
  assert.equal(b.r.action, "whatsapp_contact");
  assert.equal(b.r.accion?.url, "https://api.whatsapp.com/send?phone=51988111222&text=Llego%2010%20minutos%20tarde");
  assert.equal(b.r.accion?.relacion, "del gimnasio");
});

test("whatsapp_contact: sin coincidencia pide el número; con el número dictado se usa sin guardarlo", async () => {
  const a = await ejecutar("whatsapp_contact", { nombre: "Pedro", mensaje: "Hola" }, "Escríbele a Pedro que hola");
  assert.equal(a.r.action, "clarify");
  assert.equal(a.r.message, "No tengo a Pedro guardado. Dime su número y te dejo el WhatsApp.");
  sinAccion(a.r);
  const b = await ejecutar("whatsapp_contact", { nombre: "Pedro", mensaje: "Hola", telefono: "999 111 222" }, "es el 999 111 222", AGENDA, ["Escríbele a Pedro que hola"]);
  assert.equal(b.r.action, "whatsapp_contact");
  assert.equal(b.r.accion?.url, "https://api.whatsapp.com/send?phone=51999111222&text=Hola");
  assert.equal(b.r.accion?.numero, "+51 999 111 222");
  assert.equal(b.inserts.length, 0, "no se guarda sin que David lo pida");
  sinNumeros(b.r, ["+51999111222"]);
});

test("whatsapp_contact: un teléfono que David no dictó se ignora y NO se escribe a ese número", async () => {
  const { r } = await ejecutar("whatsapp_contact", { nombre: "Pedro", mensaje: "Hola", telefono: "999 111 222" }, "Escríbele a Pedro que hola");
  assert.equal(r.action, "clarify");
  assert.match(r.message, /No estoy segura del número/);
  sinAccion(r);
  const raro = await ejecutar("whatsapp_contact", { nombre: "Pedro", telefono: "12345" }, "Escríbele a Pedro al 12345");
  assert.equal(raro.r.action, "clarify");
  sinAccion(raro.r);
});

test("whatsapp_contact: un mensaje desbocado se rechaza antes de tocar la base", async () => {
  const { r, lecturas } = await ejecutar("whatsapp_contact", { nombre: "José", mensaje: "a".repeat(501) }, "dile a José algo largo");
  assert.equal(r.action, "error");
  assert.equal(lecturas.length, 0);
});

// --- call_contact -----------------------------------------------------------------------------------------------------
test("call_contact: «Llama a José» → botón tel:", async () => {
  const { r } = await ejecutar("call_contact", { nombre: "José" }, "Llama a José");
  assert.equal(r.action, "call_contact");
  assert.deepEqual(r.accion, { tipo: "llamar", contacto: "José Luis Pérez", relacion: "dentista", numero: "+51 966 555 666", url: "tel:+51966555666" });
  assert.equal(r.voz, "Listo, toca para llamar a José Luis Pérez.");
  sinNumeros(r);
});

test("call_contact: ambiguo y sin coincidencia preguntan; sin nombre pide a quién", async () => {
  const a = await ejecutar("call_contact", { nombre: "Marco" }, "Llama a Marco");
  assert.equal(a.r.action, "clarify");
  sinAccion(a.r);
  const b = await ejecutar("call_contact", { nombre: "Pedro" }, "Llama a Pedro");
  assert.equal(b.r.message, "No tengo a Pedro guardado. Dime su número y te dejo la llamada.");
  const c = await ejecutar("call_contact", {}, "Llama");
  assert.equal(c.r.message, "¿A quién?");
});

// --- Fallos ----------------------------------------------------------------------------------------------------------
test("si la base falla, se dice una frase útil y nunca se lanza", async () => {
  const f = fakeDb(AGENDA, { errorLectura: true });
  const origen = console.error;
  console.error = () => {};
  try {
    for (const fn of ["find_contact", "whatsapp_contact", "call_contact"]) {
      const r = await h[fn]!({ nombre: "José" }, ctx(f.db, "x"), undefined);
      assert.equal(r.action, "error", fn);
      assert.equal(r.message, "No pude leer tus contactos ahora. Inténtalo de nuevo.");
    }
    const c = await h.create_contact!({ nombre: "Marco", telefono: "999 888 777" }, ctx(f.db, "marco 999 888 777"), undefined);
    assert.equal(c.action, "error");
    const lanza = fakeDb(AGENDA, { lanza: true });
    const r = await h.find_contact!({ nombre: "José" }, ctx(lanza.db, "x"), undefined);
    assert.equal(r.message, "Algo falló con tus contactos. Inténtalo de nuevo.");
    assert.doesNotMatch(r.message, /conexión/);
  } finally {
    console.error = origen;
  }
});

// --- Privacidad del prompt ---------------------------------------------------------------------------------------------
test("PRIVACIDAD: el módulo no aporta contexto al prompt, y sus reglas y tools no llevan ningún número", () => {
  assert.equal(contactos.loadContext, undefined, "sin loadContext: la agenda no viaja al modelo en ningún pedido");
  const prompt = [contactos.rules, JSON.stringify(contactos.definitions)].join("\n");
  assert.doesNotMatch(prompt, /\d{4,}/, "ni cifras largas");
  assert.doesNotMatch(prompt, /\+\d/);
  for (const f of formas(TELS)) assert.ok(!prompt.includes(f));
});

test("PRIVACIDAD: ningún módulo que arma el prompt (loadContext) lee la tabla de contactos", () => {
  const AQUI = dirname(fileURLToPath(import.meta.url));
  const RAIZ = join(AQUI, "..", "..", "..");
  const lectores = readdirSync(RAIZ, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && /\.(ts|tsx)$/.test(e.name) && !/\.test\.|testlib/.test(e.name))
    .map((e) => join(e.parentPath, e.name))
    .filter((f) => /["'`]contactos["'`]/.test(readFileSync(f, "utf8")))
    .map((f) => relative(RAIZ, f).replaceAll("\\", "/"));
  assert.deepEqual(lectores, ["functions/agent/tools/contactos.ts"], "solo los handlers de contactos tocan la tabla");
});

test("PRIVACIDAD: lo que el cliente guarda para el historial (message) nunca trae el número, en ningún camino", async () => {
  const casos: [string, Record<string, unknown>, string][] = [
    ["find_contact", { nombre: "mamá" }, "número de mamá"], ["find_contact", { nombre: "Marco" }, "número de Marco"], ["find_contact", { nombre: "Pedro" }, "número de Pedro"],
    ["whatsapp_contact", { nombre: "José", mensaje: "Hola" }, "escríbele a José"], ["whatsapp_contact", { nombre: "Marco", mensaje: "Hola" }, "escríbele a Marco"],
    ["call_contact", { nombre: "José" }, "llama a José"], ["call_contact", { nombre: "Marco" }, "llama a Marco"],
    ["create_contact", { nombre: "Marco", telefono: "999 888 777", relacion: "de Saya" }, "marco 999 888 777"],
    ["create_contact", { nombre: "Nuevo", telefono: "955 000 111" }, "guarda a Nuevo con el 955 000 111"],
  ];
  for (const [fn, args, texto] of casos) {
    const { r } = await ejecutar(fn, args, texto);
    sinNumeros(r, ["+51955000111"]);
    if (r.accion) assert.ok(r.accion.url.length > 0 && JSON.stringify(r).includes(r.accion.numero), "el número sí viaja, pero en la acción");
  }
});

// --- Registro ---------------------------------------------------------------------------------------------------------
// registry.ts no se puede cargar en Node (sus módulos importan jsr:), así que se lee su código: el módulo está en la lista y
// ninguna otra tool se llama igual (index.ts lanza al arrancar si dos módulos repiten un nombre).
test("el módulo está registrado y sus tools no chocan con las de otros", () => {
  const AQUI = dirname(fileURLToPath(import.meta.url));
  const registry = readFileSync(join(AQUI, "..", "registry.ts"), "utf8");
  assert.match(registry, /import \{ contactos \} from "\.\/tools\/contactos\.ts";/);
  assert.match(registry, /^\s+contactos,$/m);
  const fuentes = [registry, ...readdirSync(AQUI).filter((f) => /\.ts$/.test(f) && !/\.test\.|testlib/.test(f)).map((f) => readFileSync(join(AQUI, f), "utf8"))];
  const nombres = fuentes.flatMap((src) => [...src.matchAll(/\btool\(\s*"([a-z_]+)"/g)].map((m) => m[1]!));
  assert.equal(new Set(nombres).size, nombres.length, `dos módulos declaran una tool con el mismo nombre: ${nombres.join(", ")}`);
  for (const n of ["create_contact", "find_contact", "whatsapp_contact", "call_contact"]) assert.ok(nombres.includes(n), n);
  for (const d of contactos.definitions) assert.ok(typeof contactos.handlers[d.function.name] === "function", d.function.name);
});
