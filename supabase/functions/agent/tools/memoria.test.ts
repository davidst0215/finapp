// node --experimental-strip-types --test supabase/functions/agent/tools/memoria.test.ts
// search_memory de punta a punta con una base falsa y un modelo guionado: nada sale a la red. Se verifica qué material recibe el
// modelo que redacta (ficha + pendientes + pregunta completa), la segunda oportunidad y la línea de registro.
import test from "node:test";
import assert from "node:assert/strict";
import { capturarLog, doc, fakeDb, modeloGuionado, OWNER, tarea } from "./testlib.ts";

const { memoria } = await import("./memoria.ts");
type Row = Record<string, unknown>;

const FICHA_LOTA_VISION = "# LOTA Vision\n\n## Qué es\nEstadísticas por jugador desde video.\n\n## Estado actual\nCapturando partidos con dos cámaras; el modelo de seguimiento corre en la laptop.";
const VAULT: Record<string, Row[]> = {
  vault_sync: [{ user_id: OWNER, tree_sha: "sha1", synced_at: "2026-10-11T00:00:00Z", docs: 5, tasks: 5 }],
  vault_docs: [
    doc("60-wiki/proyectos/lota-vision.md", "ficha", "LOTA Vision", { cliente: "personal", proyecto: "lota-vision", padre: "lota", content: FICHA_LOTA_VISION }),
    doc("60-wiki/proyectos/lota.md", "ficha", "LOTA (hub)", { cliente: "personal", proyecto: "lota", content: "# LOTA\n\n## Qué es\nPlataforma del deporte amateur.\nVault: `20-projects/lota/pendientes.md`" }),
    doc("20-projects/lota/pendientes.md", "pendientes", "Pendientes — Lota"),
    doc("20-projects/tdv-bolsa-de-costos/pendientes.md", "pendientes", "Pendientes — Bolsa de costos"),
    doc("20-projects/cajon-desastre/pendientes.md", "pendientes", "Pendientes — Cajón desastre"),
  ],
  vault_tasks: [
    tarea("20-projects/lota/pendientes.md", "lota", 2, "Probar el seguimiento con la cancha nueva", { due: "2026-10-14", priority: 3 }),
    tarea("20-projects/lota/pendientes.md", "lota", 3, "Comprar el trípode", { status: "completed", done_on: "2026-10-08" }),
    tarea("20-projects/tdv-bolsa-de-costos/pendientes.md", "tdv-bolsa-de-costos", 2, "Validar la bolsa de septiembre", { due: "2026-10-09" }),
    tarea("20-projects/cajon-desastre/pendientes.md", "cajon-desastre", 2, "Algo suelto del cajón"),
  ],
};
const CATALOGO = [
  { slug: "lota-vision", path: "60-wiki/proyectos/lota-vision.md", title: "LOTA Vision", cliente: null },
  { slug: "lota", path: "60-wiki/proyectos/lota.md", title: "LOTA (hub)", cliente: null },
];

const ctxDe = (db: unknown, text: string) => ({
  supabase: db as never, user: { id: OWNER } as never, text, limaNow: new Date("2026-10-11T12:00:00Z"),
});
const buscar = (db: unknown, text: string, args: Record<string, unknown>, catalogo = CATALOGO) =>
  memoria.handlers.search_memory(args, ctxDe(db, text), { fichas: catalogo });

