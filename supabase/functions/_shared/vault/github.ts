// Cliente mínimo de la API de GitHub para el vault (repo privado). Solo usa `fetch`, `atob`/`btoa` y
// `TextEncoder`: corre igual en Deno y en Node, y se prueba inyectando un `fetch` falso.
//   leer   : árbol (git/trees?recursive=1), blob por sha, archivo con su sha (contents)
//   escribir: PUT contents con el sha leído → si alguien escribió antes, GitHub responde 409/422
//             y el llamador relee y reaplica (ver ops.ts).
import type { TreeEntry } from "./types.ts";

export type GitHubConfig = {
  token: string;
  /** "owner/nombre" */
  repo: string;
  branch: string;
  fetchImpl?: typeof fetch;
  apiBase?: string;
  timeoutMs?: number;
};

export class GitHubError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "GitHubError";
    this.status = status;
  }
}

/** El sha que mandamos ya no es el actual (409) o falta/sobra (422): hay que releer y reintentar. */
export class GitHubConflict extends GitHubError {
  constructor(message: string, status: number) {
    super(message, status);
    this.name = "GitHubConflict";
  }
}

/** Lo mínimo que necesitan las operaciones de tareas: leer y escribir un archivo del repo. */
export interface RepoFiles {
  getFile(path: string): Promise<{ text: string; sha: string } | null>;
  /** `sha` null = crear archivo nuevo. Devuelve el sha del blob escrito. */
  putFile(path: string, text: string, sha: string | null, message: string): Promise<{ sha: string }>;
}

export interface GitHubApi extends RepoFiles {
  getTree(): Promise<{ sha: string; entries: TreeEntry[]; truncated: boolean }>;
  getBlob(sha: string): Promise<string>;
}

export function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}

/** `strict`: lanza si los bytes no son UTF-8 válido (ruta de escritura: nunca reescribir un archivo con � en su lugar). */
export function base64ToUtf8(b64: string, strict = false): string {
  const bin = atob(b64.replace(/\s/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  try {
    // ignoreBOM: conservar el BOM si el archivo lo trae, para reescribirlo byte a byte igual.
    return new TextDecoder("utf-8", { ignoreBOM: true, fatal: strict }).decode(bytes);
  } catch {
    throw new GitHubError("archivo no UTF-8: no se modifica", 415);
  }
}

const encodePath = (path: string) => path.split("/").map(encodeURIComponent).join("/");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createGitHub(cfg: GitHubConfig): GitHubApi {
  const doFetch = cfg.fetchImpl ?? fetch;
  const base = (cfg.apiBase ?? "https://api.github.com").replace(/\/$/, "");
  const repoUrl = `${base}/repos/${cfg.repo}`;
  const timeoutMs = cfg.timeoutMs ?? 15_000;

  // Nunca se arma un mensaje de error con el token ni con el contenido de los archivos.
  async function request(method: string, url: string, body?: unknown, allow404 = false): Promise<unknown> {
    const maxTries = method === "GET" ? 2 : 1; // un reintento ante fallos de red o 5xx en lecturas
    for (let tries = 1; ; tries++) {
      let res: Response;
      try {
        res = await doFetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${cfg.token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "wabid-vault",
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        if (tries < maxTries) {
          await sleep(300);
          continue;
        }
        throw new GitHubError("No pude conectar con GitHub", 0);
      }
      if (res.ok) return res.status === 204 ? null : await res.json();
      if (res.status === 404 && allow404) return null;
      if (res.status >= 500 && tries < maxTries) {
        await sleep(300);
        continue;
      }
      let detail = "";
      try {
        detail = String(((await res.json()) as { message?: unknown })?.message ?? "");
      } catch { /* sin cuerpo JSON */ }
      if (res.status === 409 || res.status === 422) throw new GitHubConflict(detail || "Conflicto de versión", res.status);
      const limited = res.status === 429 || (res.status === 403 && (res.headers.get("x-ratelimit-remaining") === "0" || res.headers.get("retry-after")));
      if (limited) {
        const wait = res.headers.get("retry-after");
        throw new GitHubError(`GitHub limitó las peticiones${wait ? `; reintenta en ${wait} s` : ""}`, 429);
      }
      if (res.status === 401) throw new GitHubError("GitHub rechazó el token (401): revisa VAULT_GITHUB_TOKEN", 401);
      if (res.status === 403) throw new GitHubError(`GitHub negó el acceso (403)${detail ? `: ${detail}` : ""}`, 403);
      if (res.status === 404) throw new GitHubError("GitHub no encontró el repo, la rama o el archivo (404): revisa VAULT_REPO, VAULT_BRANCH y los permisos del token", 404);
      throw new GitHubError(`GitHub respondió ${res.status}${detail ? `: ${detail}` : ""}`, res.status);
    }
  }

  // El índice tolera bytes raros (los muestra como �); la ruta de escritura (getFile) no.
  async function getBlob(sha: string, strict = false): Promise<string> {
    const json = (await request("GET", `${repoUrl}/git/blobs/${encodeURIComponent(sha)}`)) as { content: string; encoding: string };
    return json.encoding === "base64" ? base64ToUtf8(json.content, strict) : json.content;
  }

  return {
    async getTree() {
      const json = (await request("GET", `${repoUrl}/git/trees/${encodeURIComponent(cfg.branch)}?recursive=1`)) as {
        sha: string;
        tree: TreeEntry[];
        truncated?: boolean;
      };
      return { sha: json.sha, entries: json.tree ?? [], truncated: json.truncated === true };
    },

    getBlob,

    async getFile(path) {
      const json = (await request("GET", `${repoUrl}/contents/${encodePath(path)}?ref=${encodeURIComponent(cfg.branch)}`, undefined, true)) as
        | { type?: string; content?: string; encoding?: string; sha: string; size?: number }
        | unknown[]
        | null;
      if (json === null) return null;
      if (Array.isArray(json) || (json as { type?: string }).type !== "file") throw new GitHubError(`${path} no es un archivo`, 400);
      const f = json as { content?: string; encoding?: string; sha: string; size?: number };
      // Los archivos de más de 1 MB no traen contenido en este endpoint: se lee el blob.
      if (f.encoding === "base64" && typeof f.content === "string" && (f.content.length > 0 || !f.size)) {
        return { text: base64ToUtf8(f.content, true), sha: f.sha };
      }
      return { text: await getBlob(f.sha, true), sha: f.sha };
    },

    async putFile(path, text, sha, message) {
      const json = (await request("PUT", `${repoUrl}/contents/${encodePath(path)}`, {
        message,
        content: utf8ToBase64(text),
        branch: cfg.branch,
        ...(sha ? { sha } : {}),
      })) as { content?: { sha?: string } };
      const newSha = json?.content?.sha;
      if (!newSha) throw new GitHubError("GitHub no devolvió el sha del archivo escrito", 502);
      return { sha: newSha };
    },
  };
}
