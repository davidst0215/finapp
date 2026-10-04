// Prueba del ejecutable real: proceso hijo de Node + servidor HTTP local que hace de Wabid.
// Verifica lo que las pruebas unitarias no ven: que stdout se vacíe antes de salir (en Windows las tuberías
// son asíncronas), el código de salida, y que nunca se imprima nada fuera de la decisión.
// Correr con: node --test tools/claude-hooks/wabid-hook.cli.test.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./wabid-hook.mjs", import.meta.url));
const TOKEN = "wbd.3f2b8c1e-5d4a-4e7b-9c0d-1a2b3c4d5e6f.ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq";
const APPROVAL_ID = "9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f";

let server;
let baseUrl;
let tmp;
let requests;
let statusAnswers;

before(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), "wabid-hook-"));
  server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
      requests.push({ method: req.method, url: req.url, token: req.headers["x-wabid-device-token"], body });
      const reply = (status, data) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(data));
      };
      if (req.headers["x-wabid-device-token"] !== TOKEN) return reply(401, { error: "No autorizado" });
      if (req.method === "GET" && req.url === "/device/ping") return reply(200, { ok: true, device: { name: "Laptop de prueba", approvals_enabled: true } });
      if (req.method === "POST" && req.url === "/device/events") {
        if (body.type === "permission_request") {
          return reply(200, { ok: true, approval: { id: APPROVAL_ID, status: "pendiente", expires_in_ms: 30000, poll_interval_ms: 1000 } });
        }
        return reply(200, { ok: true });
      }
      if (req.method === "GET" && req.url === `/device/approvals/${APPROVAL_ID}`) return reply(200, { status: statusAnswers.shift() ?? "pendiente" });
      return reply(404, { error: "no existe" });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  rmSync(tmp, { recursive: true, force: true });
});

function writeConfig(url = baseUrl, token = TOKEN) {
  const file = path.join(tmp, `config-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify({ url, token }));
  return file;
}

// Ejecuta el script como lo haría Claude Code: JSON por stdin, stdout capturado.
function run({ stdin, config, args = [] }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const env = { ...process.env, WABID_HOOK_CONFIG: config };
    delete env.WABID_HOOK_TEST;
    const child = spawn(process.execPath, [SCRIPT, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (code) => resolve({ code, stdout, stderr, ms: Date.now() - started }));
    child.stdin.end(stdin);
  });
}

const input = (extra) =>
  JSON.stringify({ session_id: "abc123", cwd: "C:\\proyectos\\finapp", transcript_path: "t.jsonl", ...extra });

test("permiso aprobado desde el celular: imprime la decisión allow, sale con 0 y el servidor ve el token", async () => {
  requests = [];
  statusAnswers = ["pendiente", "aprobada"];
  const r = await run({
    config: writeConfig(),
    stdin: input({ hook_event_name: "PermissionRequest", permission_mode: "default", tool_name: "Bash", tool_input: { command: "npm test" } }),
  });
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.stdout.trim()), { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
  assert.ok(r.ms >= 1900, `debió sondear cada 1 s (tardó ${r.ms} ms)`);
  assert.ok(requests.every((q) => q.token === TOKEN));
  assert.equal(requests[0].body.preview, "npm test");
});

test("permiso denegado: imprime deny", async () => {
  requests = [];
  statusAnswers = ["denegada"];
  const r = await run({
    config: writeConfig(),
    stdin: input({ hook_event_name: "PermissionRequest", permission_mode: "default", tool_name: "Bash", tool_input: { command: "rm -rf dist" } }),
  });
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(r.stdout.trim()).hookSpecificOutput.decision.behavior, "deny");
});

test("permiso vencido en el servidor: no imprime nada y sale con 0", async () => {
  requests = [];
  statusAnswers = ["vencida"];
  const r = await run({
    config: writeConfig(),
    stdin: input({ hook_event_name: "PermissionRequest", permission_mode: "default", tool_name: "Bash", tool_input: { command: "ls" } }),
  });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "");
});

test("SessionStart no imprime NADA por stdout (todo lo que salga ahí llega al contexto de Claude)", async () => {
  requests = [];
  const r = await run({ config: writeConfig(), stdin: input({ hook_event_name: "SessionStart", source: "startup", model: "claude-opus-5" }) });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.type, "session_start");
  assert.equal(requests[0].body.project, "finapp");
});

test("Stop y Notification tampoco imprimen nada", async () => {
  requests = [];
  for (const extra of [
    { hook_event_name: "Stop", last_assistant_message: "listo" },
    { hook_event_name: "Notification", notification_type: "idle_prompt", message: "te espero" },
  ]) {
    const r = await run({ config: writeConfig(), stdin: input(extra) });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
  }
  assert.equal(requests.length, 2);
});

test("con Wabid caído sale rápido con 0 y sin imprimir", async () => {
  const r = await run({
    config: writeConfig("http://127.0.0.1:9"),
    stdin: input({ hook_event_name: "PermissionRequest", permission_mode: "default", tool_name: "Bash", tool_input: { command: "ls" } }),
  });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "");
  assert.ok(r.ms < 8000, `tardó ${r.ms} ms`);
});

test("con token incorrecto (401) no decide", async () => {
  const r = await run({
    config: writeConfig(baseUrl, "wbd.3f2b8c1e-5d4a-4e7b-9c0d-1a2b3c4d5e6f.ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ"),
    stdin: input({ hook_event_name: "PermissionRequest", permission_mode: "default", tool_name: "Bash", tool_input: { command: "ls" } }),
  });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "");
});

test("sin archivo de configuración sale con 0 y deja una pista en stderr", async () => {
  const r = await run({ config: path.join(tmp, "no-existe.json"), stdin: input({ hook_event_name: "Stop" }) });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /setup/);
});

test("stdin con basura sale con 0 sin imprimir", async () => {
  const r = await run({ config: writeConfig(), stdin: "esto no es json {{{" });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "");
});

test("`test` verifica la conexión y deja una sesión de prueba", async () => {
  requests = [];
  const r = await run({ config: writeConfig(), stdin: "", args: ["test"] });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Laptop de prueba/);
  assert.match(r.stdout, /ACTIVADAS/);
  assert.deepEqual(requests.filter((q) => q.method === "POST").map((q) => q.body.type), ["session_start", "notification", "session_end"]);
});

test("`setup` guarda la configuración con los datos recibidos por tubería y prueba la conexión", async () => {
  requests = [];
  const file = path.join(tmp, "setup-config.json");
  const r = await run({ config: file, stdin: `${baseUrl}\n${TOKEN}\n`, args: ["setup"] });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { url: baseUrl, token: TOKEN });
  assert.match(r.stdout, /Conectado como "Laptop de prueba"/);
  assert.ok(!r.stdout.includes(TOKEN), "el token no se vuelve a imprimir");
});

test("`setup` con datos inválidos no guarda nada y falla", async () => {
  const file = path.join(tmp, "setup-malo.json");
  const r = await run({ config: file, stdin: "http://evil.example.com\nnada\n", args: ["setup"] });
  assert.equal(r.code, 1);
  assert.throws(() => readFileSync(file, "utf8"));
});
