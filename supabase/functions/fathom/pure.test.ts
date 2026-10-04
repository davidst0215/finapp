import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buscarReuniones, construirEsperas, cuandoHablado, avanzarPlan, planSync, diasEntre, esperasDe, fechaAlta, hoyLima, leerConsulta,
  leerNota, limaDia, mensajeEsperas, mensajeReunion, parseMeeting, parsePage, resumenCorto, type Reunion,
} from "./pure.ts";

const crudo = {
  title: "Sync con Daniel",
  meeting_title: "Calendario",
  recording_id: 188459578,
  created_at: "2026-09-30T23:09:18Z",
  scheduled_start_time: "2026-09-30T22:00:00Z",
  recording_start_time: "2026-09-30T22:39:45Z",
  recording_end_time: "2026-09-30T23:09:08Z",
  share_url: "https://fathom.video/share/abc",
  url: "https://fathom.video/calls/1",
  calendar_invitees: [{ name: "Daniel Rojas", email: "daniel@x.com", is_external: true }, { name: "", email: "" }],
  default_summary: { template_name: "general", markdown_formatted: "## Propósito\nRevisar el cotizador.\n## Puntos\n- Daniel envía **precios**\n- [Link](https://a.b) listo" },
  action_items: [
    { description: "Enviar precios", completed: false, assignee: { name: "Daniel Rojas", email: "daniel@x.com" }, recording_playback_url: "https://fathom.video/x?t=1" },
    { description: "Ya hecho", completed: true, assignee: null },
    { description: "", completed: false },
  ],
  transcript: null,
};

test("parseMeeting: formato real de Fathom", () => {
  const r = parseMeeting(crudo)!;
  assert.equal(r.recording_id, 188459578);
  assert.equal(r.titulo, "Sync con Daniel");
  assert.equal(r.inicio, "2026-09-30T22:39:45Z");
  assert.equal(r.duracion_min, 29);
  assert.equal(r.invitados.length, 1);
  assert.equal(r.invitados[0].externo, true);
  assert.equal(r.action_items.length, 2);
  assert.equal(r.action_items[0].dueno, "Daniel Rojas");
  assert.equal(r.action_items[1].dueno, null);
  assert.equal(r.share_url, "https://fathom.video/share/abc");
});

test("parseMeeting: campos nulos y datos mínimos", () => {
  const r = parseMeeting({ recording_id: "7", created_at: "2026-10-01T10:00:00Z", action_items: null, default_summary: null, calendar_invitees: null })!;
  assert.equal(r.titulo, "(sin título)");
  assert.equal(r.inicio, "2026-10-01T10:00:00Z");
  assert.equal(r.duracion_min, null);
  assert.deepEqual(r.action_items, []);
  assert.equal(r.resumen, "");
  assert.equal(parseMeeting({ created_at: "2026-10-01T10:00:00Z" }), null);
  assert.equal(parseMeeting({ recording_id: 1 }), null);
  assert.equal(parseMeeting("x"), null);
});

test("parseMeeting: ignora enlaces que no son https", () => {
  const r = parseMeeting({ ...crudo, share_url: "javascript:alert(1)", url: "http://x" })!;
  assert.equal(r.share_url, null);
});

test("parsePage: cursor y descartadas", () => {
  const p = parsePage({ items: [crudo, { basura: 1 }], next_cursor: "abc", limit: 10 });
  assert.equal(p.items.length, 1);
  assert.equal(p.descartadas, 1);
  assert.equal(p.nextCursor, "abc");
  assert.equal(parsePage({ items: [], next_cursor: null }).nextCursor, null);
  assert.throws(() => parsePage({ error: "x" }));
});

const AHORA = Date.parse("2026-10-04T12:00:00Z");
const vacio = { complete_until: null, en_curso_desde: null, en_curso_antes: null, objetivo: null };

test("planSync: corrida nueva usa complete_until − 2 h; sin estado, 30 días", () => {
  assert.deepEqual(planSync({ ...vacio, complete_until: "2026-10-03T12:00:00Z" }, AHORA),
    { desde: "2026-10-03T10:00:00.000Z", antes: null, objetivo: "2026-10-04T12:00:00.000Z" });
  assert.equal(planSync(null, AHORA).desde, "2026-09-04T12:00:00.000Z");
});

