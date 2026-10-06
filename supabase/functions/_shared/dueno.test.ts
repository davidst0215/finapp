import { test } from "node:test";
import assert from "node:assert/strict";
import { esDueno } from "./dueno.ts";

const DAVID = "11111111-1111-4111-8111-111111111111";
const OTRO = "22222222-2222-4222-8222-222222222222";

test("el dueño es quien coincide con WABID_OWNER_ID", () => {
  assert.equal(esDueno(DAVID, DAVID), true);
  assert.equal(esDueno(OTRO, DAVID), false);
});

test("falla cerrado: sin ownerId o sin usuario nadie es dueño (ni dos vacíos entre sí)", () => {
  assert.equal(esDueno(DAVID, undefined), false);
  assert.equal(esDueno(DAVID, null), false);
  assert.equal(esDueno(DAVID, ""), false);
  assert.equal(esDueno(undefined, undefined), false);
  assert.equal(esDueno("", ""), false);
  assert.equal(esDueno(null, null), false);
});
