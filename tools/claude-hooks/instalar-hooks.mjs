// Instala o ACTUALIZA los hooks de Wabid en ~/.claude/settings.json sin tocar hooks ajenos.
// Uso (PowerShell, desde la carpeta finapp):  node tools/claude-hooks/instalar-hooks.mjs [--dry-run]
//
//   - Agrega los que falten y ACTUALIZA los de Wabid ya instalados (p. ej. Stop pasa de async a síncrono con
//     timeout 900 s para poder entregar mensajes del celular). Un hook es "de Wabid" si su args apunta a wabid-hook.mjs.
//   - Idempotente: si ya está todo como debe, no escribe nada.
//   - Respaldo antes de escribir: settings.json.antes-de-wabid-<fecha> (uno por cambio real; nunca pisa uno anterior).
//   - Si el settings.json no es JSON válido, no toca nada.
//   - WABID_CLAUDE_SETTINGS cambia la ruta del settings.json (para probar contra un archivo de ejemplo).
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Stop es síncrono (sin async): así puede devolver {"decision":"block"}. Su timeout (900 s) es mayor que la
// espera máxima de mensajes (14 min = 840 s) más los márgenes del hook.
export const STOP_TIMEOUT_SECONDS = 900;

export const desiredHooks = (script) => {
  const hook = (extra) => ({ hooks: [{ type: "command", command: "node", args: [script], ...extra }] });
  return {
    PermissionRequest: hook({ timeout: 150 }),
    Notification: hook({ async: true }),
    Stop: hook({ timeout: STOP_TIMEOUT_SECONDS }),
    StopFailure: hook({ async: true }),
    SessionStart: hook({ async: true }),
    SessionEnd: hook({ timeout: 5 }),
  };
};

const isWabidHandler = (h) => !!h && Array.isArray(h.args) && h.args.some((a) => /(^|[\\/])wabid-hook\.mjs$/.test(String(a)));
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Devuelve { settings, added, updated, removedDuplicates }. No modifica `settings` (trabaja sobre una copia).
export function mergeWabidHooks(settings, script) {
  const next = structuredClone(settings && typeof settings === "object" && !Array.isArray(settings) ? settings : {});
  next.hooks ??= {};
  let added = 0;
  let updated = 0;
  let removedDuplicates = 0;

  for (const [event, wanted] of Object.entries(desiredHooks(script))) {
    const want = wanted.hooks[0];
    const groups = (next.hooks[event] ??= []);
    let seen = false;
    for (const group of groups) {
      if (!group || !Array.isArray(group.hooks)) continue;
      const kept = [];
      for (const h of group.hooks) {
        if (!isWabidHandler(h)) {
          kept.push(h); // ajeno: intacto
          continue;
        }
        if (seen) {
          removedDuplicates++; // segundo hook de Wabid en el mismo evento: se quita
          continue;
        }
        seen = true;
        if (!sameJson(h, want)) updated++;
        kept.push(want);
      }
      group.hooks = kept;
    }
    // Un grupo que quedó sin handlers por quitar duplicados no tiene sentido: se descarta.
    next.hooks[event] = groups.filter((g) => !(g && Array.isArray(g.hooks) && g.hooks.length === 0));
    if (!seen) {
      next.hooks[event].push(wanted);
      added++;
    }
  }
  return { settings: next, added, updated, removedDuplicates };
}

export const settingsPath = (env = process.env, home = os.homedir()) => env.WABID_CLAUDE_SETTINGS || path.join(home, ".claude", "settings.json");

const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, "").replace(/\..*/, "");

// Lee, fusiona y (si hay cambios) hace respaldo y escribe. Devuelve un resumen; no imprime.
export function installHooks({ settingsFile, script, dryRun = false, now = new Date() }) {
  const exists = existsSync(settingsFile);
  let current = {};
  if (exists) {
    const raw = readFileSync(settingsFile, "utf8").replace(/^﻿/, "");
    if (raw.trim()) {
      try {
        current = JSON.parse(raw);
      } catch {
        return { status: "invalid", settingsFile };
      }
    }
  }
  if (!current || typeof current !== "object" || Array.isArray(current)) return { status: "invalid", settingsFile };

  const { settings, added, updated, removedDuplicates } = mergeWabidHooks(current, script);
  const changes = { added, updated, removedDuplicates };
  if (added + updated + removedDuplicates === 0) return { status: "unchanged", settingsFile, ...changes };
  if (dryRun) return { status: "dry-run", settingsFile, ...changes };

  let backup = null;
  if (exists) {
    backup = `${settingsFile}.antes-de-wabid-${stamp(now)}`;
    copyFileSync(settingsFile, backup);
  }
  writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + "\n");
  return { status: "written", settingsFile, backup, ...changes };
}

function main() {
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "wabid-hook.mjs").replace(/\\/g, "/");
  const dryRun = process.argv.includes("--dry-run");
  const r = installHooks({ settingsFile: settingsPath(), script, dryRun });
  switch (r.status) {
    case "invalid":
      console.error(`${r.settingsFile} no es un JSON válido (o no es un objeto): no cambié nada. Arréglalo y vuelve a correr.`);
      process.exitCode = 1;
      return;
    case "unchanged":
      console.log("Los hooks de Wabid ya estaban como deben; no cambié nada.");
      return;
    case "dry-run":
      console.log(`--dry-run: agregaría ${r.added}, actualizaría ${r.updated} y quitaría ${r.removedDuplicates} duplicados en ${r.settingsFile}. No escribí nada.`);
      return;
    default:
      console.log(`Listo en ${r.settingsFile}: ${r.added} agregados, ${r.updated} actualizados, ${r.removedDuplicates} duplicados quitados.`);
      if (r.backup) console.log(`Respaldo: ${r.backup}`);
      console.log("Reinicia Claude Code para que los tome.");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) main();
