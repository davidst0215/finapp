// node --experimental-strip-types --test supabase/functions/_shared/vault/tasks.test.ts
// Los fixtures reproducen la ESTRUCTURA de líneas reales del vault (orden de tags, prioridad, fechas, sellos ✅
// repetidos, detalle indentado, subtareas) con texto inventado: el repo es público.
import test from "node:test";
import assert from "node:assert/strict";
import {
  appendBlock, applyStatus, buildTaskBlock, cleanText, dropBlock, joinDoc, locateTask, parseTasks, pendientesHeader,
  setStatusLine, slugPerson, splitDoc, takeBlock, TaskNotFoundError, type TaskStatus,
} from "./tasks.ts";

const HOY = "2026-10-05";

const FIXTURE_LINES = [
  "# Pendientes — Ventas",
  "- [ ] Esperar: Ana comparte la data de llamadas #fathom #destino/acme-ventas #conjunto/ana 🔼",
  "    - Sync semanal · 15 sep · [grabación](https://example.com/share/abc) · Pedido hace un mes",
  "- [x] Enviar el Excel de validación #fathom ⏫ 📅 2026-09-16 ✅ 2026-09-27",
  "    - Reunión mensual · 16 sep · [grabación](https://example.com/share/def)",
  "- [/] formatear contenido ⏫ 📅 2026-09-01 ✅ 2026-09-27 ✅ 2026-09-27",
  "",
  "## Semana 31 ago — 2 sep",
  "- [x] contenido de la semana ⏫ 📅 2026-08-26 ✅ 2026-08-31",
  "    - [x] lunes 24 📅 2026-08-24 ✅ 2026-08-25",
  "    - [ ] martes 25 📅 2026-08-25",
  "- [?] Aclarar la regla con Comercial 🔼 📅 2026-09-17",
  "- [-] Cancelado por cambio de alcance 🔽",
  "- [ ] revisar el informe 🔁 every week ⏳ 2026-10-01 ⛔ abc,def 🆔 t1",
  "```md",
  "- [ ] esto no es una tarea",
  "```",
  "- [ ] tarea después del bloque de código",
  "",
];
const LF = FIXTURE_LINES.join("\n");
const CRLF = FIXTURE_LINES.join("\r\n");

const lineOf = (text: string, i: number) => splitDoc(text).lines[i];
const differ = (a: string, b: string) => {
  const x = splitDoc(a), y = splitDoc(b);
  assert.equal(x.lines.length, y.lines.length, "mismo número de líneas");
  return x.lines.map((l, i) => (l === y.lines[i] && x.eols[i] === y.eols[i] ? -1 : i)).filter((i) => i >= 0);
};

test("splitDoc/joinDoc reproduce el texto byte a byte (LF, CRLF, mixto, sin salto final, vacío)", () => {
  for (const t of ["", "a", "a\n", "a\r\nb\n", "a\r\nb\nc\r\n", "\n\n", LF, CRLF, "x\r\ny\nz"]) {
    assert.equal(joinDoc(splitDoc(t)), t);
  }
});

test("parseTasks: encuentra las 10 tareas e ignora el bloque de código", () => {
  const tasks = parseTasks(LF);
  assert.deepEqual(tasks.map((t) => t.line), [1, 3, 5, 8, 9, 10, 11, 12, 13, 17]);
});

test("parseTasks: etiqueta de espera, destino sugerido, origen y detalle", () => {
  const t = parseTasks(LF).find((x) => x.line === 1)!;
  assert.equal(t.status, "pending");
  assert.equal(t.text, "Esperar: Ana comparte la data de llamadas");
  assert.equal(t.level, "medio");
  assert.equal(t.priority, 2);
  assert.equal(t.shared, true);
  assert.equal(t.sharedWith, "ana");
  assert.equal(t.suggest, "acme-ventas");
  assert.equal(t.source, "fathom");
  assert.equal(t.due, null);
  assert.equal(t.note, "Sync semanal · 15 sep · [grabación](https://example.com/share/abc) · Pedido hace un mes");
  assert.equal(t.raw, FIXTURE_LINES[1]);
});

test("parseTasks: hecha con fecha, prioridad alta y sello ✅", () => {
  const t = parseTasks(LF).find((x) => x.line === 3)!;
  assert.equal(t.status, "completed");
  assert.equal(t.text, "Enviar el Excel de validación");
  assert.equal(t.level, "alto");
  assert.equal(t.priority, 3);
  assert.equal(t.due, "2026-09-16");
  assert.equal(t.doneOn, "2026-09-27");
  assert.equal(t.shared, false);
});

