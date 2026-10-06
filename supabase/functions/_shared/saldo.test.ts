import { test } from "node:test";
import assert from "node:assert/strict";
import { conCache, consultarSaldo, duracion, mapearElevenLabs, mapearOpenRouter, mensajeVoz, MSG_SIN_PERMISO, proyectar, type Saldo } from "./saldo.ts";
import { paraVoz } from "./voz.ts";

const KEY = { status: 200, cuerpo: { data: { limit: 10, limit_remaining: 9.73, usage: 0.27, usage_daily: 0.1, usage_weekly: 0.26, usage_monthly: 0.27 } } };
const CREDITS = { status: 200, cuerpo: { data: { total_credits: 10, total_usage: 0.27 } } };

test("proyección: restante entre el ritmo diario (semana / 7)", () => {
  assert.deepEqual(proyectar(9.73, 0.26), { tipo: "dias", dias: 261 }); // 9.73 / (0.26/7) = 261.9
  assert.deepEqual(proyectar(5, 7), { tipo: "dias", dias: 5 }); // US$ 1 al día
});

test("proyección: ritmo cero o casi cero = más de 12 meses", () => {
  assert.deepEqual(proyectar(9.73, 0), { tipo: "mas_de_12_meses" });
  assert.deepEqual(proyectar(9.73, 0.0001), { tipo: "mas_de_12_meses" });
  assert.deepEqual(proyectar(9.73, Number.NaN), { tipo: "mas_de_12_meses" });
});

test("proyección: el límite de 12 meses es 365 días", () => {
  assert.deepEqual(proyectar(365, 7), { tipo: "dias", dias: 365 });
  assert.deepEqual(proyectar(366, 7), { tipo: "mas_de_12_meses" });
});

test("proyección: ritmo alto da pocos días y restante 0 o negativo = agotado", () => {
  assert.deepEqual(proyectar(2, 70), { tipo: "dias", dias: 0 });
  assert.deepEqual(proyectar(0, 5), { tipo: "agotado" });
  assert.deepEqual(proyectar(-1, 5), { tipo: "agotado" });
  assert.deepEqual(proyectar(0, 0), { tipo: "agotado" });
});

test("OpenRouter: datos reales de /key y /credits", () => {
  assert.deepEqual(mapearOpenRouter(KEY, CREDITS), {
    estado: "ok", restante: 9.73, credito: 10, usado: 0.27, hoy: 0.1, semana: 0.26, mes: 0.27, proyeccion: { tipo: "dias", dias: 261 },
  });
});

test("OpenRouter: manda el menor de los dos topes", () => {
  const poco = { status: 200, cuerpo: { data: { total_credits: 10, total_usage: 9.5 } } };
  const r = mapearOpenRouter(KEY, poco);
  assert.equal(r.estado === "ok" && r.restante, 0.5);
  assert.equal(r.estado === "ok" && r.credito, 10);
});

test("OpenRouter: llave sin límite usa los créditos de la cuenta; si /credits falla usa solo la llave", () => {
  const sinLimite = { status: 200, cuerpo: { data: { limit: null, limit_remaining: null, usage: 1, usage_daily: 0, usage_weekly: 0, usage_monthly: 1 } } };
  const a = mapearOpenRouter(sinLimite, CREDITS);
  assert.equal(a.estado === "ok" && a.restante, 9.73);
  assert.equal(a.estado === "ok" && a.proyeccion.tipo, "mas_de_12_meses");
  const b = mapearOpenRouter(KEY, { status: 500, cuerpo: null });
  assert.equal(b.estado === "ok" && b.restante, 9.73);
});

test("OpenRouter: restante negativo se corta en cero y queda agotado", () => {
  const r = mapearOpenRouter(null, { status: 200, cuerpo: { data: { total_credits: 10, total_usage: 10.2 } } });
  assert.equal(r.estado === "ok" && r.restante, 0);
  assert.equal(r.estado === "ok" && r.proyeccion.tipo, "agotado");
});

