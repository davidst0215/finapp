// node --experimental-strip-types --test supabase/functions/_shared/vault/notas.test.ts
// Notas de proyecto: la línea que se escribe, el append que no pisa lo que ya hay y la concurrencia por sha (como GitHub).
import test from "node:test";
import assert from "node:assert/strict";
import { GitHubConflict, type RepoFiles } from "./github.ts";
import { anexarNota, lineaNota, limpiarNota, MAX_NOTA, notasHeader, notasPath, opAnotar } from "./notas.ts";
import { classifyPath } from "./docs.ts";
import { parseTasks } from "./tasks.ts";
import { rowsForFile } from "./rows.ts";
import { VaultError } from "./ops.ts";

/** Repo en memoria con control de versiones por sha, como la API de contenidos de GitHub. */
class FakeRepo implements RepoFiles {
  files = new Map<string, { text: string; sha: string }>();
  puts: { path: string; message: string; sha: string | null }[] = [];
  private n = 0;
  /** Se ejecuta justo antes de validar cada PUT: permite simular a otro escritor. */
  beforePut?: (putNumber: number) => void;
  set(path: string, text: string) {
    this.files.set(path, { text, sha: `sha${++this.n}` });
  }
  text(path: string) {
    return this.files.get(path)?.text ?? null;
  }
  async getFile(path: string) {
    const f = this.files.get(path);
    // una pausa, como la red: deja que otra escritura entre entre la lectura y el PUT
    await new Promise((r) => setTimeout(r, 1));
    return f ? { ...f } : null;
  }
  async putFile(path: string, text: string, sha: string | null, message: string) {
    this.puts.push({ path, message, sha });
    this.beforePut?.(this.puts.length);
    const cur = this.files.get(path);
    if (cur ? cur.sha !== sha : sha !== null) throw new GitHubConflict("sha no coincide", cur ? 409 : 422);
    const nuevo = `sha${++this.n}`;
    this.files.set(path, { text, sha: nuevo });
    return { sha: nuevo };
  }
}

const P = notasPath("novafondos-app");
const LABEL = "Saya Investments › Novafondos app";
const L1 = lineaNota("decidimos cesión de 0,02 % mensual", "2026-10-11", 14 * 60 + 30);

test("la línea lleva la fecha y la hora de Lima: «- 2026-10-11 14:30 · texto»", () => {
  assert.equal(L1, "- 2026-10-11 14:30 · decidimos cesión de 0,02 % mensual");
  assert.equal(lineaNota("x", "2026-10-11", 0), "- 2026-10-11 00:00 · x");
  assert.equal(lineaNota("x", "2026-10-11", 5), "- 2026-10-11 00:05 · x");
  assert.equal(lineaNota("x", "2026-10-11", 23 * 60 + 59), "- 2026-10-11 23:59 · x");
  assert.equal(lineaNota("x", "2026-10-11", 99999), "- 2026-10-11 23:59 · x", "minutos fuera de rango: no inventa una hora");
  assert.equal(notasPath("tdv-bolsa"), "20-projects/tdv-bolsa/notas.md");
});

test("limpiarNota: una sola línea de texto plano, con tope y sin cortar un emoji", () => {
  assert.equal(limpiarNota("  decidimos   cesión\ny\r\n- [ ] otra cosa\t"), "decidimos cesión y - [ ] otra cosa");
  assert.equal(limpiarNota("a\u0000b\u2028c"), "a b c");
  assert.equal(limpiarNota(undefined), "");
  assert.equal(limpiarNota("   "), "");
  const larga = limpiarNota("x".repeat(MAX_NOTA + 50));
  assert.equal(larga.length, MAX_NOTA);
  const corte = limpiarNota("x".repeat(MAX_NOTA - 1) + "😀 fin");
  assert.ok(!/[\uD800-\uDBFF]$/.test(corte), "no deja medio emoji al final");
});

