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

test("whatsapp_contact: un teléfono que David no dictó se ignora y NO se escribe a ese número (se pide el número)", async () => {
  const { r } = await ejecutar("whatsapp_contact", { nombre: "Pedro", mensaje: "Hola", telefono: "999 111 222" }, "Escríbele a Pedro que hola");
  assert.equal(r.action, "clarify");
  assert.equal(r.message, "No tengo a Pedro guardado. Dime su número y te dejo el WhatsApp.");
  sinAccion(r);
  const raro = await ejecutar("whatsapp_contact", { nombre: "Pedro", telefono: "12345" }, "Escríbele a Pedro al 12345");
  assert.equal(raro.r.action, "clarify");
  sinAccion(raro.r);
  // David sí dijo un número, pero NO el que mandó el modelo (un dígito cambiado): se avisa y no se usa ninguno.
  const distinto = await ejecutar("whatsapp_contact", { nombre: "Pedro", mensaje: "Hola", telefono: "999 111 223" }, "Escríbele a Pedro al 999 111 222 que hola");
  assert.equal(distinto.r.action, "clarify");
  assert.match(distinto.r.message, /No estoy segura del número/);
  sinAccion(distinto.r);
});

// --- A quién se escribe: la agenda gana y un número solo vale si está en el mensaje ACTUAL ----------------------------------------
test("un número de un turno ANTERIOR no vale: «Escríbele a Pedro» con el número de Juan antes no se lo manda a Juan", async () => {
  const juan = fila("9", "Juan", "+51955111222", "de Saya");
  const anteriores = ["Guarda a Juan con el 955 111 222", "Perfecto"];
  for (const fn of ["whatsapp_contact", "call_contact"]) {
    // el modelo "recuerda" el número del turno anterior y lo pasa como telefono
    const { r } = await ejecutar(fn, { nombre: "Pedro", mensaje: "Hola", telefono: "955 111 222" }, `Escríbele a Pedro`, [...AGENDA, juan], anteriores);
    assert.equal(r.action, "clarify", fn);
    sinAccion(r);
    assert.doesNotMatch(JSON.stringify(r), /955|51955111222/, `${fn}: el número de Juan no aparece en ninguna parte`);
    assert.match(r.message, /No tengo a Pedro guardado/);
  }
  // Y sin nombre alguno tampoco: solo pide a quién.
  const sinNombre = await ejecutar("call_contact", { telefono: "955 111 222" }, "Llama", [...AGENDA, juan], anteriores);
  assert.equal(sinNombre.r.message, "¿A quién?");
  sinAccion(sinNombre.r);
  // En cambio create_contact SÍ contrasta con los turnos anteriores (el número llegó antes de aclarar la relación).
  const alta = await ejecutar("create_contact", { nombre: "Pedro", telefono: "955 111 222", relacion: "del club" }, "es del club", AGENDA, ["Guarda a Pedro con el 955 111 222"]);
  assert.equal(alta.r.action, "create_contact");
});

test("si el nombre está en la agenda, SIEMPRE gana el número de la agenda (aunque David dicte otro)", async () => {
  const { r } = await ejecutar("whatsapp_contact", { nombre: "José", mensaje: "Hola", telefono: "955 000 999" }, "Escríbele a José al 955 000 999 que hola");
  assert.equal(r.action, "whatsapp_contact");
  assert.equal(r.accion?.url, "https://api.whatsapp.com/send?phone=51966555666&text=Hola");
  assert.doesNotMatch(JSON.stringify(r), /955000999|955 000 999/);
  const llamar = await ejecutar("call_contact", { nombre: "José", telefono: "955 000 999" }, "Llama a José al 955 000 999");
  assert.equal(llamar.r.accion?.url, "tel:+51966555666");
});

test("nombres parecidos NO se confunden en la tool: «Escríbele a Juana» nunca va a Juan", async () => {
  const parecidos = [fila("a", "Juan", "+51944000011"), fila("b", "Luis", "+51944000012"), fila("c", "Daniel", "+51944000013"), fila("d", "Marco", "+51944000014")];
  for (const [dicho, guardado] of [["Juana", "Juan"], ["Luisa", "Luis"], ["Daniela", "Daniel"], ["Marcos", "Marco"]]) {
    for (const fn of ["whatsapp_contact", "call_contact", "find_contact"]) {
      const { r } = await ejecutar(fn, { nombre: dicho, mensaje: "Hola" }, `Escríbele a ${dicho}`, parecidos);
      assert.equal(r.action, "clarify", `${fn} ${dicho}→${guardado}`);
      sinAccion(r);
      assert.match(r.message, new RegExp(`No tengo a ${dicho} guardado`));
      assert.doesNotMatch(JSON.stringify(r), /9440000/);
    }
  }
});

