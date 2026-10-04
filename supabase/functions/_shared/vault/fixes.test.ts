// node --experimental-strip-types --test supabase/functions/_shared/vault/fixes.test.ts
// Regresiones de la revisión: mover con el origen cambiado, '#' en el texto y bytes no UTF-8.
import test from "node:test";
import assert from "node:assert/strict";
import { base64ToUtf8, createGitHub, GitHubConflict, GitHubError, type RepoFiles } from "./github.ts";
import { opMoveTask, PartialMoveError } from "./ops.ts";
import { buildTaskBlock, cleanText, parseTasks } from "./tasks.ts";

class Repo implements RepoFiles {
  files = new Map<string, { text: string; sha: string }>();
  puts = 0;
  n = 0;
  beforePut?: (path: string, put: number) => void;
  set(path: string, text: string) {
    this.files.set(path, { text, sha: `s${++this.n}` });
  }
  async getFile(path: string) {
    const f = this.files.get(path);
    return f ? { ...f } : null;
  }
  async putFile(path: string, text: string, sha: string | null) {
    this.puts++;
    this.beforePut?.(path, this.puts);
    const cur = this.files.get(path);
    if (cur ? cur.sha !== sha : sha !== null) throw new GitHubConflict("sha", 409);
    this.set(path, text);
    return { sha: this.files.get(path)!.sha };
  }
}

const P = "20-projects/acme-ventas/pendientes.md";
const D = "20-projects/acme-soporte/pendientes.md";
const TEXTO = "# P\n- [ ] uno\n- [ ] dos\n";

test("mover: si alguien agrega una subtarea al origen entre lecturas no se borra lo no copiado", async () => {
  const repo = new Repo();
  repo.set(P, TEXTO);
  repo.beforePut = (path, put) => {
    if (put === 2 && path === P) repo.set(P, TEXTO + "    - [ ] subtarea nueva\n");
  };
  await assert.rejects(
    opMoveTask(repo, { path: P, ref: { line: 2, raw: "- [ ] dos" }, toFolder: "acme-soporte", toLabel: "Soporte" }),
    (e: unknown) => e instanceof PartialMoveError && /cambió en el origen/.test(e.message),
  );
  assert.match(repo.files.get(P)!.text, /subtarea nueva/);
  assert.match(repo.files.get(D)!.text, /- \[ \] dos/); // duplicada, nunca perdida
});

test("mover: sin cambios en el origen sigue funcionando y la tarea ya desaparecida no es error", async () => {
  const repo = new Repo();
  repo.set(P, TEXTO);
  await opMoveTask(repo, { path: P, ref: { line: 2, raw: "- [ ] dos" }, toFolder: "acme-soporte", toLabel: "Soporte" });
  assert.equal(repo.files.get(P)!.text, "# P\n- [ ] uno\n");
  const r2 = new Repo();
  r2.set(P, TEXTO);
  r2.beforePut = (path, put) => {
    if (put === 2 && path === P) r2.set(P, "# P\n- [ ] uno\n"); // otro ya la quitó
  };
  await opMoveTask(r2, { path: P, ref: { line: 2, raw: "- [ ] dos" }, toFolder: "acme-soporte", toLabel: "Soporte" });
  assert.equal(r2.files.get(P)!.text, "# P\n- [ ] uno\n");
});

test("cleanText: quita solo el # que abre un tag", () => {
  assert.equal(cleanText("Revisar PR #42"), "Revisar PR 42");
  assert.equal(cleanText("Migrar a C# este mes"), "Migrar a C# este mes");
  assert.equal(cleanText("#fathom Llamar ##urgente x#y"), "fathom Llamar urgente x#y");
  assert.equal(buildTaskBlock({ text: "Revisar PR #42" })[0], "- [ ] Revisar PR 42");
  assert.equal(parseTasks(buildTaskBlock({ text: "C# y #tag" }).join("\n"))[0].source, null);
});

test("escritura: bytes no UTF-8 no se leen; el índice sí los tolera", async () => {
  const malo = btoa(String.fromCharCode(0x68, 0x6f, 0xe9, 0x6c, 0x61)); // 0xE9 suelto = latin1, inválido en UTF-8
  const fetchImpl = (async (url: string | URL | Request) =>
    new Response(
      JSON.stringify(String(url).includes("/git/blobs/") ? { content: malo, encoding: "base64" } : { type: "file", encoding: "base64", content: malo, sha: "S", size: 5 }),
      { status: 200 },
    )) as typeof fetch;
  const gh = createGitHub({ token: "t", repo: "o/r", branch: "main", fetchImpl });
  await assert.rejects(gh.getFile("a.md"), (e: unknown) => e instanceof GitHubError && /no UTF-8/.test((e as Error).message));
  assert.match(await gh.getBlob("S"), /ho.la/);
  assert.throws(() => base64ToUtf8(malo, true), GitHubError);
});

test("cleanText: los tags del contrato no sobreviven en ninguna posición", () => {
  for (const [entrada, texto] of [
    ["Hablar con Ana (#conjunto)", "Hablar con Ana (conjunto)"],
    ['Ver "#fathom" de ayer', 'Ver "fathom" de ayer'],
    ["x#conjunto/ana y y#destino/vera", "xconjunto/ana y ydestino/vera"],
  ] as const) {
    assert.equal(cleanText(entrada), texto);
    const [t] = parseTasks(buildTaskBlock({ text: entrada }).join("\n"));
    assert.equal(t.shared, false, entrada);
    assert.equal(t.source, null, entrada);
    assert.equal(t.suggest, null, entrada);
  }
});

test("mover: si la línea del origen fue editada (cambió de estado) se avisa en vez de dejar duplicada en silencio", async () => {
  const repo = new Repo();
  repo.set(P, TEXTO);
  repo.beforePut = (path, put) => {
    if (put === 2 && path === P) repo.set(P, "# P\n- [ ] uno\n- [x] dos ✅ 2026-10-05\n"); // David la completó en Norte
  };
  await assert.rejects(
    opMoveTask(repo, { path: P, ref: { line: 2, raw: "- [ ] dos" }, toFolder: "acme-soporte", toLabel: "Soporte" }),
    (e: unknown) => e instanceof PartialMoveError && /cambió en el origen/.test(e.message),
  );
});
