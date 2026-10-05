// Instalador de hooks: siempre contra un settings.json de ejemplo en una carpeta temporal, nunca el real.
// Correr con: node --test tools/claude-hooks/instalar-hooks.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { desiredHooks, installHooks, mergeWabidHooks, STOP_TIMEOUT_SECONDS } from "./instalar-hooks.mjs";

const SCRIPT = "C:/Users/Dsalg/finapp/tools/claude-hooks/wabid-hook.mjs";
const CLI = fileURLToPath(new URL("./instalar-hooks.mjs", import.meta.url));
const tmp = mkdtempSync(path.join(tmpdir(), "wabid-install-"));
const file = (name) => path.join(tmp, name);

// El estado que dejó la v1: todo async salvo PermissionRequest y SessionEnd.
const v1 = () => ({
  PermissionRequest: [{ hooks: [{ type: "command", command: "node", args: [SCRIPT], timeout: 150 }] }],
  Notification: [{ hooks: [{ type: "command", command: "node", args: [SCRIPT], async: true }] }],
  Stop: [{ hooks: [{ type: "command", command: "node", args: [SCRIPT], async: true }] }],
  StopFailure: [{ hooks: [{ type: "command", command: "node", args: [SCRIPT], async: true }] }],
  SessionStart: [{ hooks: [{ type: "command", command: "node", args: [SCRIPT], async: true }] }],
  SessionEnd: [{ hooks: [{ type: "command", command: "node", args: [SCRIPT], timeout: 5 }] }],
});
const FOREIGN_STOP = { matcher: "", hooks: [{ type: "command", command: "powershell", args: ["-File", "C:/otro/notificar.ps1"], async: true }] };

test("Stop queda síncrono (sin async) y con timeout mayor que la espera máxima de 14 min", () => {
  const stop = desiredHooks(SCRIPT).Stop.hooks[0];
  assert.equal(stop.async, undefined);
  assert.equal(stop.timeout, STOP_TIMEOUT_SECONDS);
  assert.ok(STOP_TIMEOUT_SECONDS > 14 * 60);
});

test("sobre una instalación v1 actualiza Stop y no cambia el resto", () => {
  const { settings, added, updated } = mergeWabidHooks({ hooks: v1() }, SCRIPT);
  assert.equal(added, 0);
  assert.equal(updated, 1);
  assert.deepEqual(settings.hooks.Stop, [{ hooks: [{ type: "command", command: "node", args: [SCRIPT], timeout: 900 }] }]);
  assert.deepEqual(settings.hooks.Notification, v1().Notification);
});

test("es idempotente: una segunda pasada no cambia nada ni duplica", () => {
  const once = mergeWabidHooks({ hooks: v1() }, SCRIPT);
  const twice = mergeWabidHooks(once.settings, SCRIPT);
  assert.deepEqual([twice.added, twice.updated, twice.removedDuplicates], [0, 0, 0]);
  assert.deepEqual(twice.settings, once.settings);
});

test("desde cero agrega los seis hooks", () => {
  const { settings, added } = mergeWabidHooks({}, SCRIPT);
  assert.equal(added, 6);
  assert.deepEqual(Object.keys(settings.hooks).sort(), ["Notification", "PermissionRequest", "SessionEnd", "SessionStart", "Stop", "StopFailure"]);
});

test("no toca hooks ajenos ni otras claves, ni los que comparten grupo con uno de Wabid", () => {
  const input = {
    model: "opus",
    permissions: { allow: ["Bash(git status)"] },
    hooks: {
      ...v1(),
      Stop: [FOREIGN_STOP, { hooks: [{ type: "command", command: "node", args: [SCRIPT], async: true }, { type: "command", command: "echo", args: ["hola"] }] }],
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "bash", args: ["guard.sh"] }] }],
    },
  };
  const { settings } = mergeWabidHooks(input, SCRIPT);
  assert.equal(settings.model, "opus");
  assert.deepEqual(settings.permissions, input.permissions);
  assert.deepEqual(settings.hooks.PreToolUse, input.hooks.PreToolUse);
  assert.deepEqual(settings.hooks.Stop[0], FOREIGN_STOP);
  assert.deepEqual(settings.hooks.Stop[1].hooks, [{ type: "command", command: "node", args: [SCRIPT], timeout: 900 }, { type: "command", command: "echo", args: ["hola"] }]);
});

test("quita un duplicado de Wabid en el mismo evento y deja un solo hook", () => {
  const input = { hooks: { ...v1(), Stop: [...v1().Stop, ...v1().Stop] } };
  const { settings, removedDuplicates } = mergeWabidHooks(input, SCRIPT);
  assert.equal(removedDuplicates, 1);
  assert.equal(settings.hooks.Stop.length, 1);
});