test("una nota con saltos no puede abrir una casilla ni un encabezado: sigue siendo UNA línea que no es tarea", () => {
  const texto = limpiarNota("decidimos esto\n- [ ] tarea falsa\n# Encabezado falso\n---");
  const archivo = anexarNota(null, lineaNota(texto, "2026-10-11", 600), notasHeader("X"))!;
  assert.equal(archivo.split("\n").filter((l) => l.startsWith("- ")).length, 1, "una sola viñeta");
  assert.equal(parseTasks(archivo).length, 0, "no hay tareas para Norte");
  assert.equal(rowsForFile(P, archivo, "s").tasks?.length, 0);
});

test("anexarNota: archivo nuevo → encabezado + línea; existente → al final sin tocar lo anterior", () => {
  assert.equal(anexarNota(null, L1, notasHeader(LABEL)), `# Notas — ${LABEL}\n\n${L1}\n`);
  assert.equal(anexarNota("", L1, notasHeader(LABEL)), `# Notas — ${LABEL}\n\n${L1}\n`, "un archivo vacío también recibe encabezado");

  const antes = "# Notas — X\n\n- 2026-10-01 09:00 · primera\n\nUn párrafo que escribió David a mano.\n";
  const despues = anexarNota(antes, L1, "# Notas — X")!;
  assert.ok(despues.startsWith(antes.trimEnd()), "lo anterior queda igual byte a byte");
  assert.equal(despues, antes.trimEnd() + "\n" + L1 + "\n");
});

test("anexarNota: conserva CRLF, quita solo el espacio sobrante del final y deja un único salto final", () => {
  const antes = "# Notas — X\r\n\r\n- 2026-10-01 09:00 · primera\r\n\r\n\r\n";
  const despues = anexarNota(antes, L1, "# Notas — X")!;
  assert.equal(despues, "# Notas — X\r\n\r\n- 2026-10-01 09:00 · primera\r\n" + L1 + "\r\n");
  assert.ok(!/(?<!\r)\n/.test(despues), "ningún LF suelto en un archivo CRLF");
  assert.equal(anexarNota("sin salto final", L1, "# H"), `sin salto final\n${L1}\n`);
});

test("anexarNota: la misma línea ya al final (un reintento del cliente) no se duplica", () => {
  const una = anexarNota(null, L1, "# H")!;
  assert.equal(anexarNota(una, L1, "# H"), null);
  assert.equal(anexarNota(una.replace(/\n/g, "\r\n"), L1, "# H"), null, "también con CRLF");
  // Otra nota (o la misma a otra hora) sí entra
  assert.ok(anexarNota(una, lineaNota("decidimos cesión de 0,02 % mensual", "2026-10-11", 14 * 60 + 31), "# H"));
});

test("opAnotar: crea notas.md si no existe, con encabezado, y el commit dice dónde", async () => {
  const repo = new FakeRepo();
  const r = await opAnotar(repo, { folder: "novafondos-app", label: LABEL, linea: L1 });
  assert.equal(r.changed, true);
  assert.equal(r.write.path, P);
  assert.equal(repo.text(P), `# Notas — ${LABEL}\n\n${L1}\n`);
  assert.equal(r.write.text, repo.text(P));
  assert.equal(repo.puts[0].sha, null, "creación: sin sha");
  assert.equal(repo.puts[0].message, "wabid: nota en novafondos-app: decidimos cesión de 0,02 % mensual");
  assert.equal(classifyPath(P), "nota", "el índice la guarda como nota (vault_docs.kind = 'nota')");
});

test("opAnotar: agrega al final de un archivo existente SIN pisar lo que hay, con el sha leído", async () => {
  const repo = new FakeRepo();
  const previo = `# Notas — ${LABEL}\n\n- 2026-10-01 09:00 · primera\n`;
  repo.set(P, previo);
  const shaPrevio = repo.files.get(P)!.sha;
  const r = await opAnotar(repo, { folder: "novafondos-app", label: LABEL, linea: L1 });
  assert.equal(repo.text(P), previo + L1 + "\n");
  assert.equal(repo.puts[0].sha, shaPrevio, "escribe con el sha que leyó");
  assert.equal(r.write.sha, repo.files.get(P)!.sha, "devuelve el sha nuevo (el del blob escrito) para indexar");
});