test("errores de OpenRouter: mensaje corto, sin llave ni cuerpo crudo", () => {
  const cuerpoConLlave = { error: { message: "No auth credentials found sk-or-v1-secreto" } };
  const r = mapearOpenRouter({ status: 401, cuerpo: cuerpoConLlave }, { status: 401, cuerpo: cuerpoConLlave });
  assert.deepEqual(r, { estado: "error", mensaje: "OpenRouter rechazó la llave" });
  assert.equal(JSON.stringify(r).includes("secreto"), false);
  assert.deepEqual(mapearOpenRouter(null, null), { estado: "error", mensaje: "OpenRouter no respondió" });
  assert.deepEqual(mapearOpenRouter({ status: 429, cuerpo: {} }, { status: 429, cuerpo: {} }), { estado: "error", mensaje: "OpenRouter pidió esperar un momento" });
  assert.deepEqual(mapearOpenRouter({ status: 200, cuerpo: { data: { cosa: 1 } } }, { status: 200, cuerpo: "html" }).estado, "error");
});

test("ElevenLabs: 401 missing_permissions = sin_permiso con el mensaje de la tarea", () => {
  const r = mapearElevenLabs({ status: 401, cuerpo: { detail: { status: "missing_permissions", message: "The API key you used is missing the permission user_read" } } });
  assert.deepEqual(r, { estado: "sin_permiso", mensaje: MSG_SIN_PERMISO });
  assert.equal(MSG_SIN_PERMISO, "Voz: activa el permiso 'User → Read' de la API key en ElevenLabs para ver el consumo");
});

test("ElevenLabs: otro 401, 429, 5xx y sin respuesta son error corto", () => {
  assert.deepEqual(mapearElevenLabs({ status: 401, cuerpo: { detail: { status: "invalid_api_key" } } }), { estado: "error", mensaje: "ElevenLabs rechazó la llave" });
  assert.equal(mapearElevenLabs({ status: 429, cuerpo: null }).estado, "error");
  assert.equal(mapearElevenLabs({ status: 503, cuerpo: "<html>" }).estado, "error");
  assert.deepEqual(mapearElevenLabs(null), { estado: "error", mensaje: "ElevenLabs no respondió" });
  assert.equal(mapearElevenLabs("sin_configurar").estado, "sin_configurar");
  assert.equal(mapearElevenLabs({ status: 200, cuerpo: { tier: "free" } }).estado, "error");
});

test("ElevenLabs: caracteres usados, límite y fecha de renovación", () => {
  const r = mapearElevenLabs({ status: 200, cuerpo: { tier: "creator", character_count: 1200, character_limit: 100000, next_character_count_reset_unix: 1791100800 } });
  assert.deepEqual(r, { estado: "ok", usados: 1200, limite: 100000, renueva: new Date(1791100800 * 1000).toISOString(), plan: "creator" });
  const sin = mapearElevenLabs({ status: 200, cuerpo: { character_count: 0, character_limit: 10000 } });
  assert.deepEqual(sin, { estado: "ok", usados: 0, limite: 10000, renueva: null, plan: null });
});

test("consultarSaldo: pide solo GET de consulta con la llave correcta y arma el resultado", async () => {
  const pedidos: string[] = [];
  const s = await consultarSaldo({ openrouter: "or-clave", elevenlabs: "el-clave" }, async (url, llave) => {
    pedidos.push(`${url}|${llave.cabecera}|${llave.valor}`);
    if (url.endsWith("/key")) return KEY;
    if (url.endsWith("/credits")) return CREDITS;
    return { status: 401, cuerpo: { detail: { status: "missing_permissions" } } };
  }, new Date("2026-10-06T12:00:00Z"));
  assert.deepEqual(pedidos.sort(), [
    "https://api.elevenlabs.io/v1/user/subscription|xi-api-key|el-clave",
    "https://openrouter.ai/api/v1/credits|Authorization|Bearer or-clave",
    "https://openrouter.ai/api/v1/key|Authorization|Bearer or-clave",
  ]);
  assert.equal(s.openrouter.estado, "ok");
  assert.equal(s.elevenlabs.estado, "sin_permiso");
  assert.equal(s.actualizado, "2026-10-06T12:00:00.000Z");
  assert.equal(JSON.stringify(s).includes("clave"), false, "el resultado no lleva llaves");
});

