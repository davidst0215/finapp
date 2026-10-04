// node --experimental-strip-types --test supabase/functions/_shared/vault/ops.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { GitHubConflict, type RepoFiles } from "./github.ts";
import {
  assertTaskPath, opCreateTask, opMoveTask, opSetStatus, PartialMoveError, updateFile, VaultError,
} from "./ops.ts";
import { parseTasks, TaskNotFoundError } from "./tasks.ts";

/** Repo en memoria con control de versiones por sha, como la API de contenidos de GitHub. */
class FakeRepo implements RepoFiles {
  files = new Map<string, { text: string; sha: string }>();
  puts: { path: string; message: string }[] = [];
  gets = 0;
  private n = 0;
  /** Se ejecuta justo antes de validar cada PUT: permite simular a otro escritor. */
  beforePut?: (path: string, putNumber: number) => void;
  failPut?: (path: string) => Error | null;

  set(path: string, text: string) {
    this.files.set(path, { text, sha: `sha${++this.n}` });
  }
  text(path: string) {
    return this.files.get(path)?.text ?? null;
  }
  async getFile(path: string) {
    this.gets++;
    const f = this.files.get(path);
    return f ? { ...f } : null;
  }
  async putFile(path: string, text: string, sha: string | null, message: string) {
    this.puts.push({ path, message });
    this.beforePut?.(path, this.puts.length);
    const fallo = this.failPut?.(path);
    if (fallo) throw fallo;
    const cur = this.files.get(path);
    if (cur ? cur.sha !== sha : sha !== null) throw new GitHubConflict("sha no coincide", cur ? 409 : 422);
    const nuevo = `sha${++this.n}`;
    this.files.set(path, { text, sha: nuevo });
    return { sha: nuevo };
  }
}

const HOY = "2026-10-05";
const P = "20-projects/acme-ventas/pendientes.md";
const TEXTO = ["# Pendientes — Ventas", "- [ ] uno ⏫ #destino/acme-soporte", "    - detalle de uno", "- [ ] dos", ""].join("\r\n");
const ref = (line: number, raw: string) => ({ line, raw });
const UNO = "- [ ] uno ⏫ #destino/acme-soporte";

test("updateFile: no escribe si no hay cambios y crea el archivo si no existe", async () => {
  const repo = new FakeRepo();
  repo.set(P, TEXTO);
  const igual = await updateFile(repo, P, (t) => t, "m");
  assert.equal(igual.changed, false);
  assert.equal(repo.puts.length, 0);

  const nuevo = await updateFile(repo, "20-projects/otra/pendientes.md", (t) => (t === null ? "hola\n" : t), "crear");
  assert.equal(nuevo.changed, true);
  assert.equal(repo.text("20-projects/otra/pendientes.md"), "hola\n");
});

test("updateFile: ante conflicto relee y reaplica sobre el texto nuevo, conservando el cambio ajeno", async () => {
  const repo = new FakeRepo();
  repo.set(P, "a\n");
  let mutaciones = 0;
  repo.beforePut = (path, n) => {
    if (n === 1) repo.set(path, "a\notro escritor\n"); // alguien se adelantó
  };
  const r = await updateFile(repo, P, (t) => { mutaciones++; return (t ?? "") + "mío\n"; }, "m");
  assert.equal(r.changed, true);
  assert.equal(mutaciones, 2);
  assert.equal(repo.puts.length, 2);
  assert.equal(repo.text(P), "a\notro escritor\nmío\n");
});

test("updateFile: se rinde al tercer conflicto seguido", async () => {
  const repo = new FakeRepo();
  repo.set(P, "a\n");
  repo.beforePut = (path, n) => repo.set(path, `a\nv${n}\n`);
  let mutaciones = 0;
  await assert.rejects(updateFile(repo, P, (t) => { mutaciones++; return (t ?? "") + "x"; }, "m"), GitHubConflict);
  assert.equal(mutaciones, 3);
  assert.equal(repo.puts.length, 3);
});

test("updateFile: un error de dominio no se reintenta", async () => {
  const repo = new FakeRepo();
  repo.set(P, "a\n");
  await assert.rejects(updateFile(repo, P, () => { throw new TaskNotFoundError(); }, "m"), TaskNotFoundError);
  assert.equal(repo.puts.length, 0);
});

