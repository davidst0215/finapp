// node --experimental-strip-types --test supabase/functions/_shared/vault/rows.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { rowsForFile, toTaskRow } from "./rows.ts";
import { parseTasks } from "./tasks.ts";

test("rowsForFile: documento + tareas solo para archivos de 20-projects", () => {
  const texto = "# Pendientes — Ventas\r\n- [ ] Llamar a Ana ⏫ 📅 2026-10-09 #conjunto/ana\r\n    - detalle\r\n    - [x] sub ✅ 2026-10-01\r\n";
  const { doc, tasks } = rowsForFile("20-projects/acme-ventas/pendientes.md", texto, "sha1");
  assert.equal(doc!.kind, "pendientes");
  assert.equal(doc!.content, "");
  assert.equal(tasks!.length, 2);
  assert.deepEqual(
    {
      folder: tasks![0].folder, text: tasks![0].text, priority: tasks![0].priority, due: tasks![0].due,
      shared_with: tasks![0].shared_with, note: tasks![0].note, parent_line: tasks![0].parent_line,
    },
    { folder: "acme-ventas", text: "Llamar a Ana", priority: 3, due: "2026-10-09", shared_with: "ana", note: "detalle", parent_line: null },
  );
  assert.equal(tasks![1].parent_line, 1);
  assert.equal(tasks![1].status, "completed");
  assert.equal(tasks![1].done_on, "2026-10-01");
  const ficha = rowsForFile("60-wiki/proyectos/x.md", "---\ntype: ficha-proyecto\n---\n# X\n- [ ] no es tarea aquí", "sha2");
  assert.equal(ficha.doc!.kind, "ficha");
  assert.equal(ficha.tasks, null);
  assert.equal(rowsForFile("README.md", "x", "s").doc, null);
  const t = parseTasks("- [ ] a")[0];
  assert.equal(toTaskRow("20-projects/z/pendientes.md", t).folder, "z");
});

test("rowsForFile: fechas imposibles y caracteres NUL no rompen el lote", () => {
  const nul = String.fromCharCode(0);
  const texto = `# P\n- [ ] mala fecha 📅 2026-02-30 ⏳ 2026-13-01 ✅ 2026-99-99\n- [ ] con nul${nul} dentro\n`;
  const { tasks, doc } = rowsForFile("20-projects/a/pendientes.md", texto, "s");
  assert.deepEqual([tasks![0].due, tasks![0].scheduled, tasks![0].done_on], [null, null, null]);
  assert.equal(tasks![1].text, "con nul dentro");
  assert.equal(JSON.stringify([doc, tasks]).includes("\\u0000"), false);
});
