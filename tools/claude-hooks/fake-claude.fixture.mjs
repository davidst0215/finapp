// `claude` falso para las pruebas del runner: imita la salida de `claude -p --output-format stream-json`.
// El comportamiento lo decide la primera línea del prompt (que llega por stdin, como en el runner real):
//   OK · DENIED · ERROR · CRASH · HANG · SLOW
// Variables: FAKE_CLAUDE_LOG (archivo donde deja args, cwd y entorno visto), FAKE_PID_FILE (pid del nieto en HANG).
import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write((process.env.FAKE_CLAUDE_VERSION ?? "2.1.280") + " (Claude Code)\n");
  process.exit(0);
}
const sid = args[args.indexOf("--session-id") + 1] ?? "sin-session";
// El prompt es el único argumento posicional, después de `--` (stdin va cerrado).
const dashdash = args.indexOf("--");
const prompt = dashdash >= 0 ? (args[dashdash + 1] ?? "") : "";
const mode = prompt.split("\n")[0].trim();

if (process.env.FAKE_CLAUDE_LOG) {
  appendFileSync(
    process.env.FAKE_CLAUDE_LOG,
    JSON.stringify({ args, cwd: process.cwd(), prompt, wabidRunner: process.env.WABID_RUNNER, wabidTask: process.env.WABID_RUNNER_TASK }) + "\n",
  );
}

const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const init = () => out({ type: "system", subtype: "init", session_id: sid, model: "fake", tools: [] });
const text = (t) => out({ type: "assistant", session_id: sid, parent_tool_use_id: null, message: { role: "assistant", content: [{ type: "text", text: t }] } });
const tool = (name, input) => out({ type: "assistant", session_id: sid, parent_tool_use_id: null, message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name, input }] } });
const result = (extra) => out({ type: "result", subtype: "success", is_error: false, session_id: sid, duration_ms: 1, num_turns: 1, result: "", permission_denials: [], ...extra });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

switch (mode) {
  case "OK":
    init();
    tool("Bash", { command: "export TOKEN=sk-ant-api03-abcdefghijklmnopqrstuvwxyz && npm run build", description: "build" });
    await sleep(120);
    text("Voy a compilar.");
    result({ result: "Hecho: todo bien. Usé la llave sk-ant-api03-abcdefghijklmnopqrstuvwxyz para probar." });
    break;
  case "DENIED":
    init();
    text("Intenté escribir pero no tuve permiso.");
    result({ result: "No pude terminar.", permission_denials: [{ tool_name: "Bash" }, { tool_name: "Edit" }] });
    break;
  case "ERROR":
    init();
    out({ type: "result", subtype: "error_during_execution", is_error: true, session_id: sid, errors: ["boom"], permission_denials: [] });
    break;
  case "CRASH":
    process.stderr.write("fallo fatal con token sk-ant-api03-abcdefghijklmnopqrstuvwxyz\n");
    process.exit(3);
    break;
  case "SLOW":
    init();
    for (let i = 0; i < 6; i++) {
      tool("Read", { file_path: `C:\\proyecto\\archivo${i}.ts` });
      await sleep(100);
    }
    result({ result: "Terminé despacio." });
    break;
  case "HANG": {
    init();
    // Un nieto vivo: el kill del runner debe llevarse el árbol completo, no solo este proceso.
    const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    if (process.env.FAKE_PID_FILE) writeFileSync(process.env.FAKE_PID_FILE, String(grandchild.pid));
    setInterval(() => {}, 1000);
    await new Promise(() => {});
    break;
  }
  default:
    init();
    result({ result: `modo desconocido: ${mode}`, is_error: true, subtype: "error_during_execution", errors: ["modo"] });
}
