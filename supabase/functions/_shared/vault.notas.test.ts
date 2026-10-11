// node --experimental-strip-types --test supabase/functions/_shared/vault.notas.test.ts
// agregarNota (el pegamento entre la nota y GitHub): el destino se valida contra las carpetas que EXISTEN, el texto largo se rechaza y
// nada de eso llega a escribir. GitHub es un doble que solo apunta lo que se escribiría.
import test from "node:test";
import assert from "node:assert/strict";
import { doc, fakeDb, githubFalso, OWNER } from "../agent/tools/testlib.ts";
import { MAX_NOTA, MENSAJE_NOTA_LARGA } from "./vault/notas.ts";

const { agregarNota, vaultEnv, VaultError } = await import("./vault.ts");

const VAULT = () => ({
  vault_sync: [{ user_id: OWNER, tree_sha: "sha1", synced_at: "2026-10-11T00:00:00Z", docs: 2, tasks: 0 }],
  vault_docs: [
    doc("60-wiki/proyectos/novafondos.md", "ficha", "Novafondos", { cliente: "Novafondos", content: "" }),
    doc("20-projects/novafondos-app/pendientes.md", "pendientes", "Pendientes — novafondos-app"),
  ],
  vault_tasks: [],
});
const entrada = (folder: unknown, extra: Record<string, unknown> = {}) => ({ folder, texto: "decidimos algo", hoy: "2026-10-11", minutos: 720, ...extra });

test("una carpeta que no existe o con ruta rara se rechaza y NO escribe (ni en 60-wiki ni en ningún otro lado)", async () => {
  const { db, llamadas } = fakeDb(VAULT());
  const gh = githubFalso();
  try {
    const env = vaultEnv();
    for (const folder of ["no-existe", "../60-wiki/proyectos", "..", "60-wiki/proyectos", "a/b", "x y", "novafondos-app/../lota", 7, { toString: () => "novafondos-app" }]) {
      await assert.rejects(() => agregarNota(db as never, OWNER, env, entrada(folder)), VaultError, String(JSON.stringify(folder)));
    }
    assert.equal(gh.escrituras.length, 0, "ninguna escritura a GitHub");
    assert.equal(llamadas.filter((l) => l.rpc === "vault_apply_sync").length, 0, "ninguna fila al índice");

    // los dos mensajes: ruta inválida vs carpeta desconocida
    await assert.rejects(() => agregarNota(db as never, OWNER, env, entrada("../x")), /Carpeta inválida/);
    await assert.rejects(() => agregarNota(db as never, OWNER, env, entrada("no-existe")), /No conozco la carpeta «no-existe»/);

    // y la carpeta que sí existe funciona (la prueba no es solo «todo falla»)
    const ok = await agregarNota(db as never, OWNER, env, entrada("novafondos-app", { cliente: "Novafondos" }));
    assert.equal(ok.folder, "novafondos-app");
    assert.equal(gh.escrituras.length, 1);
    assert.equal(gh.escrituras[0].path, "20-projects/novafondos-app/notas.md");
  } finally {
    gh.restaurar();
  }
});

test("sin carpeta cae al cajón; texto vacío o más largo que el tope se rechaza (no se recorta) sin tocar GitHub", async () => {
  const { db } = fakeDb(VAULT());
  const gh = githubFalso();
  try {
    const env = vaultEnv();
    const cajon = await agregarNota(db as never, OWNER, env, entrada(undefined));
    assert.equal(cajon.folder, "cajon-desastre");
    assert.equal(gh.escrituras.length, 1);

    await assert.rejects(() => agregarNota(db as never, OWNER, env, entrada("novafondos-app", { texto: "  \n " })), /Falta el texto de la nota/);
    await assert.rejects(() => agregarNota(db as never, OWNER, env, entrada("novafondos-app", { texto: "x".repeat(MAX_NOTA + 1) })), (e: Error) => e.message === MENSAJE_NOTA_LARGA);
    assert.equal(gh.escrituras.length, 1, "las dos rechazadas no escribieron");
    await agregarNota(db as never, OWNER, env, entrada("novafondos-app", { texto: "x".repeat(MAX_NOTA) }));
    assert.equal(gh.escrituras.length, 2, "justo en el tope sí");
  } finally {
    gh.restaurar();
  }
});