test("reconoce el hook de Wabid aunque la ruta tenga otro estilo o carpeta", () => {
  const input = { hooks: { Stop: [{ hooks: [{ type: "command", command: "node", args: ["D:\\otro\\tools\\claude-hooks\\wabid-hook.mjs"], async: true }] }] } };
  const { settings, added } = mergeWabidHooks(input, SCRIPT);
  assert.equal(settings.hooks.Stop.length, 1);
  assert.equal(added, 5, "Stop se actualizó, los otros cinco se agregaron");
  assert.deepEqual(settings.hooks.Stop[0].hooks[0].args, [SCRIPT]);
});

test("no muta el objeto de entrada", () => {
  const input = { hooks: v1() };
  const copy = structuredClone(input);
  mergeWabidHooks(input, SCRIPT);
  assert.deepEqual(input, copy);
});

test("installHooks: actualiza el archivo de ejemplo, deja respaldo con el original y la segunda corrida no escribe", () => {
  const f = file("settings.json");
  const original = JSON.stringify({ theme: "dark", hooks: { ...v1(), Stop: [FOREIGN_STOP, ...v1().Stop] } }, null, 2);
  writeFileSync(f, original);

  const first = installHooks({ settingsFile: f, script: SCRIPT, now: new Date("2026-10-05T12:00:00Z") });
  assert.equal(first.status, "written");
  assert.equal(first.updated, 1);
  assert.equal(readFileSync(first.backup, "utf8"), original, "el respaldo es el original");
  const after = JSON.parse(readFileSync(f, "utf8"));
  assert.equal(after.theme, "dark");
  assert.deepEqual(after.hooks.Stop[0], FOREIGN_STOP);
  assert.equal(after.hooks.Stop[1].hooks[0].timeout, 900);
  assert.equal(after.hooks.Stop[1].hooks[0].async, undefined);

  const second = installHooks({ settingsFile: f, script: SCRIPT, now: new Date("2026-10-05T12:00:05Z") });
  assert.equal(second.status, "unchanged");
  assert.equal(readdirSync(tmp).filter((n) => n.startsWith("settings.json.antes-de-wabid")).length, 1, "no se crea otro respaldo sin cambios");
});

test("installHooks: --dry-run no escribe ni respalda", () => {
  const f = file("dry.json");
  writeFileSync(f, JSON.stringify({ hooks: v1() }));
  const before = readFileSync(f, "utf8");
  const r = installHooks({ settingsFile: f, script: SCRIPT, dryRun: true });
  assert.equal(r.status, "dry-run");
  assert.equal(readFileSync(f, "utf8"), before);
  assert.equal(readdirSync(tmp).some((n) => n.startsWith("dry.json.antes")), false);
});

test("installHooks: un settings.json roto no se toca", () => {
  const f = file("roto.json");
  writeFileSync(f, "{ esto no es json");
  assert.equal(installHooks({ settingsFile: f, script: SCRIPT }).status, "invalid");
  assert.equal(readFileSync(f, "utf8"), "{ esto no es json");
  const g = file("lista.json");
  writeFileSync(g, "[]");
  assert.equal(installHooks({ settingsFile: g, script: SCRIPT }).status, "invalid");
});

test("installHooks: tolera BOM y crea el archivo si no existe (sin respaldo)", () => {
  const f = file("bom.json");
  writeFileSync(f, "\uFEFF" + JSON.stringify({ hooks: {} }));
  assert.equal(installHooks({ settingsFile: f, script: SCRIPT }).status, "written");
  const nuevo = file("nuevo.json");
  const r = installHooks({ settingsFile: nuevo, script: SCRIPT });
  assert.equal(r.status, "written");
  assert.equal(r.backup, null);
  assert.ok(existsSync(nuevo));
});

test("CLI: WABID_CLAUDE_SETTINGS apunta al archivo de ejemplo y --dry-run no escribe", () => {
  const f = file("cli.json");
  writeFileSync(f, JSON.stringify({ hooks: v1() }));
  const before = readFileSync(f, "utf8");
  const env = { ...process.env, WABID_CLAUDE_SETTINGS: f };
  const dry = spawnSync(process.execPath, [CLI, "--dry-run"], { env, encoding: "utf8" });
  assert.equal(dry.status, 0);
  assert.match(dry.stdout, /dry-run/);
  assert.equal(readFileSync(f, "utf8"), before);
  const real = spawnSync(process.execPath, [CLI], { env, encoding: "utf8" });
  assert.equal(real.status, 0);
  assert.match(real.stdout, /0 agregados, 6 actualizados/, "la ruta del script de esta copia difiere de la del ejemplo: se corrige en los seis");
  assert.equal(JSON.parse(readFileSync(f, "utf8")).hooks.Stop[0].hooks[0].timeout, 900);
});

test.after(() => rmSync(tmp, { recursive: true, force: true }));