test("planSync: acota a 1 año atrás", () => {
  assert.equal(planSync({ ...vacio, complete_until: "2020-01-01T00:00:00Z" }, AHORA).desde, "2025-10-04T12:00:00.000Z");
  const cont = planSync({ ...vacio, en_curso_desde: "2019-01-01T00:00:00Z", en_curso_antes: "2026-09-01T00:00:00Z", objetivo: "2026-10-03T00:00:00Z" }, AHORA);
  assert.equal(cont.desde, "2025-10-04T12:00:00.000Z");
});

test("planSync: una corrida cortada se continúa, no se reinicia ni avanza el objetivo", () => {
  const p = planSync({ complete_until: "2026-09-01T00:00:00Z", en_curso_desde: "2026-09-30T22:00:00Z", en_curso_antes: "2026-10-02T00:00:00Z", objetivo: "2026-10-03T00:00:00Z" }, AHORA);
  assert.deepEqual(p, { desde: "2026-09-30T22:00:00.000Z", antes: "2026-10-02T00:00:00.000Z", objetivo: "2026-10-03T00:00:00.000Z" });
});

test("avanzarPlan: más nuevas primero retrocede `antes` (sin perder las viejas)", () => {
  const plan = { desde: "2026-09-01T00:00:00.000Z", antes: null, objetivo: "2026-10-04T12:00:00.000Z" };
  const traidas = [{ creada_en: "2026-10-03T10:00:00Z" }, { creada_en: "2026-10-01T10:00:00Z" }, { creada_en: "2026-09-28T10:00:00Z" }];
  const sig = avanzarPlan(plan, traidas);
  assert.equal(sig.desde, plan.desde); // la ventana vieja sigue abierta
  assert.equal(sig.antes, "2026-09-28T10:00:01.000Z"); // 1 s de margen: repite en vez de perder
  assert.equal(sig.objetivo, plan.objetivo);
  // y una segunda vuelta con `antes` previo no retrocede de más ni avanza
  const sig2 = avanzarPlan(sig, [{ creada_en: "2026-09-20T10:00:00Z" }]);
  assert.equal(sig2.antes, "2026-09-20T10:00:01.000Z");
  assert.equal(avanzarPlan(sig2, [{ creada_en: "2026-09-29T10:00:00Z" }]).antes, "2026-09-20T10:00:01.000Z");
});

test("avanzarPlan: si Fathom devolviera más viejas primero, avanza `desde`", () => {
  const plan = { desde: "2026-09-01T00:00:00.000Z", antes: null, objetivo: "2026-10-04T12:00:00.000Z" };
  const sig = avanzarPlan(plan, [{ creada_en: "2026-09-10T00:00:00Z" }, { creada_en: "2026-09-20T00:00:00Z" }]);
  assert.equal(sig.desde, "2026-09-19T23:59:59.000Z");
  assert.equal(sig.antes, null);
});

test("avanzarPlan: sin reuniones traídas no mueve nada", () => {
  const plan = { desde: "2026-09-01T00:00:00.000Z", antes: "2026-10-01T00:00:00.000Z", objetivo: "2026-10-04T12:00:00.000Z" };
  assert.deepEqual(avanzarPlan(plan, []), plan);
});

test("esperas: respaldo por fecha de indexado, aprox y clave con path", () => {
  const hoy = "2026-10-04";
  const [a] = construirEsperas([{ ...T("Sin fecha", "ana", "solo texto"), path: "20-projects/cajon/pendientes.md", indexado: "2026-09-29T15:00:00Z" }], hoy);
  assert.equal(a.desde, "2026-09-29");
  assert.equal(a.aprox, true);
  assert.equal(a.dias, 5);
  assert.equal(a.vencida, true);
  // una fecha exacta gana sobre el indexado
  const [b] = construirEsperas([{ ...T("Con fecha", "ana", "R · 2 oct · c"), path: "p.md", indexado: "2026-09-01T00:00:00Z" }], hoy);
  assert.equal(b.desde, "2026-10-02");
  assert.equal(b.aprox, false);
  // misma tarea en otro archivo = otra espera; misma tarea reabierta (mismo path y texto) = misma clave
  const [c1, c2] = construirEsperas([
    { ...T("Enviar", "ana", null), path: "a.md" }, { ...T("Enviar", "ana", null), path: "b.md" },
  ], hoy);
  assert.notEqual(c1.clave, c2.clave);
  const [d] = construirEsperas([{ ...T("  ENVIAR ", "Ana", null), path: "A.md" }], hoy);
  assert.equal(d.clave, c1.clave);
});

