import { test } from "node:test";
import assert from "node:assert/strict";
import { conCache, consultarSaldo, duracion, mapearElevenLabs, mapearOpenRouter, mensajeVoz, MSG_SIN_PERMISO, proyectar, ritmoDiario, saldoVigente, textoAlcance, type Saldo } from "./saldo.ts";
import { paraVoz } from "./voz.ts";

const KEY = { status: 200, cuerpo: { data: { limit: 10, limit_remaining: 9.73, usage: 0.27, usage_daily: 0.1, usage_weekly: 0.26, usage_monthly: 0.27 } } };
const CREDITS = { status: 200, cuerpo: { data: { total_credits: 10, total_usage: 0.27 } } };

// 2026-10-06 es martes; 2026-10-05, lunes; 2026-10-01, jueves. Los periodos de OpenRouter son UTC.
const utc = (iso: string) => new Date(iso);
const MARTES = utc("2026-10-06T12:00:00Z");

test("proyección: restante entre el ritmo diario", () => {
  assert.deepEqual(proyectar(9.73, 0.26 / 7), { tipo: "dias", dias: 261 }); // 9.73 / 0.0371 = 261.9
  assert.deepEqual(proyectar(5, 1), { tipo: "dias", dias: 5 });
});

test("proyección: ritmo cero o casi cero = más de 12 meses", () => {
  assert.deepEqual(proyectar(9.73, 0), { tipo: "mas_de_12_meses" });
  assert.deepEqual(proyectar(9.73, 0.0001), { tipo: "mas_de_12_meses" });
  assert.deepEqual(proyectar(9.73, Number.NaN), { tipo: "mas_de_12_meses" });
});

test("proyección: el límite de 12 meses es 365 días", () => {
  assert.deepEqual(proyectar(365, 1), { tipo: "dias", dias: 365 });
  assert.deepEqual(proyectar(366, 1), { tipo: "mas_de_12_meses" });
});

test("proyección: ritmo alto da pocos días y restante 0 o negativo = agotado", () => {
  assert.deepEqual(proyectar(2, 10), { tipo: "dias", dias: 0 });
  assert.deepEqual(proyectar(0, 5), { tipo: "agotado" });
  assert.deepEqual(proyectar(-1, 5), { tipo: "agotado" });
  assert.deepEqual(proyectar(0, 0), { tipo: "agotado" });
});

test("ritmo diario: a mitad de semana divide entre los días transcurridos (completos + fracción de hoy)", () => {
  // Martes a mediodía UTC: 1.5 días de semana y 5.5 de mes. Gana el mayor: la semana.
  assert.ok(Math.abs(ritmoDiario(0.3, 0.3, MARTES) - 0.3 / 1.5) < 1e-9);
});

test("ritmo diario: inicio de semana (lunes) no divide entre 7 ni entre cero: mínimo de 1 día", () => {
  const lunes1am = utc("2026-10-05T01:00:00Z"); // 0.04 días de semana -> 1
  assert.equal(ritmoDiario(0.1, 0, lunes1am), 0.1);
  const lunes18 = utc("2026-10-05T18:00:00Z"); // 0.75 días -> 1
  assert.equal(ritmoDiario(0.1, 0, lunes18), 0.1);
  const domingo = utc("2026-10-11T12:00:00Z"); // 6.5 días
  assert.ok(Math.abs(ritmoDiario(0.65, 0, domingo) - 0.1) < 1e-9);
});

test("ritmo diario: inicio de mes y día 1 usan el mínimo de 1 día; gana el periodo de mayor ritmo", () => {
  const dia1 = utc("2026-10-01T03:00:00Z"); // jueves: semana 3.125 días, mes -> 1
  assert.equal(ritmoDiario(0.3, 0.3, dia1), 0.3);
  // Mes empezó el jueves 1; semana del lunes 28-sep al domingo: el lunes 5-oct la semana (1 día) y el mes (4.5 días).
  const lunes = utc("2026-10-05T12:00:00Z");
  assert.equal(ritmoDiario(0.05, 2, lunes), 2 / 4.5, "el mes manda cuando la semana apenas empieza");
  assert.equal(ritmoDiario(1, 0.5, lunes), 1, "la semana manda si gastó más por día");
});

