import { test } from "node:test";
import assert from "node:assert/strict";
import { rangoSemana } from "./semana.ts";

// limaNow: los getters en UTC dan la hora de Lima (así lo arma el agente).
const lima = (iso: string) => new Date(`${iso}T15:00:00Z`);

test("un lunes la semana es solo hoy; los 7 días van del martes anterior a hoy", () => {
  assert.deepEqual(rangoSemana(lima("2026-10-05")), { lunes: "2026-10-05", hace7: "2026-09-29", hoy: "2026-10-05" });
});

test("un domingo la semana empieza el lunes de hace 6 días", () => {
  assert.deepEqual(rangoSemana(lima("2026-10-11")), { lunes: "2026-10-05", hace7: "2026-10-05", hoy: "2026-10-11" });
});

test("un miércoles cruza de mes sin romperse", () => {
  assert.deepEqual(rangoSemana(lima("2026-10-01")), { lunes: "2026-09-28", hace7: "2026-09-25", hoy: "2026-10-01" });
});