test("«¿en qué quedó lota visión?»: el modelo recibe la ficha, los pendientes reales de Lota y la pregunta completa", async () => {
  const { db } = fakeDb(VAULT, { vault_search: () => [] });
  const modelo = modeloGuionado(["Capturan partidos con dos cámaras y queda probar el seguimiento.\nUSADAS: 1,2"]);
  const log = capturarLog();
  try {
    const r = await buscar(db, "¿en qué quedó lota visión?", { fichas: ["lota-vision"], query: "lota visión estado" });
    assert.equal(r.action, "search_memory");
    assert.match(r.message, /Capturan partidos con dos cámaras/);
    assert.match(r.voz ?? "", /Capturan partidos/);

    assert.equal(modelo.peticiones.length, 1);
    const usuario = modelo.peticiones[0].messages[1].content;
    assert.match(usuario, /^Pregunta: ¿en qué quedó lota visión\?/, "la pregunta completa, no solo las palabras clave");
    assert.match(usuario, /\[1\] LOTA Vision[\s\S]*dos cámaras/);
    assert.match(usuario, /\[2\] Pendientes — Lota\nPendientes de Lota \(tareas reales, al 2026-10-11\):\nAbiertas \(1\):\n- Probar el seguimiento con la cancha nueva \(miércoles 14 oct\)/);
    assert.match(usuario, /Hechas \(las últimas\):\n- Comprar el trípode/);
    assert.doesNotMatch(usuario, /cajón|Algo suelto/, "el cajón nunca entra");
    assert.equal(modelo.peticiones[0].messages[0].content.includes("la asistente"), true);

    const ev = log.eventos().find((e) => e.evt === "memoria")!;
    assert.deepEqual([ev.fichas, ev.pendientes, ev.encontrado, ev.segunda, ev.recortada, ev.llm], [["lota-vision"], ["lota"], true, false, false, 1]);
    assert.equal(ev.query, "lota visión estado");
    assert.ok(Number(ev.hits) >= 2);
    assert.equal(JSON.stringify(ev).includes("quedó"), false, "el registro no lleva la pregunta de David");
  } finally {
    modelo.restaurar();
    log.restaurar();
  }
});

test("sin ficha elegida, un proyecto nombrado en la pregunta trae sus pendientes", async () => {
  const { db } = fakeDb(VAULT, { vault_search: (a) => (Array.isArray(a.p_kinds) && a.p_kinds[0] === "pendientes" ? [] : []) });
  const modelo = modeloGuionado(["Falta validar la bolsa de septiembre, vencida.\nUSADAS: 1"]);
  const log = capturarLog();
  try {
    await buscar(db, "¿cómo va tdv bolsa?", { fichas: [], query: "tdv bolsa" });
    const usuario = modelo.peticiones[0].messages[1].content;
    assert.match(usuario, /Pendientes de TDV bolsa de costos|Pendientes de Tdv Bolsa De Costos/);
    assert.match(usuario, /Validar la bolsa de septiembre \(Venció hace 2 días\)/);
    const ev = log.eventos().find((e) => e.evt === "memoria")!;
    assert.deepEqual(ev.pendientes, ["tdv-bolsa-de-costos"]);
  } finally {
    modelo.restaurar();
    log.restaurar();
  }
});

test("la búsqueda por palabras también encuentra docs de pendientes (por su título) y nunca trae el cajón", async () => {
  const { db, llamadas } = fakeDb(VAULT, {
    vault_search: (a) => Array.isArray(a.p_kinds) && a.p_kinds[0] === "pendientes"
      ? [{ path: "20-projects/cajon-desastre/pendientes.md", title: "Pendientes — Cajón desastre" }, { path: "20-projects/tdv-bolsa-de-costos/pendientes.md", title: "Pendientes — Bolsa de costos" }]
      : [],
  });
  const modelo = modeloGuionado(["Hay una vencida.\nUSADAS: 1"]);
  const log = capturarLog();
  try {
    await buscar(db, "¿qué hay de la bolsa de costos?", { fichas: [], query: "cierre mensual" });
    const pend = llamadas.find((l) => Array.isArray(l.args.p_kinds) && l.args.p_kinds[0] === "pendientes")!;
    assert.deepEqual([pend.args.p_query, pend.args.p_limit, pend.args.p_context], ["cierre mensual", 3, false]);
    const usuario = modelo.peticiones[0].messages[1].content;
    assert.match(usuario, /\[1\] Pendientes — Bolsa de costos/);
    assert.doesNotMatch(usuario, /Algo suelto del cajón/);
    assert.deepEqual(log.eventos().find((e) => e.evt === "memoria")!.pendientes, ["tdv-bolsa-de-costos"]);
  } finally {
    modelo.restaurar();
    log.restaurar();
  }
});

