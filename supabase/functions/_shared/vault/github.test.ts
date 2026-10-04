// node --experimental-strip-types --test supabase/functions/_shared/vault/github.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { base64ToUtf8, createGitHub, GitHubConflict, GitHubError, utf8ToBase64 } from "./github.ts";

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

function mock(handler: (call: Call, n: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(url),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    return await handler(call, calls.length);
  }) as typeof fetch;
  const gh = createGitHub({ token: "tok_secreto", repo: "dueño/vault", branch: "main", fetchImpl, timeoutMs: 2000 });
  return { gh, calls };
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

test("base64 ida y vuelta con tildes, emojis, BOM y textos grandes (más de un trozo)", () => {
  for (const t of ["", "hola", "Pendientes — Cajón ✅ 📅 2026-10-05 ⏫", "﻿con BOM", "línea\r\nlínea\n", "ñ".repeat(40_000) + "😀".repeat(5_000)]) {
    assert.equal(base64ToUtf8(utf8ToBase64(t)), t);
  }
  // GitHub parte el base64 en líneas de 60 caracteres
  const partido = utf8ToBase64("x".repeat(200)).replace(/(.{60})/g, "$1\n");
  assert.equal(base64ToUtf8(partido), "x".repeat(200));
});

test("getTree: URL, cabeceras y bandera de truncado", async () => {
  const { gh, calls } = mock(() => json({ sha: "T1", tree: [{ path: "a.md", type: "blob", sha: "s1", size: 3 }], truncated: false }));
  const t = await gh.getTree();
  assert.equal(calls[0].url, "https://api.github.com/repos/dueño/vault/git/trees/main?recursive=1");
  assert.equal(calls[0].headers.Authorization, "Bearer tok_secreto");
  assert.equal(calls[0].headers.Accept, "application/vnd.github+json");
  assert.equal(calls[0].headers["User-Agent"], "wabid-vault");
  assert.deepEqual(t, { sha: "T1", entries: [{ path: "a.md", type: "blob", sha: "s1", size: 3 }], truncated: false });
  const trunc = mock(() => json({ sha: "T2", tree: [], truncated: true }));
  assert.equal((await trunc.gh.getTree()).truncated, true);
});

test("getFile: decodifica, codifica la ruta por segmentos y devuelve null en 404", async () => {
  const texto = "# Pendientes — Cajón\n- [ ] algo ✅\n";
  const { gh, calls } = mock((c) =>
    c.url.includes("falta") ? json({ message: "Not Found" }, 404) : json({ type: "file", encoding: "base64", content: utf8ToBase64(texto), sha: "S1", size: 40 })
  );
  assert.deepEqual(await gh.getFile("20-projects/mi carpeta/pendientes.md"), { text: texto, sha: "S1" });
  assert.equal(calls[0].url, "https://api.github.com/repos/dueño/vault/contents/20-projects/mi%20carpeta/pendientes.md?ref=main");
  assert.equal(await gh.getFile("20-projects/falta/pendientes.md"), null);
});

test("getFile: un directorio no es un archivo; un archivo grande se lee como blob", async () => {
  const dir = mock(() => json([{ type: "file" }]));
  await assert.rejects(dir.gh.getFile("20-projects"), GitHubError);
  const grande = mock((c) =>
    c.url.includes("/git/blobs/") ? json({ content: utf8ToBase64("grande"), encoding: "base64" }) : json({ type: "file", encoding: "none", content: "", sha: "BIG", size: 2_000_000 })
  );
  assert.deepEqual(await grande.gh.getFile("x.md"), { text: "grande", sha: "BIG" });
});

test("putFile: manda contenido en base64, rama y sha; sin sha crea el archivo", async () => {
  const { gh, calls } = mock(() => json({ content: { sha: "NUEVO" } }, 200));
  assert.deepEqual(await gh.putFile("20-projects/a/pendientes.md", "- [ ] ñandú ✅", "VIEJO", "wabid: prueba"), { sha: "NUEVO" });
  assert.equal(calls[0].method, "PUT");
  assert.deepEqual(calls[0].body, { message: "wabid: prueba", content: utf8ToBase64("- [ ] ñandú ✅"), branch: "main", sha: "VIEJO" });
  await gh.putFile("20-projects/a/pendientes.md", "x", null, "wabid: crear");
  assert.equal("sha" in (calls[1].body as object), false);
});

test("putFile: 409 y 422 son conflicto (relee y reaplica); el resto son errores normales", async () => {
  for (const status of [409, 422]) {
    const { gh } = mock(() => json({ message: "sha no coincide" }, status));
    await assert.rejects(gh.putFile("a.md", "x", "S", "m"), (e: unknown) => e instanceof GitHubConflict && e.status === status && /sha no coincide/.test((e as Error).message));
  }
  const nf = mock(() => json({ message: "Not Found" }, 404));
  await assert.rejects(nf.gh.putFile("a.md", "x", "S", "m"), (e: unknown) => e instanceof GitHubError && !(e instanceof GitHubConflict) && e.status === 404);
});

test("errores: 401, 403 con límite, 5xx; el token nunca aparece en los mensajes", async () => {
  const casos: [Response, RegExp, number][] = [
    [json({ message: "Bad credentials" }, 401), /rechazó el token/, 401],
    [json({ message: "API rate limit exceeded" }, 403, { "x-ratelimit-remaining": "0" }), /limitó las peticiones/, 429],
    [json({ message: "secondary" }, 403, { "retry-after": "30" }), /reintenta en 30 s/, 429],
    [json({ message: "Resource not accessible" }, 403), /negó el acceso/, 403],
    [json({ message: "boom" }, 500), /500/, 500],
  ];
  for (const [res, re, status] of casos) {
    const { gh } = mock(() => res.clone());
    await assert.rejects(gh.putFile("a.md", "x", null, "m"), (e: unknown) => {
      const err = e as GitHubError;
      assert.equal(err.status, status);
      assert.match(err.message, re);
      assert.equal(err.message.includes("tok_secreto"), false);
      return true;
    });
  }
});

test("lecturas: un reintento ante 5xx o caída de red; las escrituras no se reintentan", async () => {
  let n = 0;
  const flaky = mock(() => (++n === 1 ? json({ message: "bad gateway" }, 502) : json({ sha: "T", tree: [] })));
  assert.equal((await flaky.gh.getTree()).sha, "T");
  assert.equal(flaky.calls.length, 2);

  let m = 0;
  const red = createGitHub({
    token: "t", repo: "o/r", branch: "main",
    fetchImpl: (async () => { m++; throw new TypeError("fetch failed"); }) as typeof fetch,
  });
  await assert.rejects(red.getTree(), (e: unknown) => e instanceof GitHubError && e.status === 0 && /No pude conectar/.test((e as Error).message));
  assert.equal(m, 2);

  let p = 0;
  const put = mock(() => { p++; return json({ message: "bad gateway" }, 502); });
  await assert.rejects(put.gh.putFile("a.md", "x", null, "m"), GitHubError);
  assert.equal(p, 1);
});

test("putFile: si GitHub no devuelve el sha nuevo es un error", async () => {
  const { gh } = mock(() => json({ content: {} }));
  await assert.rejects(gh.putFile("a.md", "x", null, "m"), /sha/);
});
