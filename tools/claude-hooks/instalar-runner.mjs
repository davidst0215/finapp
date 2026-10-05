// Crea (o quita) la tarea programada de Windows que arranca wabid-runner.mjs al iniciar sesión, oculta.
//
//   node tools/claude-hooks/instalar-runner.mjs              crea / actualiza la tarea (idempotente)
//   node tools/claude-hooks/instalar-runner.mjs --quitar     la elimina
//   node tools/claude-hooks/instalar-runner.mjs --dry-run    imprime lo que haría y no toca nada (también con --quitar)
//
// Cómo queda: copia de wabid-runner.mjs y wabid-hook.mjs en %LOCALAPPDATA%\Wabid\bin (fuera del repo: una tarea con permiso
// de edición sobre finapp no puede reescribir lo que corre al iniciar sesión; vuelve a correr esto tras actualizar finapp),
// %LOCALAPPDATA%\Wabid\wabid-runner.vbs (lanza node sin ventana, como pendientes-app\scripts\vault-sync.vbs)
// y una tarea "Wabid Runner" (disparador: al iniciar sesión, mi usuario, sin privilegios elevados) que ejecuta ese .vbs.
// No agregues finapp ni esa carpeta bin a la allowlist del runner.
// Si Windows responde "Acceso denegado" al crearla, abre PowerShell como administrador y repite.
// Sin shell: schtasks se llama con un arreglo de argumentos.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { binDir, copyToBin } from "./bin-copy.mjs";

export const TASK_NAME = "Wabid Runner";

