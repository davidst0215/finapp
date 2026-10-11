// node --experimental-strip-types --test supabase/functions/_shared/vault.alias.test.ts
// El caché de alias de proyectos es por usuario Y por versión del vault: dos usuarios con el MISMO tree_sha no se mezclan.
import test from "node:test";
import assert from "node:assert/strict";
import { doc, fakeDb, OWNER } from "../agent/tools/testlib.ts";
import { EMPTY_CONFIG } from "./vault/taxonomy.ts";

const { cargarIndiceProyectos } = await import("./vault.ts");

const OTRO = "99999999-0000-0000-0000-000000000000";
const SHA = "sha-compartido";

// Cada usuario tiene sus fichas y sus carpetas; los dos comparten tree_sha (por ejemplo, vaults recién sincronizados con el mismo hash).
const tablas = {
  vault_sync: [
    { user_id: OWNER, tree_sha: SHA, synced_at: "2026-10-11T00:00:00Z", docs: 3, tasks: 0 },
    { user_id: OTRO, tree_sha: SHA, synced_at: "2026-10-11T00:00:00Z", docs: 3, tasks: 0 },
  ],
  vault_docs: [
    { ...doc("60-wiki/proyectos/alfa.md", "ficha", "Alfa", { cliente: "AlfaCorp", content: "Vault 20-projects/alfa-*/pendientes.md" }) },
    { ...doc("20-projects/alfa-uno/pendientes.md", "pendientes", "Pendientes — Uno") },
    { ...doc("20-projects/alfa-dos/pendientes.md", "pendientes", "Pendientes — Dos") },
    { ...doc("60-wiki/proyectos/beta.md", "ficha", "Beta", { cliente: "BetaCorp", content: "Vault 20-projects/beta-*/pendientes.md" }), user_id: OTRO },
    { ...doc("20-projects/beta-uno/pendientes.md", "pendientes", "Pendientes — Uno"), user_id: OTRO },
    { ...doc("20-projects/beta-dos/pendientes.md", "pendientes", "Pendientes — Dos"), user_id: OTRO },
  ],
};

for (const nivel of ["ligero", "completo"] as const) {
  test(`caché de alias (${nivel}): dos usuarios con el mismo tree_sha no comparten fichas`, async () => {
    const { db } = fakeDb(tablas);
    const palabras = (ix: Awaited<ReturnType<typeof cargarIndiceProyectos>>) => ix.destinos.flatMap((d) => d.palabras);

    // primero A (queda en el caché), luego B con el mismo sha, y otra vez A
    const a1 = await cargarIndiceProyectos(db as never, OWNER, EMPTY_CONFIG, nivel);
    const b = await cargarIndiceProyectos(db as never, OTRO, EMPTY_CONFIG, nivel);
    const a2 = await cargarIndiceProyectos(db as never, OWNER, EMPTY_CONFIG, nivel);

    assert.deepEqual(a1.destinos.map((d) => d.folder), ["alfa-dos", "alfa-uno"].sort());
    assert.deepEqual(b.destinos.map((d) => d.folder), ["beta-dos", "beta-uno"].sort());
    assert.ok(palabras(a1).includes("alfacorp") && !palabras(a1).includes("betacorp"), "A solo ve sus fichas");
    assert.ok(palabras(b).includes("betacorp") && !palabras(b).includes("alfacorp"), "B no hereda las de A");
    assert.ok(palabras(a2).includes("alfacorp") && !palabras(a2).includes("betacorp"), "y A sigue con las suyas");
  });
}

test("caché de alias: un tree_sha distinto vuelve a leer, y el mismo no lee dos veces", async () => {
  const { db, lecturas } = fakeDb(tablas);
  const lecturasDeFichas = () => lecturas.filter((l) => l.table === "vault_docs" && l.cols.startsWith("path, cliente, padre")).length;
  await cargarIndiceProyectos(db as never, OWNER, EMPTY_CONFIG, "completo");
  const tras1 = lecturasDeFichas();
  await cargarIndiceProyectos(db as never, OWNER, EMPTY_CONFIG, "completo");
  assert.equal(lecturasDeFichas(), tras1, "mismo usuario y mismo sha: del caché");
  const nuevo = { ...tablas, vault_sync: tablas.vault_sync.map((r) => ({ ...r, tree_sha: "sha-otro" })) };
  const { db: db2, lecturas: l2 } = fakeDb(nuevo);
  await cargarIndiceProyectos(db2 as never, OWNER, EMPTY_CONFIG, "completo");
  assert.equal(l2.filter((l) => l.table === "vault_docs" && l.cols.startsWith("path, cliente, padre")).length, 1, "otro sha: se vuelve a leer");
});