const FICHA_GRANDE = (() => {
  const relleno = (n: string) => `## ${n}\n${"línea de contexto sin la respuesta buscada. ".repeat(80)}`;
  return [
    "# Novafondos", "## Qué es\nSistema EAFC.", "## Estado actual\nTodo en marcha.", relleno("Historia"), relleno("Repos"), relleno("Arquitectura"), relleno("Datos"),
    relleno("Anexo 1"), relleno("Anexo 2"), "## Notas sueltas\n- 2026-09-27: sobre la cesión de cartera se decidió cobrarla al ceder el contrato, no al firmarlo.\n- Otra línea.",
  ].join("\n\n");
})();
const VAULT_GRANDE: Record<string, Row[]> = {
  ...VAULT,
  vault_docs: [doc("60-wiki/proyectos/novafondos.md", "ficha", "Novafondos", { cliente: "Novafondos", proyecto: "novafondos", content: FICHA_GRANDE })],
  vault_tasks: [],
};
const CAT_NOVA = [{ slug: "novafondos", path: "60-wiki/proyectos/novafondos.md", title: "Novafondos", cliente: "Novafondos" }];

test("«No lo encuentro» con una ficha recortada: segunda oportunidad con los fragmentos que coinciden", async () => {
  assert.ok(FICHA_GRANDE.length > 20_000, String(FICHA_GRANDE.length));
  const { db } = fakeDb(VAULT_GRANDE, { vault_search: () => [] });
  const modelo = modeloGuionado(["No lo encuentro en tus fichas.", "La cesión se cobra al ceder el contrato, no al firmarlo.\nUSADAS: 1"]);
  const log = capturarLog();
  try {
    const r = await buscar(db, "¿qué decidimos sobre la cesión en novafondos?", { fichas: ["novafondos"], query: "cesión decisión" }, CAT_NOVA);
    assert.match(r.message, /La cesión se cobra al ceder el contrato/);
    assert.equal(modelo.peticiones.length, 2);
    const [primera, segunda] = modelo.peticiones.map((p) => p.messages[1].content);
    assert.ok(primera.length > 18_000 && !primera.includes("de fragmentos"), "la primera recibe la ficha recortada al tope");
    assert.match(primera, /\[ficha recortada\]/);
    assert.match(segunda, /de las fichas llegan solo los fragmentos/);
    assert.match(segunda, /sobre la cesión de cartera se decidió cobrarla al ceder/);
    assert.ok(segunda.length < 6_500, `la segunda es corta: ${segunda.length}`);
    const ev = log.eventos().find((e) => e.evt === "memoria")!;
    assert.deepEqual([ev.encontrado, ev.segunda, ev.recortada, ev.llm], [true, true, true, 2]);
    assert.equal(ev.tok_in, 2000);
  } finally {
    modelo.restaurar();
    log.restaurar();
  }
});

test("si la segunda también dice «No lo encuentro», se queda con «No lo encuentro» (sin tercera llamada)", async () => {
  const { db } = fakeDb(VAULT_GRANDE, { vault_search: () => [] });
  const modelo = modeloGuionado(["No lo encuentro en tus fichas.", "No lo encuentro en tus fichas.", "no debería pedirse"]);
  const log = capturarLog();
  try {
    const r = await buscar(db, "¿qué decidimos sobre la cesión?", { fichas: ["novafondos"], query: "cesión" }, CAT_NOVA);
    assert.match(r.message, /No lo encuentro/);
    assert.equal(modelo.peticiones.length, 2);
    const ev = log.eventos().find((e) => e.evt === "memoria")!;
    assert.deepEqual([ev.encontrado, ev.segunda], [false, true]);
  } finally {
    modelo.restaurar();
    log.restaurar();
  }
});

