// Piezas falsas para probar los handlers del agente en Node sin red ni base: un Supabase en memoria, un modelo guionado y un
// GitHub falso. Solo lo importan las pruebas (*.test.ts); no forma parte de ninguna función desplegada.
//
// Importar este archivo PRIMERO: instala el `Deno.env` que leen los módulos del vault al cargarse.
export const OWNER = "27486991-0000-0000-0000-000000000000";
export const ENV: Record<string, string> = {
  OPENROUTER_API_KEY: "test", VAULT_GITHUB_TOKEN: "t", VAULT_REPO: "dueno/repo", VAULT_OWNER_ID: OWNER,
};
// deno-lint-ignore no-explicit-any
(globalThis as any).Deno = { env: { get: (k: string) => ENV[k] } };

export type Row = Record<string, unknown>;

/** Un Supabase en memoria: lee las tablas dadas (eq / in / like / order / range) y responde los rpc con funciones. */
export function fakeDb(tablas: Record<string, Row[]>, rpcs: Record<string, (a: Record<string, unknown>) => Row[]> = {}) {
  const llamadas: { rpc: string; args: Record<string, unknown> }[] = [];
  /** Cada `.select(cols)` que se hizo, para comprobar qué columnas se leyeron (p. ej. que no se bajó el `content` de las fichas). */
  const lecturas: { table: string; cols: string }[] = [];
  const builder = (rows: Row[], tabla: string) => {
    let data = rows;
    let columnas: string[] | null = null; // como PostgREST: solo vuelven las columnas pedidas
    const proyectar = (filas: Row[]) => (columnas ? filas.map((r) => Object.fromEntries(columnas!.map((c) => [c, r[c]]))) : filas);
    // deno-lint-ignore no-explicit-any
    const b: any = {
      select: (cols?: string) => {
        lecturas.push({ table: tabla, cols: cols ?? "*" });
        columnas = cols && cols.trim() !== "*" ? cols.split(",").map((c) => c.trim()) : null;
        return b;
      },
      eq: (c: string, v: unknown) => ((data = data.filter((r) => r[c] === v)), b),
      in: (c: string, vs: unknown[]) => ((data = data.filter((r) => vs.includes(r[c]))), b),
      like: (c: string, pat: string) => {
        const re = new RegExp(`^${pat.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*")}$`);
        data = data.filter((r) => re.test(String(r[c])));
        return b;
      },
      order: (c: string, o?: { ascending?: boolean }) => {
        const dir = o?.ascending === false ? -1 : 1;
        data = [...data].sort((x, y) => (String(x[c] ?? "") < String(y[c] ?? "") ? -dir : String(x[c] ?? "") > String(y[c] ?? "") ? dir : 0));
        return b;
      },
      neq: (c: string, v: unknown) => ((data = data.filter((r) => r[c] !== v)), b),
      gte: (c: string, v: string) => ((data = data.filter((r) => String(r[c]) >= v)), b),
      lt: (c: string, v: string) => ((data = data.filter((r) => String(r[c]) < v)), b),
      or: () => b,
      limit: (n: number) => ((data = data.slice(0, n)), b),
      range: (from: number, to: number) => ((data = data.slice(from, to + 1)), b),
      maybeSingle: async () => ({ data: proyectar(data)[0] ?? null, error: null }),
      then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve({ data: proyectar(data), error: null }).then(ok, ko),
    };
    return b;
  };
  const db = {
    from: (t: string) => builder(tablas[t] ?? [], t),
    rpc: (name: string, args: Record<string, unknown>) => {
      llamadas.push({ rpc: name, args });
      return Promise.resolve({ data: rpcs[name]?.(args) ?? [], error: null });
    },
  };
  return { db, llamadas, lecturas };
}

export type Peticion = { messages: { role: string; content: string }[] };

/** Modelo guionado: cada pedido consume una respuesta; guarda lo que recibió. Con `{status}` responde un error HTTP; con `{texto, demoraMs}`, tarda. */
export function modeloGuionado(respuestas: (string | { status: number } | { texto: string; demoraMs: number })[]) {
  const peticiones: Peticion[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    peticiones.push(JSON.parse(init?.body ?? "{}"));
    const siguiente = respuestas.shift() ?? "No lo encuentro en tus fichas.";
    if (typeof siguiente === "object" && "demoraMs" in siguiente) await new Promise((ok) => setTimeout(ok, siguiente.demoraMs));
    const r = typeof siguiente === "object" && "demoraMs" in siguiente ? siguiente.texto : siguiente;
    if (typeof r !== "string") return { ok: false, status: r.status, json: async () => ({}), text: async () => "" };
    const data = { choices: [{ message: { content: r } }], usage: { prompt_tokens: 1000, completion_tokens: 40 } };
    return { ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) };
  }) as typeof fetch;
  return { peticiones, restaurar: () => { globalThis.fetch = original; } };
}

/** GitHub falso: lee los archivos dados (ruta → texto) y apunta lo que se escribiría. Nada sale a la red. */
export function githubFalso(archivos: Record<string, string> = {}) {
  const escrituras: { path: string; text: string; message: string }[] = [];
  const original = globalThis.fetch;
  const b64 = (t: string) => btoa(String.fromCharCode(...new TextEncoder().encode(t)));
  const deB64 = (b: string) => new TextDecoder().decode(Uint8Array.from(atob(b), (c) => c.charCodeAt(0)));
  globalThis.fetch = (async (url: string, init?: { method?: string; body?: string }) => {
    const m = /\/contents\/([^?]+)/.exec(String(url));
    const path = m ? decodeURIComponent(m[1]) : "";
    if (init?.method === "PUT") {
      const body = JSON.parse(init.body ?? "{}");
      escrituras.push({ path, text: deB64(body.content), message: body.message });
      return { ok: true, status: 200, json: async () => ({ content: { sha: "sha-nuevo" } }) };
    }
    const texto = archivos[path];
    if (texto === undefined) return { ok: false, status: 404, json: async () => ({}), headers: new Headers() };
    return { ok: true, status: 200, json: async () => ({ type: "file", encoding: "base64", content: b64(texto), sha: "sha-viejo", size: texto.length }) };
  }) as unknown as typeof fetch;
  return { escrituras, restaurar: () => { globalThis.fetch = original; } };
}

/** Captura console.log (como objetos JSON) y silencia console.error durante una prueba. */
export function capturarLog() {
  const lineas: string[] = [];
  const log = console.log, error = console.error;
  console.log = (...a: unknown[]) => void lineas.push(a.map(String).join(" "));
  console.error = () => {};
  return {
    eventos: () => lineas.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) as Row[],
    restaurar: () => { console.log = log; console.error = error; },
  };
}

export const doc = (path: string, kind: string, title: string, o: Row = {}): Row => ({
  user_id: OWNER, path, kind, title, cliente: null, proyecto: null, padre: null, tags: [], links: [], content: "", ...o,
});
export const tarea = (path: string, folder: string, line: number, text: string, o: Row = {}): Row => ({
  user_id: OWNER, path, folder, line, text, status: "pending", priority: 0, due: null, done_on: null, note: null, parent_line: null, scheduled: null,
  raw: `- [ ] ${text}`, recurring: null, shared: false, shared_with: null, suggest: null, source: null, indent: 0, ...o,
});
