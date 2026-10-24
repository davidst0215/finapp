// Carga inicial del cerebro de caja (SPEC-cerebro.md, módulo carga-inicial): pasa el respaldo del prototipo «Cierre 2026»
// (Documents/Wabid/cierre-2026-vN.json) y el plan (bolsas, meta, caja) a SQL para Wabid. NO se conecta a la base: escribe el SQL
// en la salida para revisarlo antes de aplicarlo. Los datos personales viven en esos JSON, fuera del repo.
//
//   node scripts/cargar-cierre.mjs <respaldo.json> <plan.json> <user_id> > carga.sql
//
// plan.json: { "cuenta": "Tarjeta débito", "caja": 470, "cajaEsperadaAntes": -231.40,
//              "plan": { "inicio": "2026-10-24", "meta_monto": 10500, "meta_fecha": "2026-12-31", "colchon": 0 },
//              "bolsas": [{ "nombre": "Comida", "tope_semanal": 200, "categorias": ["Alimentación"], "arrastre": false, "orden": 1,
//                           "tope_nuevo": null, "tope_nuevo_desde": null }, …] }
//
// Repetible: cada fila se inserta solo si no existe (pagos por descripción, bolsas por nombre, plan por usuario). El saldo de la
// cuenta solo se fija si todavía está en `cajaEsperadaAntes`: correrlo después de nuevos movimientos no pisa el saldo real.
import { readFileSync } from "node:fs";

const [respaldoPath, planPath, userId] = process.argv.slice(2);
if (!respaldoPath || !planPath || !/^[0-9a-f-]{36}$/.test(userId ?? "")) {
  console.error("uso: node scripts/cargar-cierre.mjs <respaldo.json> <plan.json> <user_id>");
  process.exit(1);
}
const st = JSON.parse(readFileSync(respaldoPath, "utf8"));
const cfg = JSON.parse(readFileSync(planPath, "utf8"));

const q = (s) => (s === null || s === undefined ? "NULL" : `'${String(s).replaceAll("'", "''")}'`);
const num = (n) => { const v = Number(n); if (!Number.isFinite(v)) throw new Error(`monto inválido: ${n}`); return v.toFixed(2); };
const diasDelMes = (ym) => { const [y, m] = ym.split("-").map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); };
const fechaEnMes = (ym, dia) => `${ym}-${String(Math.min(dia, diasDelMes(ym))).padStart(2, "0")}`;
const mesSiguiente = (ym) => { let [y, m] = ym.split("-").map(Number); m++; if (m > 12) { m = 1; y++; } return `${y}-${String(m).padStart(2, "0")}`; };
const mesCorte = st.corte.fecha.slice(0, 7);

// Nombres como se dicen (con tildes): «pagué el teléfono» tiene que encontrar «Teléfono».
const NOMBRES = {
  telefono: "Teléfono", subvencion: "Subvención", elevenlabs: "ElevenLabs", "disney plus": "Disney Plus", "gastos loki": "Gastos Loki",
  "deuda yape": "Deuda Yape", "deuda interbank": "Deuda Interbank", "deuda banco": "Deuda banco", "deuda hugo": "Deuda Hugo",
};
const nombre = (s) => { const t = String(s).trim(); return NOMBRES[t.toLowerCase()] ?? t.charAt(0).toUpperCase() + t.slice(1); };
const categoria = (mv) => (/deuda/i.test(mv.concepto) ? "Deudas" : mv.categoria);

// CTS y gratificación como en el prototipo (montos fijos en esta versión: SPEC, pregunta abierta 6).
const s = st.sueldo;
const cts = (Number(s.bruto) + Number(s.gratiJulio) / 6) / 12 * Number(s.mesesCts);
const grati = Number(s.bruto) * Number(s.mesesGrati) / 6 * (s.salud === "eps" ? 1.0675 : 1.09) - Number(s.retencion5ta || 0);

/** Primera fecha sin pagar de un mensual, desde el mes de corte (lo de octubre ya pagado salta a noviembre). */
function proximaMensual(mv) {
  let ym = mv.desde && mv.desde > mesCorte ? mv.desde : mesCorte;
  for (let i = 0; i < 24; i++, ym = mesSiguiente(ym)) if (!st.pagados[`m:${mv.id}:${ym}`]) return fechaEnMes(ym, Number(mv.dia) || 1);
  throw new Error(`${mv.concepto}: 24 meses pagados por adelantado`);
}