test("«No lo encuentro» con la ficha completa, o sin coincidencias que mostrar, no gasta una segunda llamada", async () => {
  const { db } = fakeDb(VAULT, { vault_search: () => [] });
  const modelo = modeloGuionado(["No lo encuentro en tus fichas."]);
  const log = capturarLog();
  try {
    await buscar(db, "¿qué costó la cámara?", { fichas: ["lota-vision"], query: "costo cámara" });
    assert.equal(modelo.peticiones.length, 1, "la ficha entra entera: no hay nada más que mostrar");
    const ev = log.eventos().find((e) => e.evt === "memoria")!;
    assert.deepEqual([ev.encontrado, ev.segunda, ev.recortada], [false, false, false]);
  } finally {
    modelo.restaurar();
    log.restaurar();
  }
  const { db: db2 } = fakeDb(VAULT_GRANDE, { vault_search: () => [] });
  const m2 = modeloGuionado(["No lo encuentro en tus fichas."]);
  const l2 = capturarLog();
  try {
    await buscar(db2, "¿y el palíndromo xyzzy?", { fichas: ["novafondos"], query: "palíndromo xyzzy" }, CAT_NOVA);
    assert.equal(m2.peticiones.length, 1, "ninguna parte de la ficha menciona lo preguntado");
  } finally {
    m2.restaurar();
    l2.restaurar();
  }
});

test("modelo caído: no se cae, dice las fichas encontradas, y el registro lo refleja", async () => {
  const { db } = fakeDb(VAULT, { vault_search: () => [] });
  const modelo = modeloGuionado([{ status: 500 }]);
  const log = capturarLog();
  try {
    const r = await buscar(db, "¿en qué quedó lota visión?", { fichas: ["lota-vision"], query: "lota visión" });
    assert.equal(r.action, "search_memory");
    assert.match(r.message, /Encontré \d+ fichas? sobre eso/);
    assert.equal(modelo.peticiones.length, 1);
  } finally {
    modelo.restaurar();
    log.restaurar();
  }
});

test("un `query` desbocado se acota antes de buscar y en el registro", async () => {
  const { db, llamadas } = fakeDb(VAULT, { vault_search: () => [] });
  const modelo = modeloGuionado(["Algo.\nUSADAS: 1"]);
  const log = capturarLog();
  try {
    await buscar(db, "¿en qué quedó lota?", { fichas: ["lota"], query: "lota estado ".repeat(300) });
    const busqueda = llamadas.find((l) => Array.isArray(l.args.p_kinds) ? l.args.p_kinds[0] !== "pendientes" : true)!;
    assert.ok(String(busqueda.args.p_query).length <= 160);
    assert.ok(String(log.eventos().find((e) => e.evt === "memoria")!.query).length <= 60);
  } finally {
    modelo.restaurar();
    log.restaurar();
  }
});

test("fichas inventadas o rutas se descartan; sin nada que buscar no inventa respuesta", async () => {
  const { db } = fakeDb({ ...VAULT, vault_docs: [] }, { vault_search: () => [] });
  const modelo = modeloGuionado([]);
  const log = capturarLog();
  try {
    const r = await buscar(db, "¿qué es x?", { fichas: ["../../etc/passwd", "no-existe"], query: "x" });
    assert.match(r.message, /No encontré nada sobre eso|Todavía no tengo fichas/);
    assert.equal(modelo.peticiones.length, 0);
  } finally {
    modelo.restaurar();
    log.restaurar();
  }
});