test("ritmo diario: sin gasto es 0", () => {
  assert.equal(ritmoDiario(0, 0, MARTES), 0);
  assert.equal(ritmoDiario(0, 0, utc("2026-10-01T00:00:00Z")), 0);
});

test("OpenRouter: datos reales de /key y /credits", () => {
  // Martes 12:00 UTC: semana 0.26 / 1.5 = 0.1733 al día (el mes da 0.27 / 5.5 = 0.049); 9.73 / 0.1733 = 56.
  assert.deepEqual(mapearOpenRouter(KEY, CREDITS, MARTES), {
    estado: "ok", restante: 9.73, credito: 10, hoy: 0.1, semana: 0.26, mes: 0.27, proyeccion: { tipo: "dias", dias: 56 },
    alcance: "A este ritmo te alcanza para unos dos meses", bajo: false,
  });
  // Lunes 06:00 UTC con el mismo gasto semanal: antes (semana / 7) daba 261 días, ahora el mínimo de 1 día da 37.
  const lunes = mapearOpenRouter(KEY, CREDITS, utc("2026-10-05T06:00:00Z"));
  assert.equal(lunes.estado === "ok" && lunes.proyeccion.tipo === "dias" && lunes.proyeccion.dias, 37);
});

test("OpenRouter: manda el menor de los dos topes", () => {
  const poco = { status: 200, cuerpo: { data: { total_credits: 10, total_usage: 9.5 } } };
  const r = mapearOpenRouter(KEY, poco);
  assert.equal(r.estado === "ok" && r.restante, 0.5);
  assert.equal(r.estado === "ok" && r.credito, 10);
});

test("OpenRouter: llave sin límite usa los créditos de la cuenta; si /credits falla usa solo la llave", () => {
  const sinLimite = { status: 200, cuerpo: { data: { limit: null, limit_remaining: null, usage: 1, usage_daily: 0, usage_weekly: 0, usage_monthly: 0 } } };
  const a = mapearOpenRouter(sinLimite, CREDITS, MARTES);
  assert.equal(a.estado === "ok" && a.restante, 9.73);
  assert.equal(a.estado === "ok" && a.proyeccion.tipo, "mas_de_12_meses");
  const b = mapearOpenRouter(KEY, { status: 500, cuerpo: null }, MARTES);
  assert.equal(b.estado === "ok" && b.restante, 9.73);
});

test("OpenRouter: una llave con limit_reset se renueva sola: no es autonomía, manda la cuenta", () => {
  const conReinicio = { status: 200, cuerpo: { data: { ...KEY.cuerpo.data, limit: 10, limit_remaining: 9.73, limit_reset: "monthly" } } };
  const cuenta = { status: 200, cuerpo: { data: { total_credits: 10, total_usage: 7 } } };
  const r = mapearOpenRouter(conReinicio, cuenta, MARTES);
  assert.equal(r.estado === "ok" && r.restante, 3, "créditos − uso de la cuenta, no limit_remaining");
  assert.equal(r.estado === "ok" && r.bajo, false);
  // Sin los créditos de la cuenta tampoco se inventa autonomía con el tope que se renueva.
  assert.deepEqual(mapearOpenRouter(conReinicio, { status: 403, cuerpo: null }, MARTES), { estado: "error", mensaje: "No pude leer los créditos de OpenRouter" });
  // limit_reset null explícito (el caso real de David) sí cuenta como tope fijo.
  const fijo = mapearOpenRouter({ status: 200, cuerpo: { data: { ...KEY.cuerpo.data, limit_reset: null } } }, CREDITS, MARTES);
  assert.equal(fijo.estado === "ok" && fijo.restante, 9.73);
});

test("OpenRouter: si /credits falla (403) se usa el tope de la llave y no se culpa a la llave", () => {
  const r = mapearOpenRouter(KEY, { status: 403, cuerpo: { error: "forbidden" } }, MARTES);
  assert.equal(r.estado === "ok" && r.restante, 9.73);
  assert.equal(r.estado === "ok" && r.credito, 10);
  // Sin tope en la llave y sin créditos: error, pero del dato que falta, no de la llave.
  const sinLimite = { status: 200, cuerpo: { data: { limit: null, limit_remaining: null, usage_weekly: 0, usage_monthly: 0 } } };
  assert.deepEqual(mapearOpenRouter(sinLimite, { status: 403, cuerpo: null }, MARTES), { estado: "error", mensaje: "No pude leer los créditos de OpenRouter" });
});