// --- Un número dentro de `nombre` nunca se dice --------------------------------------------------------------------------------
/** Cuenta DÍGITOS, no separadores: «999/888/777» o «999_888_777» no esconden un teléfono. Menos de 6 dígitos es una hora o una cantidad. */
const digitosDe = (s: string) => (s.match(/\d/g) ?? []).length;
function sinDigitos(r: ToolResult, etiqueta: string) {
  const texto = `${r.message}\n${r.voz ?? ""}\n${loQueSeDice(r)}`;
  for (const parte of [r.message, r.voz ?? "", loQueSeDice(r)]) assert.ok(digitosDe(parte) < 6, `${etiqueta}: ${texto}`);
  assert.ok(prepararVoz(loQueSeDice(r)).length <= VOZ_MAX, etiqueta);
}

test("un número en `nombre`: message y voz dicen «ese número», nunca los dígitos, en las tres tools y en todos los caminos", async () => {
  const nombres = ["999 888 777", "999888777", "+51 999-888-777", "Pedro 999888777", "(01) 234 5678"];
  for (const nombre of nombres) {
    for (const fn of ["whatsapp_contact", "call_contact", "find_contact"]) {
      // 1) David no dictó ningún número: se pide
      const sin = await ejecutar(fn, { nombre, mensaje: "Hola" }, "Hazlo");
      sinAccion(sin.r);
      sinDigitos(sin.r, `${fn} «${nombre}» sin dictar`);
      // 2) David lo dictó en este mensaje: se usa tal cual y se dice «ese número» (o el nombre sin el número)
      const dictado = nombre.replace(/^Pedro /, "");
      const con = await ejecutar(fn, { nombre, mensaje: "Hola" }, `Hazlo con el ${dictado}`);
      sinDigitos(con.r, `${fn} «${nombre}» dictado`);
      if (fn !== "find_contact" && /^(?:\+?51|9|\()/.test(dictado) && nombre !== "(01) 234 5678") {
        assert.equal(con.r.action, fn, `${fn} «${nombre}»`);
        assert.match(con.r.accion?.url ?? "", /51999888777/);
        assert.match(con.r.message, /ese número|Pedro/);
      }
    }
  }
  // con el nombre real y el teléfono aparte
  const mixto = await ejecutar("whatsapp_contact", { nombre: "Pedro", telefono: "999 888 777", mensaje: "Hola" }, "Escríbele a Pedro al 999 888 777 que hola");
  assert.equal(mixto.r.action, "whatsapp_contact");
  assert.equal(mixto.r.message, "WhatsApp para Pedro: «Hola»");
  assert.equal(mixto.r.accion?.numero, "+51 999 888 777");
});

test("un contacto GUARDADO con un número por nombre (así llegan los que el celular no tiene nombrados) tampoco se dice en voz alta", async () => {
  // Se encuentra por su apodo; su nombre es un teléfono y la relación también.
  const agenda = [fila("x", "+51 999 888 777", "+51944000020", "999888777", ["Taller"]), fila("y", "Marco", "+51944000021", "de Saya")];
  for (const fn of ["find_contact", "whatsapp_contact", "call_contact"]) {
    const { r } = await ejecutar(fn, { nombre: "Taller", mensaje: "Hola" }, "Hazlo con el taller", agenda);
    assert.notEqual(r.action, "error", fn);
    assert.ok(r.accion, `${fn}: encontró al contacto por su apodo`);
    sinDigitos(r, fn);
    assert.match(r.message, /ese número/);
    assert.equal(r.accion?.contacto, "ese número", "la tarjeta tampoco repite el número como nombre");
  }
  // Dos con el mismo apodo y nombre-número: la pregunta no los repite.
  const dos = [fila("x", "+51 999 888 777", "+51944000020", null, ["Taller"]), fila("z", "999 888 777", "+51944000022", null, ["Taller"])];
  const { r: ambiguo } = await ejecutar("find_contact", { nombre: "Taller" }, "x", dos);
  assert.equal(ambiguo.action, "clarify");
  sinDigitos(ambiguo, "ambiguo");
});

test("las tools de WhatsApp y llamada no exigen `nombre` (David puede dictar solo un número); crear y buscar sí", () => {
  const req = (n: string) => contactos.definitions.find((d) => d.function.name === n)!.function.parameters.required as string[];
  assert.deepEqual(req("whatsapp_contact"), []);
  assert.deepEqual(req("call_contact"), []);
  assert.deepEqual(req("create_contact"), ["nombre"]);
  assert.deepEqual(req("find_contact"), ["nombre"]);
});

test("solo un número dictado, sin nombre: «Llama al 999 888 777» → botón con ese número", async () => {
  const { r } = await ejecutar("call_contact", { telefono: "999 888 777" }, "Llama al 999 888 777");
  assert.equal(r.action, "call_contact");
  assert.equal(r.accion?.url, "tel:+51999888777");
  assert.equal(r.message, "Llamar a ese número.");
  sinDigitos(r, "solo número");
  const w = await ejecutar("whatsapp_contact", { telefono: "999 888 777", mensaje: "Llego tarde" }, "Escríbele al 999 888 777 que llego tarde");
  assert.equal(w.r.accion?.url, "https://api.whatsapp.com/send?phone=51999888777&text=Llego%20tarde");
  assert.equal(w.r.accion?.numero, "+51 999 888 777");
  sinDigitos(w.r, "solo número whatsapp");
});

test("las reglas y la descripción de la tool piden el mensaje FIEL a lo que dijo David (sin saludos, frases ni emojis agregados)", () => {
  const def = contactos.definitions.find((d) => d.function.name === "whatsapp_contact")!.function.parameters.properties as Record<string, { description: string }>;
  for (const t of [contactos.rules ?? "", def.mensaje!.description]) {
    assert.match(t, /NO agregues|No agregues/);
    assert.match(t, /Llego 10 minutos tarde/);
    assert.match(t, /emojis/);
  }
  assert.doesNotMatch(contactos.rules ?? "", /redact/i, "ya no se le pide a Wabid que redacte");
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
test("un número con CUALQUIER separador en `nombre` («999/888/777», «999,888,777», «999–888–777», «999_888_777») no llega a message ni a voz", async () => {
  const nombres = ["999/888/777", "999,888,777", "999–888–777", "999_888_777", "999.888.777", "Pedro 999/888/777", "Pedro, 999_888_777", "999 / 888 / 777"];
  for (const nombre of nombres) {
    for (const fn of ["whatsapp_contact", "call_contact", "find_contact"]) {
      for (const texto of ["Hazlo", `Hazlo con el ${nombre}`]) {
        const { r } = await ejecutar(fn, { nombre, mensaje: "Hola", telefono: nombre.replace(/[^\d]/g, "") }, texto);
        sinDigitos(r, `${fn} «${nombre}» / «${texto}»`);
        assert.doesNotMatch(r.message + (r.voz ?? ""), /999|888|777/);
      }
    }
  }
  // Como contacto guardado (nombre y relación con separadores raros), encontrado por su apodo.
  const raro = [fila("r", "999/888/777", "+51944000030", "999_888_777", ["Taller"]), fila("s", "999,888,777", "+51944000031", "999–888–777", ["Taller"])];
  for (const fn of ["find_contact", "whatsapp_contact", "call_contact"]) {
    const { r } = await ejecutar(fn, { nombre: "Taller", mensaje: "Hola" }, "Hazlo con el taller", raro);
    sinDigitos(r, `${fn} guardados con separadores raros`);
    assert.equal(r.action, "clarify", "dos con el mismo apodo: se pregunta");
  }
  // Dar de alta con un número como nombre se rechaza sin repetirlo.
  for (const nombre of ["999/888/777", "999_888_777"]) {
    const { r, inserts } = await ejecutar("create_contact", { nombre, telefono: "999 888 777" }, "guarda a alguien con el 999 888 777", []);
    assert.equal(inserts.length, 0);
    sinDigitos(r, `create ${nombre}`);
  }
});

// --- A quién va: la relación dicha, el número dentro del mensaje y varios números -------------------------------------------------
test("«Escríbele a Marco del gimnasio» con SOLO «Marco de Saya» NO va a ese Marco: se pide el número", async () => {
  const solo = [fila("1", "Marco", "+51999888777", "de Saya"), fila("3", "Rosa Tarazona", "+51977333444", "mi madre")];
  for (const fn of ["whatsapp_contact", "call_contact", "find_contact"]) {
    const { r } = await ejecutar(fn, { nombre: "Marco", relacion: "del gimnasio", mensaje: "Hola" }, "Hazlo con Marco del gimnasio", solo);
    assert.equal(r.action, "clarify", fn);
    sinAccion(r);
    assert.match(r.message, /No tengo a Marco guardado/);
    assert.doesNotMatch(JSON.stringify(r), /999888777|999 888 777/);
  }
  // Con la relación que sí tiene, o sin decir ninguna, sí es él.
  const ok = await ejecutar("call_contact", { nombre: "Marco", relacion: "de Saya" }, "Llama a Marco de Saya", solo);
  assert.equal(ok.r.accion?.url, "tel:+51999888777");
  const sinRel = await ejecutar("call_contact", { nombre: "Marco" }, "Llama a Marco", solo);
  assert.equal(sinRel.r.accion?.url, "tel:+51999888777");
});

test("un número DENTRO del mensaje no es el destinatario: «dile a Ramiro que me llame al 999 111 222» no le escribe a ese número", async () => {
  const casos: { texto: string; args: Record<string, unknown> }[] = [
    { texto: "Escríbele a Pedro, el de Juan es 999 111 222", args: { nombre: "Pedro", telefono: "999 111 222", mensaje: "El de Juan es 999 111 222" } },
    { texto: "Dile a Ramiro que me llame al 999 111 222", args: { nombre: "Ramiro", telefono: "999 111 222", mensaje: "Llámame al 999 111 222" } },
    { texto: "Dile a Ramiro que me llame al 999 111 222", args: { nombre: "Ramiro", mensaje: "Llámame al 999-111-222" } }, // sin telefono: lo saca del nombre/ni existe
    { texto: "Dile a Ramiro que me llame al 999 111 222", args: { nombre: "Ramiro 999 111 222", mensaje: "Llámame al 999 111 222" } },
  ];
  for (const { texto, args } of casos) {
    const { r } = await ejecutar("whatsapp_contact", args, texto); // Pedro y Ramiro no están en la agenda
    assert.equal(r.action, "clarify", JSON.stringify(args));
    sinAccion(r);
    assert.doesNotMatch(JSON.stringify(r), /999111222|999 111 222/, "ni la acción ni la frase llevan ese número");
    assert.match(r.message, /No tengo a (Pedro|Ramiro) guardado|No encontré ese número/);
  }
  // Si David dicta aparte el número de quien recibe, ese sí vale (y el del contenido va en el texto).
  const dos = await ejecutar("whatsapp_contact", { nombre: "Ramiro", telefono: "955 000 111", mensaje: "Llámame al 999 111 222" }, "Escríbele a Ramiro al 955 000 111 que me llame al 999 111 222");
  assert.equal(dos.r.action, "whatsapp_contact");
  assert.match(dos.r.accion?.url ?? "", /^https:\/\/api\.whatsapp\.com\/send\?phone=51955000111&text=/);
  assert.equal(dos.r.accion?.texto, "Llámame al 999 111 222", "el contenido completo va a la tarjeta");
  assert.equal(dos.r.message, "WhatsApp para Ramiro: «Llámame al [número]»", "pero lo que vuelve al modelo lleva el número enmascarado");
  sinDigitos(dos.r, "dos números");
});

test("con José en la agenda, el número del contenido va en el texto y message lo enmascara", async () => {
  const { r } = await ejecutar("whatsapp_contact", { nombre: "José", mensaje: "Llámame al 999 111 222" }, "Dile a José que me llame al 999 111 222");
  assert.equal(r.action, "whatsapp_contact");
  assert.match(r.accion?.url ?? "", /phone=51966555666&text=Ll%C3%A1mame%20al%20999%20111%20222$/);
  assert.equal(r.message, "WhatsApp para José Luis Pérez: «Llámame al [número]»");
  sinDigitos(r, "contenido con número");
});

test("dos números distintos en lo dicho → se pide confirmación (whatsapp, call y create)", async () => {
  const texto = "Escríbele a Pedro al 999 111 222 y a Juan al 955 000 111";
  for (const fn of ["whatsapp_contact", "call_contact"]) {
    const { r } = await ejecutar(fn, { nombre: "Pedro", telefono: "999 111 222", mensaje: "Hola" }, texto);
    assert.equal(r.action, "clarify", fn);
    assert.match(r.message, /más de un número/);
    sinAccion(r);
    sinDigitos(r, fn);
  }
  const alta = await ejecutar("create_contact", { nombre: "Pedro", telefono: "999 111 222" }, "guarda a Pedro con el 999 111 222 y a Juan con el 955 000 111", []);
  assert.equal(alta.r.action, "clarify");
  assert.match(alta.r.message, /más de un número/);
  assert.equal(alta.inserts.length, 0);
});

test("create_contact: un número que aparece dentro del texto pero del turno equivocado no se guarda a nombre de otro", async () => {
  // El turno anterior más reciente con teléfono es el de Juan; el modelo trae el de otra persona.
  const { r, inserts } = await ejecutar("create_contact", { nombre: "Pedro", telefono: "999 111 222", relacion: "del club" }, "es del club", [], ["guarda a Pedro con el 999 111 222", "guarda a Juan con el 955 000 111"]);
  assert.equal(r.action, "error");
  assert.equal(inserts.length, 0);
});

// --- `nombre` sin nombre, teléfono numérico -----------------------------------------------------------------------------------------
test("si al quitar el número no queda ningún nombre («al», «el número») se trata como sin nombre: «Llamar a ese número», no «Llamar a al»", async () => {
  for (const nombre of ["al 999 888 777", "el número 999 888 777", "mi 999 888 777", "al"]) {
    const llamar = await ejecutar("call_contact", { nombre, telefono: "999 888 777" }, "Llama al 999 888 777");
    assert.equal(llamar.r.action, "call_contact", nombre);
    assert.equal(llamar.r.message, "Llamar a ese número.", nombre);
    assert.equal(llamar.r.accion?.contacto, "ese número", nombre);
    assert.equal(llamar.r.accion?.url, "tel:+51999888777");
    sinDigitos(llamar.r, nombre);
    const w = await ejecutar("whatsapp_contact", { nombre, telefono: "999 888 777", mensaje: "Hola" }, "Escríbele al 999 888 777 que hola");
    assert.equal(w.r.message, "WhatsApp para ese número: «Hola»", nombre);
  }
  // Sin número dictado, solo se pregunta a quién.
  const sin = await ejecutar("call_contact", { nombre: "al" }, "Llama");
  assert.equal(sin.r.message, "¿A quién?");
});

test("`telefono` numérico (999888777 sin comillas) también se entiende", async () => {
  const { r } = await ejecutar("call_contact", { nombre: "Pedro", telefono: 999888777 }, "Llama a Pedro al 999 888 777");
  assert.equal(r.action, "call_contact");
  assert.equal(r.accion?.url, "tel:+51999888777");
  const alta = await ejecutar("create_contact", { nombre: "Pedro", telefono: 999888777 }, "guarda a Pedro con el 999 888 777", []);
  assert.equal(alta.r.action, "create_contact");
});

test("las lecturas piden el orden con contacto_id de desempate y el tope de MAX_CONTACTOS", async () => {
  const lecturas: { orden: string[]; limite?: number }[] = [];
  const db = {
    from: () => {
      const rec = { orden: [] as string[], limite: undefined as number | undefined };
      // deno-lint-ignore no-explicit-any
      const b: any = {
        select: () => b, eq: () => b,
        order: (col: string) => ((rec.orden.push(col), b)),
        limit: (n: number) => ((rec.limite = n), b),
        then: (ok: (v: unknown) => unknown) => ((lecturas.push(rec)), Promise.resolve({ data: AGENDA, error: null }).then(ok)),
      };
      return b;
    },
  };
  await h.find_contact!({ nombre: "José" }, ctx(db, "x"), undefined);
  assert.deepEqual(lecturas[0]?.orden, ["nombre", "contacto_id"]);
  assert.equal(lecturas[0]?.limite, 1000, "el max_rows de PostgREST: una lectura trae todo");
});

test("la tarjeta muestra el nombre COMPLETO guardado, no lo que David dijo: «María» → «María José»", async () => {
  const agenda = [fila("m", "María José Quispe", "+51944000040", "prima"), fila("r", "Marco Roca", "+51944000041", "de Saya")];
  for (const [dicho, completo] of [["María", "María José Quispe"], ["Marco", "Marco Roca"]]) {
    for (const fn of ["whatsapp_contact", "call_contact", "find_contact"]) {
      const { r } = await ejecutar(fn, { nombre: dicho, mensaje: "Hola" }, `Hazlo con ${dicho}`, agenda);
      assert.equal(r.accion?.contacto, completo, `${fn}: ${dicho}`);
    }
  }
});

test("si la base rechaza el alta por el tope (23514), se dice el límite y no un error técnico", async () => {
  const f = fakeDb([], { errorInsert: { code: "23514", message: "contactos: tope de 1000 por usuario" } });
  const origen = console.error;
  console.error = () => {};
  try {
    const r = await h.create_contact!({ nombre: "Marco", telefono: "999 888 777" }, ctx(f.db, "guarda a Marco con el 999 888 777"), undefined);
    assert.equal(r.message, "Llegaste al límite de 1000 contactos. Borra alguno desde Contactos.");
  } finally {
    console.error = origen;
  }
});

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
