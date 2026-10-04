// node --experimental-strip-types --test supabase/functions/_shared/vault/sync.test.ts
// syncIndex por tandas con un GitHub falso (fetch interceptado) y una base falsa en memoria.
import test from "node:test";
import assert from "node:assert/strict";

// vault.ts importa llm.ts, que lee Deno.env al cargar.
(globalThis as unknown as { Deno: unknown }).Deno = { env: { get: () => undefined } };
const { syncIndex } = await import("../vault.ts");

const ENV = { token: "t", repo: "o/r", branch: "main", ownerId: "u1", config: { trabajo: {} } };

type Batch = { docs: number; files: number; remove: number; treeSha: string | null };

function fakeDb() {
  const docs = new Map<string, string>(); // path → sha
  let state: { tree_sha: string | null; synced_at: string; docs: number; tasks: number } | null = null;
  const batches: Batch[] = [];
  const builder = (table: string) => {
    const b = {
      select: () => b,
      eq: () => b,
      order: () => b,
      range: () => b,
      maybeSingle: () => Promise.resolve({ data: table === "vault_sync" ? state : null, error: null }),
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve({ data: table === "vault_docs" ? [...docs].map(([path, sha]) => ({ path, sha })) : [], error: null }).then(res, rej),
    };
    return b;
  };
  return {
    batches,
    docs,
    get state() {
      return state;
    },
    from: builder,
    rpc: (_name: string, a: { p_docs: { path: string; sha: string }[]; p_files: unknown[]; p_remove: string[]; p_tree_sha: string | null }) => {
      batches.push({ docs: a.p_docs.length, files: a.p_files.length, remove: a.p_remove.length, treeSha: a.p_tree_sha });
      a.p_remove.forEach((p) => docs.delete(p));
      a.p_docs.forEach((d) => docs.set(d.path, d.sha));
      if (a.p_tree_sha) state = { tree_sha: a.p_tree_sha, synced_at: new Date().toISOString(), docs: docs.size, tasks: 0 };
      return Promise.resolve({ data: {}, error: null });
    },
  };
}

function fakeGitHub(files: Map<string, string>) {
  const blobs = new Map<string, string>();
  const calls = { tree: 0, blobs: 0 };
  const entries = () => [...files].map(([path, text]) => {
    const sha = `sha-${path}-${text.length}`;
    blobs.set(sha, text);
    return { path, type: "blob", sha, size: text.length };
  });
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes("/git/trees/")) {
      calls.tree++;
      return new Response(JSON.stringify({ sha: `tree-${files.size}-${[...files.values()].join("").length}`, tree: entries(), truncated: false }));
    }
    const m = /\/git\/blobs\/(.+)$/.exec(u);
    if (m) {
      calls.blobs++;
      return new Response(JSON.stringify({ content: btoa(blobs.get(decodeURIComponent(m[1]))!), encoding: "base64" }));
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

test("sync por tandas: 170 archivos → 150 en la primera corrida (partial), el resto en la segunda, sha solo al final", async () => {
  const files = new Map<string, string>();
  for (let i = 0; i < 170; i++) files.set(`30-areas/bulk/n${i}.md`, `# Nota ${i}\ncontenido`);
  const gh = fakeGitHub(files);
  const db = fakeDb();
  try {
    const a = await syncIndex(db as never, "u1", ENV, {});
    assert.equal(a.partial, true);
    assert.equal(a.added, 150);
    assert.equal(gh.calls.blobs, 150);
    assert.deepEqual(db.batches.map((b) => b.docs), [25, 25, 25, 25, 25, 25]); // tandas de 25
    assert.ok(db.batches.every((b) => b.treeSha === null), "ningún lote guarda el sha del árbol");
    assert.equal(db.state, null);

    const b = await syncIndex(db as never, "u1", ENV, {});
    assert.equal(b.partial, false);
    assert.equal(b.added, 20);
    assert.equal(gh.calls.blobs, 170); // solo bajó lo que faltaba
    const ultimo = db.batches.at(-1)!;
    assert.equal(ultimo.docs, 20);
    assert.ok(ultimo.treeSha, "el último lote sí guarda el sha del árbol");
    assert.equal(db.batches.slice(0, -1).filter((x) => x.treeSha).length, 0);
    assert.ok(db.state?.tree_sha);
    assert.equal(db.docs.size, 170);

    const c = await syncIndex(db as never, "u1", ENV, {});
    assert.deepEqual([c.partial, c.added, c.updated], [false, 0, 0]);
    assert.equal(gh.calls.blobs, 170); // árbol igual: ni un blob más
  } finally {
    gh.restore();
  }
});

test("sync por tandas: con cambios nuevos tras una sync completa, el sha viejo se conserva hasta terminar", async () => {
  const files = new Map<string, string>();
  for (let i = 0; i < 10; i++) files.set(`30-areas/a/n${i}.md`, `# ${i}`);
  const gh = fakeGitHub(files);
  const db = fakeDb();
  try {
    await syncIndex(db as never, "u1", ENV, {});
    const viejo = db.state!.tree_sha;
    for (let i = 0; i < 160; i++) files.set(`30-areas/b/m${i}.md`, `# m${i}`);
    files.delete("30-areas/a/n0.md");
    const p = await syncIndex(db as never, "u1", ENV, {});
    assert.equal(p.partial, true);
    assert.equal(db.state!.tree_sha, viejo); // sigue el anterior: la próxima corrida vuelve a comparar
    assert.equal(db.batches.find((b) => b.remove > 0)?.remove, 1);
    const q = await syncIndex(db as never, "u1", ENV, {});
    assert.equal(q.partial, false);
    assert.notEqual(db.state!.tree_sha, viejo);
    assert.equal(db.docs.size, 169);
  } finally {
    gh.restore();
  }
});