test("fechas de Lima", () => {
  assert.equal(limaDia("2026-10-05T03:00:00Z"), "2026-10-04"); // 22:00 en Lima
  assert.equal(limaDia("2026-10-05T05:00:00Z"), "2026-10-05");
  assert.equal(hoyLima(Date.parse("2026-10-04T04:59:00Z")), "2026-10-03");
  assert.equal(diasEntre("2026-09-30", "2026-10-04"), 4);
  assert.equal(diasEntre("2026-12-30", "2027-01-02"), 3);
  assert.equal(cuandoHablado("2026-10-03", "2026-10-04"), "ayer");
  assert.equal(cuandoHablado("2026-10-02", "2026-10-04"), "anteayer");
  assert.equal(cuandoHablado("2026-09-02", "2026-10-04"), "el 2 de septiembre");
  assert.equal(cuandoHablado("2025-09-02", "2026-10-04"), "el 2 de septiembre de 2025");
});

test("resumenCorto: sin markdown ni títulos, corta en oración", () => {
  assert.equal(resumenCorto("## Propósito\nRevisar el cotizador.\n- Daniel envía **precios**\n- [Link](https://a.b) listo"),
    "Revisar el cotizador. Daniel envía precios Link listo");
  const largo = "Primera oración corta. " + "palabra ".repeat(60);
  assert.ok(resumenCorto(largo, 100).endsWith("…"));
  const dos = "Se revisó el cotizador de tela y se acordaron los precios finales. " + "otra frase sin fin ".repeat(20);
  assert.equal(resumenCorto(dos, 100), "Se revisó el cotizador de tela y se acordaron los precios finales.");
  assert.ok(resumenCorto(largo, 100).length <= 101);
  assert.equal(resumenCorto("", 100), "");
});

const R = (id: number, titulo: string, inicio: string, nombres: string[] = []): Reunion => ({
  recording_id: id, titulo, inicio, duracion_min: 30, resumen: "", action_items: [], share_url: null, creada_en: inicio,
  invitados: nombres.map((n) => ({ name: n, email: `${n.toLowerCase().replace(/\s/g, ".")}@x.com`, externo: false })),
});
const lista = [
  R(1, "Cotizador TDV", "2026-10-03T15:00:00Z", ["Daniel Rojas", "David Salguedo"]),
  R(2, "Comité semanal", "2026-10-03T20:00:00Z", ["Marco Roca"]),
  R(3, "Revisión Vera", "2026-09-28T15:00:00Z", ["Daniel Rojas"]),
];

test("leerConsulta: fecha y términos", () => {
  const q = leerConsulta("¿Qué quedó de la reunión con Daniel de ayer?", "2026-10-04");
  assert.equal(q.dia, "2026-10-03");
  assert.deepEqual(q.tokens, ["daniel"]);
  assert.equal(leerConsulta("la reunión de hoy", "2026-10-04").dia, "2026-10-04");
  assert.equal(leerConsulta("reunión del 2026-09-28", "2026-10-04").dia, "2026-09-28");
});

test("buscarReuniones: por invitado, por título, por día", () => {
  assert.deepEqual(buscarReuniones(lista, "con Daniel", "2026-10-04").map((r) => r.recording_id), [1, 3]);
  assert.deepEqual(buscarReuniones(lista, "con Daniel de ayer", "2026-10-04").map((r) => r.recording_id), [1]);
  assert.deepEqual(buscarReuniones(lista, "la de ayer", "2026-10-04").map((r) => r.recording_id), [2, 1]);
  assert.deepEqual(buscarReuniones(lista, "comite", "2026-10-04").map((r) => r.recording_id), [2]);
  assert.deepEqual(buscarReuniones(lista, "con Pedro", "2026-10-04"), []);
  assert.equal(buscarReuniones(lista, "la última reunión", "2026-10-04")[0].recording_id, 2);
});

test("buscarReuniones: el día se evalúa en Lima, no en UTC", () => {
  const tarde = [R(9, "Noche", "2026-10-04T03:30:00Z")]; // 22:30 del 3 en Lima
  assert.equal(buscarReuniones(tarde, "ayer", "2026-10-04").length, 1);
  assert.equal(buscarReuniones(tarde, "hoy", "2026-10-04").length, 0);
});