test("OpenRouter: el servidor manda el saldo bajo y el texto de alcance ya listos", () => {
  const poco = { status: 200, cuerpo: { data: { total_credits: 10, total_usage: 8.8 } } };
  const r = mapearOpenRouter({ status: 200, cuerpo: { data: { usage_daily: 0, usage_weekly: 0.5, usage_monthly: 0.5 } } }, poco, MARTES);
  assert.equal(r.estado === "ok" && r.bajo, true); // 1.2 < 2
  assert.equal(r.estado === "ok" && r.alcance, "A este ritmo te alcanza para unos tres días"); // 0.5/1.5 = 0.33/día -> 3.6 días
  const justo = mapearOpenRouter(null, { status: 200, cuerpo: { data: { total_credits: 10, total_usage: 8 } } }, MARTES);
  assert.equal(justo.estado === "ok" && justo.bajo, false, "exactamente US$ 2 ya no es bajo");
  const cero = mapearOpenRouter(null, { status: 200, cuerpo: { data: { total_credits: 10, total_usage: 10 } } }, MARTES);
  assert.equal(cero.estado === "ok" && cero.bajo, true);
  assert.equal(cero.estado === "ok" && cero.alcance, "Saldo agotado");
});

test("OpenRouter: si /key falla el restante sale de la cuenta, pero el ritmo y el gasto quedan desconocidos (no 0)", () => {
  for (const caida of [null, { status: 429, cuerpo: {} }, { status: 503, cuerpo: "<html>" }] as const) {
    const r = mapearOpenRouter(caida, CREDITS, MARTES);
    assert.equal(r.estado, "ok");
    if (r.estado !== "ok") return;
    assert.equal(r.restante, 9.73);
    assert.deepEqual(r.proyeccion, { tipo: "desconocida" });
    assert.equal(r.alcance, "No pude calcular el ritmo ahora");
    assert.deepEqual([r.hoy, r.semana, r.mes], [null, null, null]);
    assert.equal(r.bajo, false);
    const s: Saldo = { openrouter: r, elevenlabs: { estado: "ok", usados: 1, limite: 10, renueva: null, plan: null }, actualizado: "" };
    assert.equal(mensajeVoz(s), "Te quedan US$ 9.73 en OpenRouter.", "la voz solo dice el restante");
    assert.equal(saldoVigente(s), false, "el parcial no se guarda en caché");
  }
  // Sin /key y sin saldo, agotado sí se sabe; con saldo bajo la voz lo avisa sin inventar gasto.
  const agotado = mapearOpenRouter(null, { status: 200, cuerpo: { data: { total_credits: 10, total_usage: 10 } } }, MARTES);
  assert.equal(agotado.estado === "ok" && agotado.proyeccion.tipo, "agotado");
  const bajo = mapearOpenRouter(null, { status: 200, cuerpo: { data: { total_credits: 10, total_usage: 9 } } }, MARTES);
  assert.equal(mensajeVoz({ openrouter: bajo, elevenlabs: { estado: "sin_permiso", mensaje: MSG_SIN_PERMISO }, actualizado: "" }), "Te quedan US$ 1.00 en OpenRouter, conviene recargar.");
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
  }, MARTES);
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

test("caché: no se guarda un resultado con error de ElevenLabs ni de OpenRouter", () => {
  const ok = mapearOpenRouter(KEY, CREDITS, MARTES);
  const base = { openrouter: ok, elevenlabs: { estado: "ok", usados: 1, limite: 2, renueva: null, plan: null }, actualizado: "" } as Saldo;
  assert.equal(saldoVigente(base), true);
  assert.equal(saldoVigente({ ...base, elevenlabs: { estado: "sin_permiso", mensaje: MSG_SIN_PERMISO } }), true, "sin_permiso es estable: se guarda");
  assert.equal(saldoVigente({ ...base, elevenlabs: { estado: "error", mensaje: "ElevenLabs no respondió" } }), false);
  assert.equal(saldoVigente({ ...base, openrouter: { estado: "error", mensaje: "x" } }), false);
});