test("parseTasks: en curso con sellos ✅ repetidos (rareza real) no se rompe", () => {
  const t = parseTasks(LF).find((x) => x.line === 5)!;
  assert.equal(t.status, "in-progress");
  assert.equal(t.text, "formatear contenido");
  assert.equal(t.doneOn, "2026-09-27");
});

test("parseTasks: subtareas apuntan a su tarea de primer nivel", () => {
  const tasks = parseTasks(LF);
  const by = (l: number) => tasks.find((x) => x.line === l)!;
  assert.equal(by(8).parentLine, null);
  assert.equal(by(9).parentLine, 8);
  assert.equal(by(9).indent, 4);
  assert.equal(by(10).parentLine, 8);
  assert.equal(by(10).status, "pending");
  assert.equal(by(11).parentLine, null);
});

test("parseTasks: estados ?, - y metadata de recurrencia, dependencia e id", () => {
  const tasks = parseTasks(LF);
  const by = (l: number) => tasks.find((x) => x.line === l)!;
  assert.equal(by(11).status, "need-help");
  assert.equal(by(11).due, "2026-09-17");
  assert.equal(by(12).status, "failed");
  assert.equal(by(12).level, "bajo");
  const r = by(13);
  assert.equal(r.text, "revisar el informe");
  assert.equal(r.recurring, "every week");
  assert.equal(r.scheduled, "2026-10-01");
  assert.deepEqual(r.dependencies, ["abc", "def"]);
  assert.equal(r.taskId, "t1");
});

test("parseTasks: el detalle solo cuenta si está pegado a la tarea", () => {
  const txt = ["- [ ] a", "", "    - suelto", "- [ ] b", "    - de b", "    - segundo"].join("\n");
  const [a, b] = parseTasks(txt);
  assert.equal(a.note, null);
  assert.equal(b.note, "de b segundo");
});

test("parseTasks da lo mismo con CRLF", () => {
  const strip = (ts: ReturnType<typeof parseTasks>) => ts.map((t) => ({ ...t }));
  assert.deepEqual(strip(parseTasks(CRLF)), strip(parseTasks(LF)));
});

test("setStatusLine: completar estampa ✅ una vez; reabrir quita todos los sellos", () => {
  assert.equal(setStatusLine("- [ ] a ⏫ 📅 2026-10-01", "completed", HOY), "- [x] a ⏫ 📅 2026-10-01 ✅ 2026-10-05");
  assert.equal(setStatusLine("- [x] a ✅ 2026-09-27", "completed", HOY), "- [x] a ✅ 2026-09-27"); // no re-estampa
  assert.equal(setStatusLine("- [x] a 📅 2026-10-01 ✅ 2026-09-27", "pending", HOY), "- [ ] a 📅 2026-10-01");
  assert.equal(setStatusLine("- [/] a ✅ 2026-09-27 ✅ 2026-09-27 ✅ 2026-09-27", "pending", HOY), "- [ ] a");
  assert.equal(setStatusLine("- [ ] a", "in-progress", HOY), "- [/] a");
  assert.equal(setStatusLine("- [ ] a", "need-help", HOY), "- [?] a");
  assert.equal(setStatusLine("- [ ] a", "failed", HOY), "- [-] a");
  assert.equal(setStatusLine("    - [ ] sub", "completed", HOY), "    - [x] sub ✅ 2026-10-05"); // conserva la indentación
  assert.equal(setStatusLine("## Encabezado", "completed", HOY), "## Encabezado"); // no es una tarea
});

test("setStatusLine es idempotente para tareas pendientes y hechas con sello", () => {
  for (const t of parseTasks(LF)) {
    if ((t.status === "pending" && t.doneOn === null) || (t.status === "completed" && t.doneOn)) {
      assert.equal(setStatusLine(t.raw, t.status, HOY), t.raw, t.raw);
    }
  }
});

test("applyStatus cambia solo la línea pedida", () => {
  const r = applyStatus(LF, { line: 1, raw: FIXTURE_LINES[1] }, "completed", HOY);
  assert.equal(r.changed, true);
  assert.equal(r.line, 1);
  assert.equal(r.raw, FIXTURE_LINES[1].replace("- [ ]", "- [x]") + " ✅ 2026-10-05");
  assert.deepEqual(differ(LF, r.text), [1]);
  assert.equal(lineOf(r.text, 1).startsWith("- [x] Esperar: Ana"), true);
});

test("applyStatus: reabrir quita el sello y vuelve a completar estampa la fecha de hoy", () => {
  const abierta = applyStatus(LF, { line: 3, raw: FIXTURE_LINES[3] }, "pending", HOY);
  assert.equal(lineOf(abierta.text, 3), "- [ ] Enviar el Excel de validación #fathom ⏫ 📅 2026-09-16");
  const cerrada = applyStatus(abierta.text, { line: 3, raw: abierta.raw }, "completed", HOY);
  assert.equal(lineOf(cerrada.text, 3), "- [x] Enviar el Excel de validación #fathom ⏫ 📅 2026-09-16 ✅ 2026-10-05");
});