test("opAnotar: la misma línea ya al final → changed false y nada se escribe", async () => {
  const repo = new FakeRepo();
  repo.set(P, `# Notas — X\n\n${L1}\n`);
  const r = await opAnotar(repo, { folder: "novafondos-app", label: "X", linea: L1 });
  assert.equal(r.changed, false);
  assert.equal(repo.puts.length, 0);
  assert.equal(r.write.text, repo.text(P), "devuelve el texto vigente para reindexar");
});

test("concurrencia: otro escribe entre la lectura y el PUT → releer y volver a agregar; quedan las dos notas", async () => {
  const repo = new FakeRepo();
  repo.set(P, "# Notas — X\n\n- 2026-10-01 09:00 · primera\n");
  const ajena = "- 2026-10-11 14:29 · nota de otro dispositivo";
  repo.beforePut = (n) => {
    if (n === 1) repo.set(P, repo.text(P)! + ajena + "\n"); // alguien se adelantó: el sha leído ya no vale
  };
  const r = await opAnotar(repo, { folder: "novafondos-app", label: "X", linea: L1 });
  assert.equal(repo.puts.length, 2, "un PUT rechazado y un reintento");
  assert.equal(repo.text(P), "# Notas — X\n\n- 2026-10-01 09:00 · primera\n" + ajena + "\n" + L1 + "\n", "ni la ajena ni la primera se pierden");
  assert.equal(r.changed, true);
});

test("concurrencia: dos notas a la vez sobre el mismo archivo → las dos quedan, cada una una sola vez", async () => {
  const repo = new FakeRepo();
  repo.set(P, "# Notas — X\n");
  const a = lineaNota("nota A", "2026-10-11", 600);
  const b = lineaNota("nota B", "2026-10-11", 601);
  await Promise.all([
    opAnotar(repo, { folder: "novafondos-app", label: "X", linea: a }),
    opAnotar(repo, { folder: "novafondos-app", label: "X", linea: b }),
  ]);
  assert.equal(repo.puts.length, 3, "dos PUT con el mismo sha: uno entra, el otro choca y reintenta");
  const lineas = repo.text(P)!.split("\n").filter(Boolean);
  assert.deepEqual(lineas.slice(0, 1), ["# Notas — X"]);
  assert.deepEqual(lineas.slice(1).sort(), [a, b].sort());
});

test("concurrencia: si el conflicto no cede tras los intentos, falla (no pisa) y el texto ajeno sigue intacto", async () => {
  const repo = new FakeRepo();
  repo.set(P, "# Notas — X\n");
  repo.beforePut = () => repo.set(P, repo.text(P)! + "- ajena\n"); // cada PUT llega tarde
  await assert.rejects(() => opAnotar(repo, { folder: "novafondos-app", label: "X", linea: L1 }), GitHubConflict);
  assert.ok(!repo.text(P)!.includes("decidimos"), "no escribió a ciegas");
  assert.equal(repo.puts.length, 3, "MAX_ATTEMPTS");
});

test("opAnotar: una carpeta con ruta rara se rechaza antes de tocar GitHub", async () => {
  const repo = new FakeRepo();
  for (const folder of ["../60-wiki/proyectos", "a/b", "", "x y"]) {
    await assert.rejects(() => opAnotar(repo, { folder, label: "X", linea: L1 }), VaultError, folder);
  }
  assert.equal(repo.puts.length, 0);
});

test("la nota entra al índice como `nota` y se encuentra por sus palabras (contenido en el doc)", () => {
  const texto = anexarNota(null, L1, notasHeader(LABEL))!;
  const { doc, tasks } = rowsForFile(P, texto, "sha-x");
  assert.equal(doc?.kind, "nota");
  assert.equal(doc?.path, P);
  assert.equal(doc?.title, `Notas — ${LABEL}`);
  assert.ok(doc?.content.includes("decidimos cesión de 0,02 % mensual"));
  assert.deepEqual(tasks, [], "sin tareas: Norte no las ve");
});