test("opSetStatus: completa con la fecha de hoy, mensaje de commit claro y salto CRLF intacto", async () => {
  const repo = new FakeRepo();
  repo.set(P, TEXTO);
  const r = await opSetStatus(repo, { path: P, ref: ref(3, "- [ ] dos"), status: "completed", today: HOY });
  assert.equal(r.changed, true);
  assert.equal(r.raw, "- [x] dos ✅ 2026-10-05");
  assert.equal(repo.text(P), TEXTO.replace("- [ ] dos", "- [x] dos ✅ 2026-10-05"));
  assert.equal(repo.puts[0].message, "wabid: completar tarea: dos");
  assert.equal(r.write.sha, repo.files.get(P)!.sha);
});

test("opSetStatus: sin cambio real no escribe y devuelve el texto vigente para reindexar", async () => {
  const repo = new FakeRepo();
  repo.set(P, TEXTO.replace("- [ ] dos", "- [x] dos ✅ 2026-09-30"));
  const r = await opSetStatus(repo, { path: P, ref: ref(3, "- [x] dos ✅ 2026-09-30"), status: "completed", today: HOY });
  assert.equal(r.changed, false);
  assert.equal(repo.puts.length, 0);
  assert.equal(r.write.text, repo.text(P));
});

test("opSetStatus: encuentra la tarea aunque otro escritor haya movido las líneas", async () => {
  const repo = new FakeRepo();
  repo.set(P, TEXTO);
  repo.beforePut = (path, n) => {
    if (n === 1) repo.set(path, "# Nuevo encabezado\r\n" + TEXTO);
  };
  const r = await opSetStatus(repo, { path: P, ref: ref(3, "- [ ] dos"), status: "in-progress", today: HOY });
  assert.equal(r.line, 4);
  assert.equal(repo.puts.length, 2);
  assert.match(repo.text(P)!, /\r\n- \[\/\] dos\r\n/);
});

test("opSetStatus: tarea cambiada o ruta inválida → error, sin escribir", async () => {
  const repo = new FakeRepo();
  repo.set(P, TEXTO);
  await assert.rejects(opSetStatus(repo, { path: P, ref: ref(3, "- [ ] dos modificada"), status: "completed", today: HOY }), TaskNotFoundError);
  await assert.rejects(opSetStatus(repo, { path: ".github/workflows/x.md", ref: ref(0, "x"), status: "completed", today: HOY }), VaultError);
  await assert.rejects(opSetStatus(repo, { path: "20-projects/falta/pendientes.md", ref: ref(0, "x"), status: "completed", today: HOY }), TaskNotFoundError);
  assert.equal(repo.puts.length, 0);
});

test("opCreateTask: agrega al final del archivo y dice en qué línea quedó", async () => {
  const repo = new FakeRepo();
  repo.set(P, TEXTO);
  const r = await opCreateTask(repo, { folder: "acme-ventas", label: "Acme › Ventas", task: { text: "Llamar a Ana", level: "alto", due: "2026-10-09" } });
  assert.equal(repo.text(P), TEXTO.trimEnd() + "\r\n- [ ] Llamar a Ana ⏫ 📅 2026-10-09\r\n");
  const t = parseTasks(r.write.text).find((x) => x.line === r.line)!;
  assert.equal(t.text, "Llamar a Ana");
  assert.equal(repo.puts[0].message, "wabid: nueva tarea en acme-ventas: Llamar a Ana");
});

test("opCreateTask: carpeta sin pendientes.md → lo crea con encabezado", async () => {
  const repo = new FakeRepo();
  const r = await opCreateTask(repo, { folder: "life", label: "Life", task: { text: "Cuadrar finanzas", note: "mes de octubre" } });
  assert.equal(r.write.path, "20-projects/life/pendientes.md");
  assert.equal(repo.text(r.write.path), "# Pendientes — Life\n\n- [ ] Cuadrar finanzas\n    - mes de octubre\n");
  assert.equal(r.line, 2);
});

test("opCreateTask: entrada inválida → VaultError 400 sin tocar GitHub", async () => {
  const repo = new FakeRepo();
  for (const args of [
    { folder: "../etc", label: "x", task: { text: "a" } },
    { folder: "ok", label: "x", task: { text: "   " } },
    { folder: "ok", label: "x", task: { text: "a", due: "2026-02-30" } },
    { folder: "ok", label: "x", task: { text: "a", level: "urgente" as never } },
  ]) {
    await assert.rejects(opCreateTask(repo, args), (e: unknown) => e instanceof VaultError && e.status === 400);
  }
  assert.equal(repo.gets + repo.puts.length, 0);
});