test("applyStatus: sin cambio real devuelve el mismo texto", () => {
  const r = applyStatus(LF, { line: 3, raw: FIXTURE_LINES[3] }, "completed", HOY);
  assert.equal(r.changed, false);
  assert.equal(r.text, LF);
});

test("applyStatus conserva CRLF y los saltos mixtos de las líneas que no toca", () => {
  const r = applyStatus(CRLF, { line: 12, raw: FIXTURE_LINES[12] }, "pending", HOY);
  assert.equal(r.text.includes("\r\n"), true);
  assert.equal(r.text.replace(/\r\n/g, "").includes("\n"), false);
  assert.deepEqual(differ(CRLF, r.text), [12]);

  const mixto = "a\r\n- [ ] t1\n- [ ] t2\r\nfin";
  const m = applyStatus(mixto, { line: 2, raw: "- [ ] t2" }, "completed", HOY);
  assert.equal(m.text, "a\r\n- [ ] t1\n- [x] t2 ✅ 2026-10-05\r\nfin");
});

test("applyStatus ubica la tarea aunque otras ediciones hayan desplazado las líneas", () => {
  const desplazado = ["# nuevo", "- [ ] otra cosa", ...FIXTURE_LINES].join("\n");
  const r = applyStatus(desplazado, { line: 1, raw: FIXTURE_LINES[1] }, "completed", HOY);
  assert.equal(r.line, 3);
  assert.equal(lineOf(r.text, 3).startsWith("- [x] Esperar: Ana"), true);
});

test("applyStatus falla si la tarea cambió o no es una tarea", () => {
  assert.throws(() => applyStatus(LF, { line: 1, raw: "- [ ] otra línea" }, "completed", HOY), TaskNotFoundError);
  assert.throws(() => applyStatus(LF, { line: 7, raw: FIXTURE_LINES[7] }, "completed", HOY), TaskNotFoundError);
});

test("locateTask elige la copia más cercana cuando la línea se repite", () => {
  const lines = ["- [ ] x", "a", "- [ ] x", "b", "- [ ] x"];
  assert.equal(locateTask(lines, { line: 2, raw: "- [ ] x" }), 2);
  assert.equal(locateTask(lines, { line: 3, raw: "- [ ] x" }), 2);
  assert.equal(locateTask(lines, { line: 9, raw: "- [ ] x" }), 4);
  assert.equal(locateTask(lines, { line: 0, raw: "- [ ] y" }), null);
});

test("buildTaskBlock escribe en el orden de Norte y se lee de vuelta igual", () => {
  const block = buildTaskBlock({ text: "Llamar a Ana. ", level: "alto", due: "2026-10-09", shared: "Juan Pablo", note: "Pedir la base\nactualizada" });
  assert.deepEqual(block, ["- [ ] Llamar a Ana #conjunto/juan-pablo ⏫ 📅 2026-10-09", "    - Pedir la base actualizada"]);
  const [t] = parseTasks(block.join("\n"));
  assert.equal(t.text, "Llamar a Ana");
  assert.equal(t.level, "alto");
  assert.equal(t.due, "2026-10-09");
  assert.equal(t.sharedWith, "juan-pablo");
  assert.equal(t.note, "Pedir la base actualizada");
});

test("buildTaskBlock: mínimos, #conjunto sin persona y saneamiento del texto", () => {
  assert.deepEqual(buildTaskBlock({ text: "Revisar" }), ["- [ ] Revisar"]);
  assert.deepEqual(buildTaskBlock({ text: "Revisar", shared: true }), ["- [ ] Revisar #conjunto"]);
  assert.equal(buildTaskBlock({ text: "  - [ ] Revisar #fathom 📅 2026-01-01 informe  " })[0], "- [ ] Revisar fathom 2026-01-01 informe");
  assert.equal(buildTaskBlock({ text: "x", note: "[ ] fingir subtarea" })[1], "    - fingir subtarea");
});

test("buildTaskBlock rechaza lo inválido", () => {
  assert.throws(() => buildTaskBlock({ text: "   " }));
  assert.throws(() => buildTaskBlock({ text: "x", due: "2026-02-30" }));
  assert.throws(() => buildTaskBlock({ text: "x", due: "mañana" }));
  assert.throws(() => buildTaskBlock({ text: "x", level: "urgente" as never }));
});