test("leerNota: formato de fathom-inbox", () => {
  const n = "Cotizador TDV · 2 oct · [grabación](https://fathom.video/x?t=1) · mandar precios";
  assert.deepEqual(leerNota(n, "2026-10-04"), { fecha: "2026-10-02", reunion: "Cotizador TDV", enlace: "https://fathom.video/x?t=1" });
  // año anterior si la fecha caería en el futuro
  assert.equal(leerNota("Reunión · 20 dic · contexto", "2026-01-05").fecha, "2025-12-20");
  // el título no se confunde con la fecha
  assert.equal(leerNota("3 oct · 2 oct · x", "2026-10-04").fecha, "2026-10-02");
  assert.equal(leerNota("30 feb", "2026-10-04").fecha, null);
  assert.equal(leerNota("Sin fecha aquí · contexto", "2026-10-04").fecha, null);
  assert.equal(leerNota(null, "2026-10-04").fecha, null);
});

test("fechaAlta: ➕ válido", () => {
  assert.equal(fechaAlta("- [ ] algo #conjunto/daniel ➕ 2026-09-30 📅 2026-10-10"), "2026-09-30");
  assert.equal(fechaAlta("- [ ] algo 📅 2026-10-10"), null);
  assert.equal(fechaAlta("- [ ] algo ➕ 2026-13-45"), null);
});

const T = (text: string, who: string | null, note: string | null, status = "pending", raw: string | null = null) =>
  ({ text, status, shared_with: who, note, raw, due: null });

test("construirEsperas: días, vencidas, orden y filtros", () => {
  const hoy = "2026-10-04";
  const e = construirEsperas([
    T("Enviar precios", "daniel", "Cotizador · 2 oct · [grabación](https://f.v/x) · ctx"),
    T("Contrato firmado", "marco-roca", "Comité · 28 sep · ctx"),
    T("Sin fecha", "ana", "solo texto"),
    T("Alta manda", "luis", "Reunión · 1 oct · ctx", "pending", "- [ ] Alta manda ➕ 2026-10-04 #conjunto/luis"),
    T("Hecha", "daniel", "Reunión · 1 oct", "completed"),
    T("Mía", null, "Reunión · 1 oct"),
  ], hoy);
  assert.deepEqual(e.map((x) => x.texto), ["Contrato firmado", "Enviar precios", "Alta manda", "Sin fecha"]);
  assert.equal(e[0].dias, 6);
  assert.equal(e[0].vencida, true);
  assert.equal(e[0].quien, "Marco roca");
  assert.equal(e[1].dias, 2);
  assert.equal(e[1].vencida, false);
  assert.equal(e[1].enlace, "https://f.v/x");
  assert.equal(e[2].dias, 0); // ➕ gana sobre la fecha de la reunión
  assert.equal(e[3].dias, null);
  assert.equal(e[3].vencida, false);
  // justo 3 días no es vencida
  assert.equal(construirEsperas([T("x", "a", "R · 1 oct · c")], hoy)[0].vencida, false);
  assert.equal(construirEsperas([T("x", "a", "R · 30 sep · c")], hoy)[0].vencida, true);
});

test("esperasDe y mensajes", () => {
  const e = construirEsperas([
    T("Enviar precios", "daniel", "R · 2 oct · c"),
    T("Contrato", "daniel-rojas", "R · 28 sep · c"),
    T("Otra", "marco", "R · 1 oct · c"),
  ], "2026-10-04");
  assert.equal(esperasDe(e, "Daniel").length, 2);
  assert.equal(esperasDe(e, "dani").length, 2);
  assert.equal(esperasDe(e, "pedro").length, 0);
  assert.equal(mensajeEsperas(e, "daniel"), "Esperas 2 cosas de Daniel rojas: Contrato (hace 6 días); Enviar precios (hace 2 días).");
  assert.match(mensajeEsperas(e, null), /^Esperas 3 cosas de 3 personas: .*La más antigua lleva 6 días, de Daniel rojas\. 1 pasa de 3 días\.$/);
  assert.equal(mensajeEsperas([], "Pedro"), "No tengo nada pendiente que estés esperando de Pedro.");
  assert.equal(mensajeEsperas([], null), "No estás esperando nada de nadie.");
});

test("mensajeReunion: sin inventar", () => {
  const r = parseMeeting(crudo)!;
  const m = mensajeReunion(r, "2026-10-04");
  assert.match(m, /^«Sync con Daniel» fue el 30 de septiembre, de 29 minutos\. Revisar el cotizador\./);
  assert.match(m, /Quedaron 1 acuerdo: Enviar precios \(Daniel Rojas\)\./);
  const vacia = mensajeReunion({ ...r, resumen: "", action_items: [] }, "2026-10-04", 2);
  assert.match(vacia, /todavía no tiene resumen/);
  assert.match(vacia, /Hay 2 reuniones más/);
});