// Una ruta con comillas no es válida en Windows y rompería el .vbs: se rechaza en vez de escaparla.
function assertSafePath(p, label) {
  if (typeof p !== "string" || !p || /["\r\n\0]/.test(p)) throw new Error(`${label} no es una ruta válida`);
}

const vbsQuote = (s) => `""${s}""`; // dentro de una cadena VBS, " se escribe ""

export function vbsContent({ nodePath, runnerPath }) {
  assertSafePath(nodePath, "node");
  assertSafePath(runnerPath, "wabid-runner.mjs");
  return [
    "' Lanza wabid-runner.mjs sin abrir ventana (la tarea programada de Windows llama a este archivo).",
    "' Generado por tools/claude-hooks/instalar-runner.mjs; se regenera al volver a correrlo.",
    `CreateObject("WScript.Shell").Run "${vbsQuote(nodePath)} ${vbsQuote(runnerPath)}", 0, False`,
    "",
  ].join("\r\n");
}

export function defaultPaths({ env = process.env, home = os.homedir(), nodePath = process.execPath, moduleUrl = import.meta.url } = {}) {
  const base = path.win32.join(env.LOCALAPPDATA || path.win32.join(home, "AppData", "Local"), "Wabid");
  const bin = binDir(env, "win32", home);
  return {
    nodePath,
    srcDir: path.dirname(fileURLToPath(moduleUrl)), // el repo: de aquí se copia
    binDir: bin,
    runnerPath: path.win32.join(bin, "wabid-runner.mjs"), // lo que ejecuta la tarea: la copia, no el repo
    vbsPath: path.win32.join(base, "wabid-runner.vbs"),
    dir: base,
  };
}

// Qué se ejecutaría, sin ejecutarlo.
export function buildPlan(paths, taskName = TASK_NAME) {
  assertSafePath(paths.vbsPath, "el .vbs");
  return {
    vbs: vbsContent(paths),
    vbsPath: paths.vbsPath,
    // ONLOGON del usuario actual, nivel limitado (sin elevar), /F reemplaza la tarea si ya existe: idempotente.
    createArgs: ["/Create", "/TN", taskName, "/TR", `wscript.exe "${paths.vbsPath}"`, "/SC", "ONLOGON", "/RL", "LIMITED", "/F"],
    queryArgs: ["/Query", "/TN", taskName],
    deleteArgs: ["/Delete", "/TN", taskName, "/F"],
  };
}

const realExec = (args) => execFileSync("schtasks", args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, encoding: "utf8" });

// io: { exec(args), exists(path), read(path), write(path, text), mkdir(dir), remove(path), out(line) } (inyectable para probar)
export function install({ paths, dryRun = false, io }) {
  const plan = buildPlan(paths);
  if (dryRun) {
    io.out(`--dry-run: no se toca nada. Haría esto:`);
    io.out(`1. Copiar wabid-runner.mjs y wabid-hook.mjs de ${paths.srcDir ?? "(este repo)"} a ${paths.binDir ?? "%LOCALAPPDATA%\\Wabid\\bin"} (solo si cambiaron)`);
    io.out(`2. Escribir ${plan.vbsPath} con:\n${plan.vbs.replace(/\r\n/g, "\n").trimEnd()}`);
    io.out(`3. schtasks ${plan.createArgs.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ")}`);
    return { status: "dry-run", plan };
  }
  io.mkdir(paths.dir);
  const copied = io.copyBin ? io.copyBin(paths) : { copied: [], unchanged: [] };
  const same = io.exists(plan.vbsPath) && io.read(plan.vbsPath) === plan.vbs;
  if (!same) io.write(plan.vbsPath, plan.vbs);
  io.exec(plan.createArgs);
  io.out(`Tarea "${TASK_NAME}" lista: arranca wabid-runner.mjs al iniciar sesión (oculta). Launcher: ${plan.vbsPath}`);
  io.out("Para probarla ya: schtasks /Run /TN \"Wabid Runner\"   ·   para quitarla: node tools/claude-hooks/instalar-runner.mjs --quitar");
  return { status: "installed", plan, vbsRewritten: !same, copied: copied.copied };
}

export function uninstall({ paths, dryRun = false, io }) {
  const plan = buildPlan(paths);
  if (dryRun) {
    io.out(`--dry-run: no se toca nada. Haría esto:`);
    io.out(`1. schtasks ${plan.deleteArgs.join(" ")}  (si la tarea existe)`);
    io.out(`2. Borrar ${plan.vbsPath}  (si existe)`);
    return { status: "dry-run", plan };
  }
  let existed = true;
  try {
    io.exec(plan.queryArgs);
  } catch {
    existed = false;
  }
  if (existed) io.exec(plan.deleteArgs);
  if (io.exists(plan.vbsPath)) io.remove(plan.vbsPath);
  io.out(existed ? `Tarea "${TASK_NAME}" eliminada.` : `La tarea "${TASK_NAME}" no estaba instalada; no cambié nada.`);
  return { status: existed ? "removed" : "absent", plan };
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const quitar = args.includes("--quitar");
  if (process.platform !== "win32" && !dryRun) {
    console.error("Esto crea una tarea programada de Windows: solo funciona en Windows (usa --dry-run para ver el plan).");
    process.exitCode = 1;
    return;
  }
  const io = {
    exec: realExec,
    exists: existsSync,
    read: (p) => readFileSync(p, "utf8"),
    write: (p, t) => writeFileSync(p, t),
    mkdir: (d) => mkdirSync(d, { recursive: true }),
    remove: unlinkSync,
    out: (l) => console.log(l),
    copyBin: (p) => (p.srcDir && path.resolve(p.srcDir) !== path.resolve(p.binDir) ? copyToBin({ srcDir: p.srcDir, destDir: p.binDir }) : { copied: [], unchanged: [] }),
  };
  try {
    const paths = defaultPaths();
    quitar ? uninstall({ paths, dryRun, io }) : install({ paths, dryRun, io });
  } catch (e) {
    const detail = e && typeof e === "object" && "stderr" in e && e.stderr ? String(e.stderr).trim() : e instanceof Error ? e.message : String(e);
    console.error(`No se pudo: ${detail}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) main();
