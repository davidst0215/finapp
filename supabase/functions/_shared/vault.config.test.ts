// node --experimental-strip-types --test supabase/functions/_shared/vault.config.test.ts
// La config de proyectos de Norte llega por el vault: la sincronización la guarda en vault_sync y los pedidos la leen de ahí; el
// secreto VAULT_PROJECTS_JSON es solo el respaldo. Una config rota no pisa la buena y nada de esto puede tumbar un pedido ni el sync.
import { capturarLog, ENV, OWNER, type Row } from "../agent/tools/testlib.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { CONFIG_PATH } from "./vault/config.ts";

const { sincronizarConfig, vaultEnvConConfig } = await import("./vault.ts");

const BUENA = JSON.stringify({ trabajo: { Acme: ["acme-ventas"] } });
const OTRA = JSON.stringify({ trabajo: { Beta: ["beta-1"] } });
const ARBOL = (sha = "c1") => [{ path: CONFIG_PATH, type: "blob", sha }, { path: "20-projects/x/pendientes.md", type: "blob", sha: "s" }];

/** vault_sync en memoria: lo justo para leer config_sha/config_json y hacer upsert. */
function dbConfig(fila: Row | null, { lanza = false, errorUpsert = false } = {}) {
  const e = { fila, upserts: [] as Row[], lecturas: 0 };
  const db = {
    from: (t: string) => {
      assert.equal(t, "vault_sync");
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => {
              e.lecturas++;
              if (lanza) throw new Error("base caída");
              return { data: e.fila, error: null };
            },
          }),
        }),
        upsert: async (row: Row) => {
          e.upserts.push(row);
          if (errorUpsert) return { error: { message: "rls" } };
          e.fila = { ...(e.fila ?? {}), ...row };
          return { error: null };
        },
      };
    },
  };
  return { db: db as never, e };
}
const ghCon = (texto: string | Error, pedidos: string[] = []) => ({
  getBlob: async (sha: string) => {
    pedidos.push(sha);
    if (texto instanceof Error) throw texto;
    return texto;
  },
});
let n = 0;
const usuario = () => `u-${++n}`; // la caché de config es por usuario y por instancia

test("sync: la config nueva del vault se guarda (validada, sin BOM) y se registra una línea sin contenido", async () => {
  const { db, e } = dbConfig(null);
  const pedidos: string[] = [];
  const log = capturarLog();
  try {
    await sincronizarConfig(db, usuario(), ghCon(`﻿${BUENA}\r\n`, pedidos), ARBOL("c1"));
    assert.deepEqual(pedidos, ["c1"]);
    assert.equal(e.upserts.length, 1);
    assert.equal(e.upserts[0].config_sha, "c1");
    assert.equal(e.upserts[0].config_json, BUENA);
    const ev = log.eventos().find((x) => x.action === "config");
    assert.ok(ev && ev.evt === "vault" && ev.bytes === BUENA.length && ev.sha === "c1", "una línea con tamaño y sha, nunca el contenido");
    assert.ok(!JSON.stringify(log.eventos()).includes("Acme"));
  } finally {
    log.restaurar();
  }
});

test("sync: con el mismo sha no baja el archivo ni escribe; sin el archivo en el vault tampoco", async () => {
  const pedidos: string[] = [];
  const a = dbConfig({ config_sha: "c1", config_json: BUENA });
  await sincronizarConfig(a.db, usuario(), ghCon(OTRA, pedidos), ARBOL("c1"));
  const b = dbConfig(null);
  await sincronizarConfig(b.db, usuario(), ghCon(OTRA, pedidos), ARBOL().slice(1));
  assert.deepEqual(pedidos, []);
  assert.equal(a.e.upserts.length + b.e.upserts.length, 0);
});