test("consultarSaldo: sin llaves no hace ningún pedido", async () => {
  let llamadas = 0;
  const s = await consultarSaldo({}, async () => { llamadas++; return null; });
  assert.equal(llamadas, 0);
  assert.equal(s.openrouter.estado, "error");
  assert.equal(s.elevenlabs.estado, "sin_configurar");
});

test("caché: 60 s, concurrentes comparten consulta y los fallos no se guardan", async () => {
  let t = 0, n = 0;
  const get = conCache(async () => ({ ok: ++n > 1 }), (v) => v.ok, 60_000, () => t);
  const [a, b] = await Promise.all([get(), get()]);
  assert.equal(n, 1, "dos pedidos a la vez = una consulta");
  assert.equal(a, b);
  assert.equal((await get()).ok, true, "el primero fue fallo: se reconsulta"); // n = 2
  assert.equal(n, 2);
  t = 59_999;
  await get();
  assert.equal(n, 2, "dentro de los 60 s sale de memoria");
  t = 60_001;
  await get();
  assert.equal(n, 3, "vencido: reconsulta");
});

const saldoOk = (over: Record<string, unknown> = {}): Saldo => ({
  openrouter: { estado: "ok", restante: 9.73, credito: 10, usado: 0.27, hoy: 0.1, semana: 0.26, mes: 0.27, proyeccion: { tipo: "dias", dias: 261 }, ...over } as never,
  elevenlabs: { estado: "sin_permiso", mensaje: MSG_SIN_PERMISO },
  actualizado: "2026-10-06T12:00:00.000Z",
});

test("duración hablada: días, meses y singulares", () => {
  assert.equal(duracion(1), "un día");
  assert.equal(duracion(11), "unos once días");
  assert.equal(duracion(29), "unos veintinueve días");
  assert.equal(duracion(35), "un mes");
  assert.equal(duracion(261), "unos nueve meses");
  assert.equal(duracion(365), "unos doce meses");
});

test("voz: monto en cifras con formato (la voz lo pasa a palabras) y meses de alcance", () => {
  const texto = mensajeVoz(saldoOk());
  assert.equal(texto, "Te quedan US$ 9.73 en OpenRouter; a este ritmo te alcanza para unos nueve meses. Hoy llevas US$ 0.10 y este mes US$ 0.27.");
  assert.match(paraVoz(texto), /^Te quedan nueve dólares con setenta y tres centavos en OpenRouter/);
  assert.match(paraVoz(texto), /Hoy llevas diez centavos y este mes veintisiete centavos\.$/);
});

test("voz: ritmo cero, saldo agotado, saldo bajo y voz con datos", () => {
  assert.match(mensajeVoz(saldoOk({ semana: 0, proyeccion: { tipo: "mas_de_12_meses" } })), /te dura más de doce meses/);
  const agotado = mensajeVoz(saldoOk({ restante: 0, proyeccion: { tipo: "agotado" } }));
  assert.match(agotado, /^Se te acabó el saldo de OpenRouter\./);
  assert.match(agotado, /recargar/);
  assert.match(mensajeVoz(saldoOk({ restante: 1.5, proyeccion: { tipo: "dias", dias: 20 } })), /unos veinte días\..*recargar pronto/);
  assert.equal(mensajeVoz(saldoOk()).includes("caracteres"), false, "sin permiso la voz no dice nada de ElevenLabs");
  const conVoz = { ...saldoOk(), elevenlabs: { estado: "ok", usados: 1200, limite: 100000, renueva: null, plan: null } } as Saldo;
  assert.match(mensajeVoz(conVoz), /En voz usaste 1200 de 100000 caracteres\.$/);
});

test("voz: si OpenRouter falla, mensaje corto sin detalles", () => {
  const s: Saldo = { ...saldoOk(), openrouter: { estado: "error", mensaje: "OpenRouter rechazó la llave" } };
  assert.equal(mensajeVoz(s), "No pude consultar tu saldo de OpenRouter ahora. Inténtalo en un momento.");
});
