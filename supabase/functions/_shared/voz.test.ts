// node --experimental-strip-types --test supabase/functions/_shared/voz.test.ts
// Tope de voz: ElevenLabs cobra por carácter, así que lo que se manda nunca pasa de VOZ_MAX y nunca se corta a mitad de palabra.
// Los mismos casos están en apps/web/src/lib/vozTexto.test.mjs (el cliente tiene una copia de acotarVoz).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { acotarVoz, cortoVoz, finesDeOracion, paraVoz, prepararVoz, VOZ_MAX } from "./voz.ts";

/** El resultado es un prefijo del original (más, quizá, un punto de cierre) y no parte ninguna palabra. */
function esCorteLimpio(original: string, corte: string) {
  const base = original.startsWith(corte) ? corte : corte.slice(0, -1);
  assert.ok(original.startsWith(base), `"${corte}" no es prefijo de "${original}"`);
  const siguiente = original[base.length];
  assert.ok(siguiente === undefined || !/[\p{L}\p{N}]/u.test(siguiente), `parte la palabra en "${corte}"`);
}

describe("VOZ_MAX", () => {
  it("el tope es 100 caracteres", () => assert.equal(VOZ_MAX, 100));
});

describe("acotarVoz: lo que cabe pasa entero", () => {
  it("texto corto, con espacios y saltos normalizados", () => {
    assert.equal(acotarVoz("Esta semana gastaste S/ 312, casi todo en comida."), "Esta semana gastaste S/ 312, casi todo en comida.");
    assert.equal(acotarVoz("  Dos\n\nlíneas   juntas.  "), "Dos líneas juntas.");
    assert.equal(acotarVoz("a".repeat(100)), "a".repeat(100));
  });
});

describe("acotarVoz: corta en el último fin de oración", () => {
  const texto = "Mañana tienes tres reuniones. La primera es a las nueve con Marco. La segunda es a las once con Ana y la tercera a las cuatro.";
  it("deja las oraciones completas que caben", () => {
    assert.equal(acotarVoz(texto, 70), "Mañana tienes tres reuniones. La primera es a las nueve con Marco.");
    assert.equal(acotarVoz(texto, 40), "Mañana tienes tres reuniones.");
  });
  it("respeta ? y !", () => {
    assert.equal(acotarVoz("¿Quieres que te detalle los gastos? Son muchos y vienen de varias cuentas distintas.", 50), "¿Quieres que te detalle los gastos?");
    assert.equal(acotarVoz("¡Ojo con el presupuesto de comida! Ya va en noventa por ciento y faltan diez días.", 50), "¡Ojo con el presupuesto de comida!");
  });
  it("una oración de pocas letras al inicio no es toda la respuesta: sigue hasta la pausa", () => {
    const r = acotarVoz("Sí. Esto es un texto mucho más largo para ver qué pasa cuando la primera oración es muy corta y la segunda se pasa.", 100);
    assert.ok(r.startsWith("Sí. Esto es un texto"), r);
    assert.ok(r.length <= 100);
  });
});

describe("acotarVoz: abreviaturas, montos y decimales no parten oraciones", () => {
  it("Dr., Sra., Av.", () => {
    assert.deepEqual(finesDeOracion("Habla con el Dr. Pérez. Luego con la Sra. López."), [23, 48]);
    assert.equal(
      acotarVoz("Cita con el Dr. Pérez en la Av. Arequipa mañana. Después te cuento lo demás con todo el detalle que haga falta.", 60),
      "Cita con el Dr. Pérez en la Av. Arequipa mañana.",
    );
  });
  it("«p. m.» y «etc.» seguidos de minúscula continúan la oración", () => {
    assert.deepEqual(finesDeOracion("Es a las 9 p. m. mañana mismo. Ok."), [30, 34]);
    assert.deepEqual(finesDeOracion("Compra pan, leche, etc. y llama a Ana."), [38]);
  });
  it("montos S/ 45.90 y decimales 12.5 no son fin de oración", () => {
    const t = "Pagaste S/ 45.90 en el almuerzo y gastas 12.5 por ciento más que el mes pasado. Vas bien con el presupuesto general.";
    assert.deepEqual(finesDeOracion(t), [t.indexOf("pasado.") + 7, t.length]);
    assert.equal(acotarVoz(t, 90), "Pagaste S/ 45.90 en el almuerzo y gastas 12.5 por ciento más que el mes pasado.");
  });
  it("un punto final de monto sí cierra la oración", () => {
    assert.deepEqual(finesDeOracion("Te quedan S/ 45. Mañana pagas."), [16, 30]);
  });
});