test("sync: cambia el sha → se reemplaza la config guardada", async () => {
  const { db, e } = dbConfig({ config_sha: "c1", config_json: BUENA });
  await sincronizarConfig(db, usuario(), ghCon(OTRA), ARBOL("c2"));
  assert.deepEqual([e.upserts[0].config_sha, e.upserts[0].config_json], ["c2", OTRA]);
});

test("sync: una config rota o a medias NO pisa la buena", async () => {
  const log = capturarLog();
  try {
    for (const rota of ["{", "", "[]", '{"otra":1}', '{"trabajo":[]}']) {
      const { db, e } = dbConfig({ config_sha: "c1", config_json: BUENA });
      await sincronizarConfig(db, usuario(), ghCon(rota), ARBOL("c9"));
      assert.equal(e.upserts.length, 0, `«${rota}» no se guarda`);
      assert.equal(e.fila?.config_json, BUENA);
    }
  } finally {
    log.restaurar();
  }
});

test("sync: ningún fallo (base, red, RLS) sale hacia el sync de tareas", async () => {
  const log = capturarLog();
  try {
    // La lectura del estado guardado cae: no hay error hacia fuera (se trata como «aún no guardada» y se guarda, que es idempotente).
    await sincronizarConfig(dbConfig(null, { lanza: true }).db, usuario(), ghCon(BUENA), ARBOL());
    // GitHub falla al bajar el archivo.
    const caido = dbConfig(null);
    await sincronizarConfig(caido.db, usuario(), ghCon(new Error("GitHub 502")), ARBOL());
    assert.equal(caido.e.upserts.length, 0);
  } finally {
    log.restaurar();
  }
  // El upsert es rechazado (RLS, columnas ausentes): no lanza y NO se anuncia que se guardó.
  const log2 = capturarLog();
  try {
    const rls = dbConfig(null, { errorUpsert: true });
    await sincronizarConfig(rls.db, usuario(), ghCon(BUENA), ARBOL());
    assert.equal(rls.e.upserts.length, 1, "lo intentó y el error quedó en el log");
    assert.ok(!log2.eventos().some((x) => x.action === "config"), "si no se guardó, no se anuncia que se guardó");
  } finally {
    log2.restaurar();
  }
});

test("pedidos: la config del vault manda sobre el secreto; sin ella, el secreto; sin ninguno, todo personal", async () => {
  delete ENV.VAULT_PROJECTS_JSON;
  const u1 = usuario();
  const envVault = await vaultEnvConConfig(dbConfig({ config_json: BUENA }).db, u1);
  assert.deepEqual(Object.keys(envVault.config.trabajo), ["Acme"]);
  assert.equal(envVault.ownerId, OWNER, "el resto del entorno no cambia");

  ENV.VAULT_PROJECTS_JSON = OTRA;
  try {
    const u2 = usuario();
    assert.deepEqual(Object.keys((await vaultEnvConConfig(dbConfig({ config_json: BUENA }).db, u2)).config.trabajo), ["Acme"], "el vault gana al secreto");
    const u3 = usuario();
    assert.deepEqual(Object.keys((await vaultEnvConConfig(dbConfig({ config_json: null }).db, u3)).config.trabajo), ["Beta"], "sin config en el vault: el secreto");
    const u4 = usuario();
    assert.deepEqual(Object.keys((await vaultEnvConConfig(dbConfig(null, { lanza: true }).db, u4)).config.trabajo), ["Beta"], "la base cae: el secreto, sin error");
  } finally {
    delete ENV.VAULT_PROJECTS_JSON;
  }
  assert.deepEqual((await vaultEnvConConfig(dbConfig(null).db, usuario())).config.trabajo, {});
});

test("pedidos: la config se cachea unos segundos por usuario (una lectura, no una por pedido)", async () => {
  const { db, e } = dbConfig({ config_json: BUENA });
  const u = usuario();
  await vaultEnvConConfig(db, u);
  await vaultEnvConConfig(db, u);
  await vaultEnvConConfig(db, u);
  assert.equal(e.lecturas, 1);
});
