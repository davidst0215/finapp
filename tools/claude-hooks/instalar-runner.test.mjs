// Instalador del runner: todo con E/S falsa. Nunca crea tareas programadas reales.
// Correr con: node --test tools/claude-hooks/instalar-runner.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildPlan, defaultPaths, install, TASK_NAME, uninstall, vbsContent } from "./instalar-runner.mjs";

const PATHS = {
  nodePath: "C:\\Program Files\\nodejs\\node.exe",
  runnerPath: "C:\\Users\\Dsalg\\finapp\\tools\\claude-hooks\\wabid-runner.mjs",
  vbsPath: "C:\\Users\\Dsalg\\AppData\\Local\\Wabid\\wabid-runner.vbs",
  dir: "C:\\Users\\Dsalg\\AppData\\Local\\Wabid",
};

function fakeIo({ files = {}, taskExists = false } = {}) {
  const log = { exec: [], writes: [], removed: [], out: [] };
  const state = { files: { ...files }, taskExists };
  const io = {
    exec: (args) => {
      log.exec.push(args);
      if (args[0] === "/Query" && !state.taskExists) throw new Error("no existe");
      if (args[0] === "/Create") state.taskExists = true;
      if (args[0] === "/Delete") state.taskExists = false;
    },
    exists: (p) => p in state.files,
    read: (p) => state.files[p],
    write: (p, t) => {
      log.writes.push(p);
      state.files[p] = t;
    },
    mkdir: () => {},
    remove: (p) => {
      log.removed.push(p);
      delete state.files[p];
    },
    out: (l) => log.out.push(l),
  };
  return { io, log, state };
}

test("el .vbs lanza node con el runner, oculto (0) y sin esperar, con comillas bien escapadas", () => {
  const vbs = vbsContent(PATHS);
  assert.match(vbs, /^' Lanza wabid-runner\.mjs sin abrir ventana/);
  const expected =
    'CreateObject("WScript.Shell").Run """C:\\Program Files\\nodejs\\node.exe"" ""C:\\Users\\Dsalg\\finapp\\tools\\claude-hooks\\wabid-runner.mjs""", 0, False';
  assert.ok(vbs.split("\r\n").includes(expected), vbs);
});

test("rutas con comillas o saltos de línea se rechazan en vez de escaparse", () => {
  for (const bad of ['C:\\a"b\\node.exe', "C:\\a\nb", ""]) assert.throws(() => vbsContent({ ...PATHS, nodePath: bad }));
});

test("el plan crea una tarea ONLOGON del usuario, sin elevar y reemplazable (/F)", () => {
  const { createArgs, deleteArgs } = buildPlan(PATHS);
  assert.deepEqual(createArgs.slice(0, 4), ["/Create", "/TN", TASK_NAME, "/TR"]);
  assert.equal(createArgs[4], `wscript.exe "${PATHS.vbsPath}"`);
  assert.deepEqual(createArgs.slice(5), ["/SC", "ONLOGON", "/RL", "LIMITED", "/F"]);
  assert.equal(createArgs.includes("/RU"), false, "sin SYSTEM ni otro usuario");
  assert.equal(createArgs.some((a) => /HIGHEST|SYSTEM/i.test(a)), false);
  assert.deepEqual(deleteArgs, ["/Delete", "/TN", TASK_NAME, "/F"]);
});

test("instalar: escribe el .vbs y crea la tarea; la segunda vez no reescribe el .vbs y /F la deja igual", () => {
  const { io, log, state } = fakeIo();
  const first = install({ paths: PATHS, io });
  assert.equal(first.status, "installed");
  assert.equal(first.vbsRewritten, true);
  assert.equal(log.exec.length, 1);
  assert.equal(state.taskExists, true);
  const second = install({ paths: PATHS, io });
  assert.equal(second.vbsRewritten, false);
  assert.equal(log.writes.length, 1, "idempotente: el archivo no se vuelve a escribir");
  assert.equal(log.exec.length, 2);
  assert.ok(log.exec.every((a) => a.join(" ") === log.exec[0].join(" ")));
});

test("--dry-run imprime el plan y no escribe ni ejecuta nada (instalar y quitar)", () => {
  const a = fakeIo({ taskExists: true, files: { [PATHS.vbsPath]: "x" } });
  assert.equal(install({ paths: PATHS, dryRun: true, io: a.io }).status, "dry-run");
  assert.equal(uninstall({ paths: PATHS, dryRun: true, io: a.io }).status, "dry-run");
  assert.deepEqual([a.log.exec, a.log.writes, a.log.removed], [[], [], []]);
  const printed = a.log.out.join("\n");
  assert.match(printed, /schtasks \/Create/);
  assert.match(printed, /schtasks \/Delete/);
  assert.match(printed, /WScript\.Shell/);
});

test("quitar: borra la tarea y el .vbs; si no existía, no falla ni toca nada", () => {
  const present = fakeIo({ taskExists: true, files: { [PATHS.vbsPath]: "x" } });
  assert.equal(uninstall({ paths: PATHS, io: present.io }).status, "removed");
  assert.deepEqual(present.log.removed, [PATHS.vbsPath]);
  assert.equal(present.state.taskExists, false);
  const absent = fakeIo();
  assert.equal(uninstall({ paths: PATHS, io: absent.io }).status, "absent");
  assert.equal(absent.log.exec.some((a) => a[0] === "/Delete"), false);
});

test("defaultPaths usa %LOCALAPPDATA%\\Wabid y la ruta del runner junto a este script", () => {
  const p = defaultPaths({ env: { LOCALAPPDATA: "C:\\Users\\D\\AppData\\Local" }, nodePath: "C:\\node.exe" });
  assert.equal(p.vbsPath, "C:\\Users\\D\\AppData\\Local\\Wabid\\wabid-runner.vbs");
  assert.ok(p.runnerPath.endsWith("wabid-runner.mjs"));
});

test("CLI --dry-run (y --quitar --dry-run) funciona en cualquier sistema y no toca nada", () => {
  const cli = fileURLToPath(new URL("./instalar-runner.mjs", import.meta.url));
  for (const extra of [[], ["--quitar"]]) {
    const r = spawnSync(process.execPath, [cli, "--dry-run", ...extra], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /--dry-run/);
  }
});