describe("acotarVoz: primera oración más larga que el tope", () => {
  const larga = "Gastaste S/ 450.50 en comida, S/ 120.00 en taxi, S/ 80 en cine, y además el presupuesto de entretenimiento ya se pasó por mucho esta semana.";
  it("corta en la última coma o dos puntos antes del tope y cierra con punto", () => {
    const r = acotarVoz(larga, 100);
    assert.equal(r, "Gastaste S/ 450.50 en comida, S/ 120.00 en taxi, S/ 80 en cine.");
    esCorteLimpio(larga, r);
    assert.equal(acotarVoz("El resumen de hoy: tres reuniones, dos tareas vencidas y un pago que vence mañana por la mañana temprano", 60), "El resumen de hoy: tres reuniones.");
  });
  it("sin pausa corta en la última palabra completa y quita palabras colgantes", () => {
    const sinPausa = "Una sola oración larguísima sin ninguna pausa natural que sigue y sigue y sigue y sigue y sigue y sigue y sigue y sigue y sigue";
    const r = acotarVoz(sinPausa, 100);
    assert.ok(r.length <= 100 && r.endsWith("."), r);
    assert.doesNotMatch(r, /\b(y|de|la|el|que)\.$/);
    esCorteLimpio(sinPausa, r);
  });
  it("una sola oración de más de 200 caracteres", () => {
    const t = "Esta es una oración larguísima que no termina nunca porque sigue agregando detalles sobre los gastos de la semana pasada, los pagos fijos del mes, las suscripciones que no usas, los recibos de luz y de agua, y todo lo demás que se pueda imaginar sobre las finanzas";
    assert.ok(t.length > 200);
    const r = acotarVoz(t, 100);
    assert.ok(r.length <= 100 && r.endsWith("."), r);
    esCorteLimpio(t, r);
  });
  it("nunca pasa del tope ni parte una palabra, para cualquier tope razonable", () => {
    const parrafo = "Tienes tres reuniones mañana, la primera a las nueve con Marco; después, a las once, el comité de cobranzas. Además, recuerda que el pago de la luz vence el viernes y que Daniel espera tu respuesta sobre el cotizador desde hace seis días.";
    for (let max = 20; max <= 120; max++) {
      const r = acotarVoz(parrafo, max);
      assert.ok(r.length <= max, `${max}: ${r.length} "${r}"`);
      assert.ok(r.length > 0);
      esCorteLimpio(parrafo.replace(/\s+/g, " "), r);
    }
  });
  it("una «palabra» sola más larga que el tope (una URL) es el único caso en que se parte", () => {
    assert.equal(acotarVoz("x".repeat(500), 100).length, 100);
  });
});

describe("prepararVoz: el tope cuenta lo que se envía (montos ya en palabras)", () => {
  it("convierte montos y deja una frase corta tal cual", () => {
    assert.equal(prepararVoz("Esta semana gastaste S/ 312, casi todo en comida."), "Esta semana gastaste trescientos doce soles, casi todo en comida.");
  });
  it("los montos con céntimos crecen al hablarse y el tope se aplica después", () => {
    const raw = "Gastaste S/ 450.50 en comida y S/ 120.00 en taxi, además de S/ 80.25 en cine esta semana.";
    assert.ok(raw.length <= 100);
    assert.ok(paraVoz(raw).length > 100); // "S/ 450.50" son 9 caracteres y en palabras son 52
    const r = prepararVoz(raw);
    assert.ok(r.length <= VOZ_MAX, `${r.length}: ${r}`);
    assert.ok(r.endsWith("."));
    assert.match(r, /^Gastaste cuatrocientos cincuenta soles con cincuenta céntimos en comida/);
  });
  it("quita markdown y emojis antes de contar", () => {
    assert.equal(prepararVoz("**Listo** 🎉 el gasto"), "Listo el gasto");
  });
});

describe("cortoVoz", () => {
  it("en el límite de una palabra, sin puntos suspensivos ni palabras colgantes", () => {
    assert.equal(cortoVoz("corto", 40), "corto");
    assert.equal(cortoVoz("Validar la bolsa de septiembre con el equipo de finanzas y contabilidad", 40), "Validar la bolsa de septiembre");
    assert.equal(cortoVoz("Cargo no reconocido en tu tarjeta de crédito", 32), "Cargo no reconocido");
  });
});