test("cleanText y slugPerson", () => {
  assert.equal(cleanText("a\nb  c…."), "a b c…");
  assert.equal(cleanText(null), "");
  assert.equal(slugPerson("María José"), "maria-jose");
  assert.equal(slugPerson("  Ñandú! "), "nandu");
});

test("appendBlock: respeta el salto del archivo y deja un solo salto final", () => {
  const lf = appendBlock("# H\n- [ ] uno\n\n\n", ["- [ ] dos"], "# X");
  assert.equal(lf.text, "# H\n- [ ] uno\n- [ ] dos\n");
  assert.equal(lf.firstLine, 2);
  const crlf = appendBlock("# H\r\n- [ ] uno\r\n", ["- [ ] dos", "    - nota"], "# X");
  assert.equal(crlf.text, "# H\r\n- [ ] uno\r\n- [ ] dos\r\n    - nota\r\n");
  assert.equal(crlf.firstLine, 2);
});

test("appendBlock: archivo inexistente → encabezado, línea en blanco y el bloque", () => {
  const r = appendBlock(null, ["- [ ] uno"], pendientesHeader("Ventas"));
  assert.equal(r.text, "# Pendientes — Ventas\n\n- [ ] uno\n");
  assert.equal(r.firstLine, 2);
  assert.equal(parseTasks(r.text)[0].line, r.firstLine);
  assert.deepEqual(appendBlock("", ["- [ ] uno"], "# X"), { text: "- [ ] uno\n", firstLine: 0 });
});

test("appendBlock: firstLine apunta a la tarea recién agregada", () => {
  const r = appendBlock(LF, ["- [ ] nueva"], "# X");
  assert.equal(lineOf(r.text, r.firstLine), "- [ ] nueva");
  assert.equal(parseTasks(r.text).at(-1)!.line, r.firstLine);
});

test("takeBlock: tarea + detalle, sin #destino", () => {
  const { block, line } = takeBlock(LF, { line: 1, raw: FIXTURE_LINES[1] });
  assert.equal(line, 1);
  assert.deepEqual(block, [
    "- [ ] Esperar: Ana comparte la data de llamadas #fathom #conjunto/ana 🔼",
    "    - Sync semanal · 15 sep · [grabación](https://example.com/share/abc) · Pedido hace un mes",
  ]);
});

test("takeBlock: incluye subtareas y des-indenta cuando la tarea es una subtarea", () => {
  const conSubs = takeBlock(LF, { line: 8, raw: FIXTURE_LINES[8] });
  assert.equal(conSubs.block.length, 3);
  assert.equal(conSubs.block[1], "    - [x] lunes 24 📅 2026-08-24 ✅ 2026-08-25");
  const sub = takeBlock(LF, { line: 9, raw: FIXTURE_LINES[9] });
  assert.deepEqual(sub.block, ["- [x] lunes 24 📅 2026-08-24 ✅ 2026-08-25"]);
});

test("dropBlock quita la tarea y su detalle y deja el resto idéntico", () => {
  const r = dropBlock(CRLF, { line: 1, raw: FIXTURE_LINES[1] });
  assert.equal(r.removed, true);
  const antes = splitDoc(CRLF);
  const despues = splitDoc(r.text);
  assert.deepEqual(despues.lines, [...antes.lines.slice(0, 1), ...antes.lines.slice(3)]);
  assert.deepEqual(despues.eols, [...antes.eols.slice(0, 1), ...antes.eols.slice(3)]);
});

test("dropBlock con una tarea que ya no está no hace nada", () => {
  const r = dropBlock(LF, { line: 1, raw: "- [ ] ya no existe" });
  assert.deepEqual(r, { text: LF, removed: false });
});

test("mover = takeBlock + appendBlock + dropBlock conserva la tarea y su detalle", () => {
  const ref = { line: 1, raw: FIXTURE_LINES[1] };
  const { block } = takeBlock(LF, ref);
  const destino = appendBlock("# Pendientes — Otra\n", block, "# X");
  const origen = dropBlock(LF, ref);
  const movida = parseTasks(destino.text).find((t) => t.line === destino.firstLine)!;
  assert.equal(movida.text, "Esperar: Ana comparte la data de llamadas");
  assert.equal(movida.suggest, null);
  assert.equal(movida.sharedWith, "ana");
  assert.match(movida.note ?? "", /^Sync semanal/);
  assert.equal(parseTasks(origen.text).length, parseTasks(LF).length - 1);
});

test("estados válidos: todos los chars de Norte se leen", () => {
  const txt = [" ", "/", "x", "X", "?", "-"].map((c) => `- [${c}] t`).join("\n");
  const estados: TaskStatus[] = parseTasks(txt).map((t) => t.status);
  assert.deepEqual(estados, ["pending", "in-progress", "completed", "completed", "need-help", "failed"]);
});