test("opMoveTask: escribe primero en el destino y después quita del origen, con detalle y sin #destino", async () => {
  const repo = new FakeRepo();
  repo.set(P, TEXTO);
  repo.set("20-projects/acme-soporte/pendientes.md", "# Pendientes — Soporte\n- [ ] existente\n");
  const r = await opMoveTask(repo, { path: P, ref: ref(1, UNO), toFolder: "acme-soporte", toLabel: "Acme › Soporte" });
  assert.deepEqual(repo.puts.map((p) => p.path), ["20-projects/acme-soporte/pendientes.md", P]);
  assert.equal(repo.puts[0].message, "wabid: mover tarea a acme-soporte: uno");
  assert.equal(repo.text("20-projects/acme-soporte/pendientes.md"), "# Pendientes — Soporte\n- [ ] existente\n- [ ] uno ⏫\n    - detalle de uno\n");
  assert.equal(repo.text(P), ["# Pendientes — Ventas", "- [ ] dos", ""].join("\r\n"));
  assert.equal(r.destLine, 2);
  assert.equal(r.source.text, repo.text(P));
});

test("opMoveTask: a una carpeta sin archivo lo crea con el encabezado del destino", async () => {
  const repo = new FakeRepo();
  repo.set(P, TEXTO);
  await opMoveTask(repo, { path: P, ref: ref(3, "- [ ] dos"), toFolder: "acme-datos", toLabel: "Acme › Datos" });
  assert.equal(repo.text("20-projects/acme-datos/pendientes.md"), "# Pendientes — Acme › Datos\n\n- [ ] dos\n");
});

test("opMoveTask: reintenta el origen si cambió y tolera que la tarea ya no esté", async () => {
  const repo = new FakeRepo();
  repo.set(P, TEXTO);
  repo.beforePut = (path, n) => {
    if (n === 2 && path === P) repo.set(P, "# otro\r\n" + TEXTO); // el origen cambia justo antes de quitar
  };
  await opMoveTask(repo, { path: P, ref: ref(3, "- [ ] dos"), toFolder: "acme-soporte", toLabel: "Soporte" });
  assert.equal(parseTasks(repo.text(P)!).some((t) => t.text === "dos"), false);
  assert.equal(parseTasks(repo.text(P)!).some((t) => t.text === "uno"), true);
});

test("opMoveTask: si falla quitar del origen queda duplicada, nunca perdida", async () => {
  const repo = new FakeRepo();
  repo.set(P, TEXTO);
  repo.failPut = (path) => (path === P ? new Error("GitHub caído") : null);
  await assert.rejects(
    opMoveTask(repo, { path: P, ref: ref(3, "- [ ] dos"), toFolder: "acme-soporte", toLabel: "Soporte" }),
    (e: unknown) => e instanceof PartialMoveError && /GitHub caído/.test(e.message) && e.dest.path === "20-projects/acme-soporte/pendientes.md",
  );
  assert.match(repo.text("20-projects/acme-soporte/pendientes.md")!, /- \[ \] dos/);
  assert.match(repo.text(P)!, /- \[ \] dos/);
});

test("opMoveTask: validaciones previas", async () => {
  const repo = new FakeRepo();
  repo.set(P, TEXTO);
  await assert.rejects(opMoveTask(repo, { path: P, ref: ref(3, "- [ ] dos"), toFolder: "acme-ventas", toLabel: "x" }), /Ya está en esa carpeta/);
  await assert.rejects(opMoveTask(repo, { path: P, ref: ref(3, "- [ ] dos"), toFolder: "../x", toLabel: "x" }), VaultError);
  await assert.rejects(opMoveTask(repo, { path: P, ref: ref(3, "- [ ] otra"), toFolder: "acme-soporte", toLabel: "x" }), TaskNotFoundError);
  assert.equal(repo.puts.length, 0);
});

test("assertTaskPath: solo .md de 20-projects, sin trucos", () => {
  assert.equal(assertTaskPath(P), P);
  assert.equal(assertTaskPath("20-projects/acme/sessions/s1.md"), "20-projects/acme/sessions/s1.md");
  for (const mala of [
    "", 7, null, ".github/workflows/ci.yml", "README.md", "20-projects/../.git/config.md", "20-projects/a/../b.md", "20-projects//a.md",
    "20-projects/a/.oculto.md", "20-projects\\a\\b.md", "20-projects/a/b.txt", "20-projects/a/b.md\n", "x".repeat(400) + ".md",
  ]) {
    assert.throws(() => assertTaskPath(mala), VaultError, String(mala));
  }
});