const pagos = []; // { descripcion, tipo, monto, frecuencia, dia, fecha, categoria }
if (s.activo !== false) {
  let ym = s.desde && s.desde > mesCorte ? s.desde : mesCorte;
  while (st.pagados[`s:sueldo:${ym}`]) ym = mesSiguiente(ym);
  pagos.push({ descripcion: "Sueldo", tipo: "income", monto: s.neto, frecuencia: "monthly", dia: Number(s.diaPago), fecha: fechaEnMes(ym, Number(s.diaPago)), categoria: "Sueldo" });
  if (s.retiraCts && !st.pagados["s:cts"]) pagos.push({ descripcion: "CTS", tipo: "income", monto: cts, frecuencia: "once", dia: null, fecha: s.fechaCts, categoria: "Sueldo" });
  if (!st.pagados["s:grati"]) pagos.push({ descripcion: "Gratificación", tipo: "income", monto: grati, frecuencia: "once", dia: null, fecha: s.fechaGrati, categoria: "Sueldo" });
}
for (const mv of st.movimientos) {
  const tipo = mv.tipo === "ingreso" ? "income" : "expense";
  if (mv.frecuencia === "diaria") continue; // el día a día pasa a las bolsas
  if (mv.frecuencia === "unica") {
    if (st.pagados[`m:${mv.id}`]) continue;
    pagos.push({ descripcion: nombre(mv.concepto), tipo, monto: mv.monto, frecuencia: "once", dia: null, fecha: mv.fecha, categoria: categoria(mv) });
  } else if (mv.frecuencia === "mensual") {
    pagos.push({ descripcion: nombre(mv.concepto), tipo, monto: mv.monto, frecuencia: "monthly", dia: Number(mv.dia), fecha: proximaMensual(mv), categoria: categoria(mv) });
  }
}

const U = q(userId);
const cuenta = `(SELECT account_id FROM accounts WHERE user_id = ${U} AND account_name = ${q(cfg.cuenta)})`;
const cat = (nombreCat, tipo) => `(SELECT category_id FROM categories WHERE user_id IS NULL AND category_name = ${q(nombreCat)} AND category_type = ${q(tipo)})`;
const out = [];
out.push(`-- Carga del cerebro de caja para ${userId}, generada desde ${respaldoPath.split(/[\\/]/).pop()} el ${new Date().toISOString().slice(0, 10)}.`);
out.push("BEGIN;");
out.push(`-- Caja real: ${num(cfg.caja)} en ${cfg.cuenta} (solo si el saldo sigue en ${num(cfg.cajaEsperadaAntes)}: saldo inicial + movimientos ya registrados).`);
out.push(`UPDATE accounts SET current_balance = ${num(cfg.caja)}, updated_at = NOW() WHERE user_id = ${U} AND account_name = ${q(cfg.cuenta)} AND current_balance = ${num(cfg.cajaEsperadaAntes)};`);
out.push(`-- ${pagos.length} pagos y cobros programados`);
for (const p of pagos) {
  out.push(`INSERT INTO recurring_transactions (user_id, account_id, category_id, transaction_type, amount, currency_code, description, frequency, day_of_month, start_date, next_due_date, is_active, auto_register)
SELECT ${U}, ${cuenta}, ${cat(p.categoria, p.tipo)}, ${q(p.tipo)}, ${num(p.monto)}, 'PEN', ${q(p.descripcion)}, ${q(p.frecuencia)}, ${p.dia ?? Number(p.fecha.slice(8, 10))}, ${q(p.fecha)}, ${q(p.fecha)}, TRUE, FALSE
WHERE NOT EXISTS (SELECT 1 FROM recurring_transactions WHERE user_id = ${U} AND description = ${q(p.descripcion)});`);
}
out.push(`-- ${cfg.bolsas.length} bolsas`);
for (const b of cfg.bolsas) {
  const cats = b.categorias ? `ARRAY[${b.categorias.map(q).join(", ")}]::text[]` : "NULL";
  out.push(`INSERT INTO bolsas (user_id, nombre, tope_semanal, categorias, arrastre, orden, tope_nuevo, tope_nuevo_desde)
SELECT ${U}, ${q(b.nombre)}, ${num(b.tope_semanal)}, ${cats}, ${b.arrastre ? "TRUE" : "FALSE"}, ${Number(b.orden) || 0}, ${b.tope_nuevo == null ? "NULL" : num(b.tope_nuevo)}, ${q(b.tope_nuevo_desde)}
WHERE NOT EXISTS (SELECT 1 FROM bolsas WHERE user_id = ${U} AND lower(nombre) = lower(${q(b.nombre)}));`);
}
const p = cfg.plan;
out.push(`INSERT INTO plan_caja (user_id, inicio, meta_monto, meta_fecha, colchon) VALUES (${U}, ${q(p.inicio)}, ${p.meta_monto == null ? "NULL" : num(p.meta_monto)}, ${q(p.meta_fecha)}, ${num(p.colchon ?? 0)})
ON CONFLICT (user_id) DO UPDATE SET inicio = EXCLUDED.inicio, meta_monto = EXCLUDED.meta_monto, meta_fecha = EXCLUDED.meta_fecha, colchon = EXCLUDED.colchon, actualizado = NOW();`);
out.push("COMMIT;");
console.log(out.join("\n"));
console.error(`pagos: ${pagos.map((x) => `${x.descripcion} ${x.tipo === "income" ? "+" : "-"}${num(x.monto)} ${x.frecuencia} ${x.fecha}`).join(" | ")}`);