const saldoOk = (over: Record<string, unknown> = {}): Saldo => ({
  openrouter: { estado: "ok", restante: 9.73, credito: 10, hoy: 0.1, semana: 0.26, mes: 0.27, proyeccion: { tipo: "dias", dias: 261 }, alcance: "A este ritmo te alcanza para unos nueve meses", bajo: false, ...over } as never,
  elevenlabs: { estado: "sin_permiso", mensaje: MSG_SIN_PERMISO },
  actualizado: "2026-10-06T12:00:00.000Z",
});

test("duración hablada: apócope, singulares y menos de un día", () => {
  assert.equal(duracion(0), "menos de un día");
  assert.equal(duracion(1), "un día");
  assert.equal(duracion(2), "unos dos días");
  assert.equal(duracion(11), "unos once días");
  assert.equal(duracion(21), "unos veintiún días");
  assert.equal(duracion(29), "unos veintinueve días");
  assert.equal(duracion(31), "un mes");
  assert.equal(duracion(261), "unos nueve meses");
  assert.equal(duracion(365), "unos doce meses");
});

test("alcance: misma frase para pantalla y voz", () => {
  assert.equal(textoAlcance({ tipo: "dias", dias: 0 }), "A este ritmo te alcanza para menos de un día");
  assert.equal(textoAlcance({ tipo: "dias", dias: 68 }), "A este ritmo te alcanza para unos dos meses");
  assert.equal(textoAlcance({ tipo: "mas_de_12_meses" }), "A este ritmo te dura más de doce meses");
  assert.equal(textoAlcance({ tipo: "agotado" }), "Saldo agotado");
});

test("voz: dos frases, monto en cifras con formato y sin el 'hoy' de UTC", () => {
  const texto = mensajeVoz(saldoOk());
  assert.equal(texto, "Te quedan US$ 9.73 en OpenRouter; a este ritmo te alcanza para unos nueve meses. Este mes llevas US$ 0.27.");
  assert.equal(texto.split(/\.\s/).length, 2);
  assert.equal(/hoy/i.test(texto), false);
  assert.match(paraVoz(texto), /^Te quedan nueve dólares con setenta y tres centavos en OpenRouter/);
  assert.match(paraVoz(texto), /Este mes llevas veintisiete centavos\.$/);
});

test("voz: ritmo cero, saldo agotado y saldo bajo", () => {
  assert.match(mensajeVoz(saldoOk({ proyeccion: { tipo: "mas_de_12_meses" }, alcance: "A este ritmo te dura más de doce meses" })), /a este ritmo te dura más de doce meses\./);
  const agotado = mensajeVoz(saldoOk({ restante: 0, proyeccion: { tipo: "agotado" }, alcance: "Saldo agotado", bajo: true }));
  assert.equal(agotado, "Se te acabó el saldo de OpenRouter, conviene recargar. Este mes llevas US$ 0.27.");
  const bajo = mensajeVoz(saldoOk({ restante: 1.5, bajo: true, alcance: "A este ritmo te alcanza para unos veintiún días" }));
  assert.equal(bajo, "Te quedan US$ 1.50 en OpenRouter, conviene recargar; a este ritmo te alcanza para unos veintiún días. Este mes llevas US$ 0.27.");
});

test("voz: con datos de ElevenLabs solo el porcentaje usado; sin datos, nada", () => {
  assert.equal(mensajeVoz(saldoOk()).includes("voz"), false, "sin permiso la voz no dice nada de ElevenLabs");
  const conVoz = { ...saldoOk(), elevenlabs: { estado: "ok", usados: 12480, limite: 100000, renueva: null, plan: null } } as Saldo;
  const texto = mensajeVoz(conVoz);
  assert.match(texto, /Este mes llevas US\$ 0\.27 y la voz va en 12%\.$/);
  assert.equal(texto.split(/\.\s/).length, 2);
  assert.match(paraVoz(texto), /la voz va en 12 por ciento\.$/);
  const sinLimite = { ...saldoOk(), elevenlabs: { estado: "ok", usados: 5, limite: 0, renueva: null, plan: null } } as Saldo;
  assert.equal(mensajeVoz(sinLimite).includes("voz"), false, "límite 0: no se divide entre cero");
});

test("voz: si OpenRouter falla, mensaje corto sin detalles", () => {
  const s: Saldo = { ...saldoOk(), openrouter: { estado: "error", mensaje: "OpenRouter rechazó la llave" } };
  assert.equal(mensajeVoz(s), "No pude consultar tu saldo de OpenRouter ahora. Inténtalo en un momento.");
});