test("ficha equivocada: «No lo encuentro» y la búsqueda por palabras encuentra OTRA ficha → segunda respuesta con ella", async () => {
  const otra = {
    path: "60-wiki/proyectos/novafondos-simulador.md", kind: "ficha", title: "Novafondos: simulador", cliente: "Novafondos", proyecto: "novafondos-simulador", padre: "novafondos",
    tags: [], links: [], score: 0.3, snippet: "", context: "la ⟦cesión⟧ se modela como 0,02 % al mes sobre el saldo cedido",
  };
  const { db, llamadas } = fakeDb(VAULT, {
    vault_search: (a) => (Array.isArray(a.p_kinds) ? [] : [{ ...otra }, { ...otra, path: "60-wiki/proyectos/lota-vision.md", title: "ya leída" }]),
  });
  const modelo = modeloGuionado(["No lo encuentro en tus fichas.", "La cesión se modela al 0,02 por ciento mensual.\nUSADAS: 2"]);
  const log = capturarLog();
  try {
    const r = await buscar(db, "¿qué decidimos sobre la cesión?", { fichas: ["lota-vision"], query: "cesión" });
    assert.match(r.message, /^La cesión se modela al 0,02 por ciento mensual\. Fuente: Novafondos, simulador\./);
    assert.equal(modelo.peticiones.length, 2);
    const segunda = modelo.peticiones[1].messages[1].content;
    assert.match(segunda, /la cesión se modela como 0,02 % al mes/);
    assert.doesNotMatch(segunda, /ya leída/, "lo que ya vio la primera no se repite");
    const ampliada = llamadas.filter((l) => l.args.p_kinds === null);
    assert.equal(ampliada.length, 1);
    assert.deepEqual([ampliada[0].args.p_limit, ampliada[0].args.p_context], [4, true]);
    const ev = log.eventos().find((e) => e.evt === "memoria")!;
    assert.deepEqual([ev.encontrado, ev.segunda, ev.ampliada, ev.llm], [true, true, 1, 2]);
  } finally {
    modelo.restaurar();
    log.restaurar();
  }
});

test("la ampliación solo corre cuando la primera dijo «No lo encuentro»", async () => {
  const { db, llamadas } = fakeDb(VAULT, { vault_search: () => [] });
  const modelo = modeloGuionado(["Respuesta directa.\nUSADAS: 1"]);
  const log = capturarLog();
  try {
    await buscar(db, "¿qué es lota visión?", { fichas: ["lota-vision"], query: "lota visión" });
    assert.equal(llamadas.filter((l) => l.args.p_kinds === null).length, 0);
    assert.equal(modelo.peticiones.length, 1);
    assert.equal(log.eventos().find((e) => e.evt === "memoria")!.ampliada, 0);
  } finally {
    modelo.restaurar();
    log.restaurar();
  }
});

test("las palabras «pendientes» y «estado» no salen a la búsqueda de pendientes, y con carpetas ya resueltas ni se busca", async () => {
  const { db, llamadas } = fakeDb(VAULT, { vault_search: () => [] });
  const modelo = modeloGuionado(["Algo.\nUSADAS: 1", "Algo.\nUSADAS: 1"]);
  const log = capturarLog();
  try {
    // sin ficha ni proyecto resuelto: se busca por el título, sin las palabras que tienen todos los pendientes
    await buscar(db, "¿cómo va la cámara?", { fichas: [], query: "estado pendientes cámara" });
    const busqueda = llamadas.filter((l) => Array.isArray(l.args.p_kinds) && l.args.p_kinds[0] === "pendientes");
    assert.equal(busqueda.length, 1);
    assert.equal(busqueda[0].args.p_query, "cámara");
    // con el proyecto ya resuelto por la ficha: no se busca más
    llamadas.length = 0;
    await buscar(db, "¿en qué quedó lota visión?", { fichas: ["lota-vision"], query: "estado pendientes lota visión" });
    assert.equal(llamadas.filter((l) => Array.isArray(l.args.p_kinds) && l.args.p_kinds[0] === "pendientes").length, 0);
    // y una consulta que era solo esas palabras tampoco
    llamadas.length = 0;
    await buscar(db, "estado", { fichas: [], query: "estado pendientes" });
    assert.equal(llamadas.filter((l) => Array.isArray(l.args.p_kinds) && l.args.p_kinds[0] === "pendientes").length, 0);
  } finally {
    modelo.restaurar();
    log.restaurar();
  }
});
