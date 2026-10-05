// Copia de los scripts que corren FUERA de permisos (hooks y runner) a una carpeta propia, %LOCALAPPDATA%\Wabid\bin.
// Motivo: una tarea de Claude con permiso de edición sobre el repo finapp no debe poder reescribir el código que
// luego ejecutan los hooks (en cada sesión) o el runner (al iniciar sesión). Los instaladores apuntan ahí.
// Regla: NO agregues esa carpeta ni finapp a la allowlist del runner. Tras actualizar finapp, vuelve a correr los instaladores.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const BIN_FILES = ["wabid-hook.mjs", "wabid-runner.mjs"];

export function binDir(env = process.env, platform = process.platform, home = os.homedir()) {
  if (env.WABID_BIN_DIR) return env.WABID_BIN_DIR; // para probar los instaladores sin tocar el %LOCALAPPDATA% real
  if (platform === "win32") return path.win32.join(env.LOCALAPPDATA || path.win32.join(home, "AppData", "Local"), "Wabid", "bin");
  return path.posix.join(env.XDG_DATA_HOME || path.posix.join(home, ".local", "share"), "wabid", "bin");
}

const realIo = { mkdir: (d) => mkdirSync(d, { recursive: true }), exists: existsSync, read: (p) => readFileSync(p), write: (p, b) => writeFileSync(p, b) };

// Copia solo lo que cambió. Devuelve { copied: [...], unchanged: [...] }. Con dryRun no escribe nada.
export function copyToBin({ srcDir, destDir, files = BIN_FILES, dryRun = false, io = realIo, join = path.join }) {
  const copied = [];
  const unchanged = [];
  if (!dryRun) io.mkdir(destDir);
  for (const name of files) {
    const from = join(srcDir, name);
    const to = join(destDir, name);
    const body = io.read(from);
    if (io.exists(to) && Buffer.compare(Buffer.from(io.read(to)), Buffer.from(body)) === 0) {
      unchanged.push(name);
      continue;
    }
    if (!dryRun) io.write(to, body);
    copied.push(name);
  }
  return { copied, unchanged };
}
