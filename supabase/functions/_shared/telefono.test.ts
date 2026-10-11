// node --experimental-strip-types --test supabase/functions/_shared/telefono.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { coincideConDictado, formatearTelefono, normalizarTelefono, telefonosEnTexto, urlLlamar, urlWhatsapp } from "./telefono.ts";

const e164 = (v: unknown) => {
  const t = normalizarTelefono(v);
  return t.ok ? t.e164 : `ERROR: ${t.error}`;
};

test("celular peruano en cualquier formato dictado o escrito → +51…", () => {
  for (const v of ["999 888 777", "999888777", "999-888-777", "999.888.777", "(999) 888 777", " 999 888 777 ", "9998 88777", 999888777]) {
    assert.equal(e164(v), "+51999888777", String(v));
  }
});

test("con prefijo de Perú, con o sin +, con 00", () => {
  for (const v of ["+51 999 888 777", "+51999888777", "51 999 888 777", "51999888777", "0051 999 888 777", "(+51) 999-888-777"]) {
    assert.equal(e164(v), "+51999888777", v);
  }
});

test("fijos peruanos: Lima con 01 o 1, provincias con 0 + código de área", () => {
  assert.equal(e164("01 234 5678"), "+5112345678");
  assert.equal(e164("(01) 234-5678"), "+5112345678");
  assert.equal(e164("+51 1 234 5678"), "+5112345678");
  assert.equal(e164("044 123 456"), "+5144123456");
});

test("otros países solo con prefijo", () => {
  assert.equal(e164("+57 300 123 4567"), "+573001234567");
  assert.equal(e164("0057 300 123 4567"), "+573001234567");
  assert.equal(e164("+1 (415) 555-2671"), "+14155552671");
  assert.equal(e164("+34 612 345 678"), "+34612345678");
});

test("lo que no encaja se rechaza con una frase útil y nunca se adivina", () => {
  const malos: [unknown, RegExp][] = [
    ["", /Cuál es su número/],
    [null, /Cuál es su número/],
    [undefined, /Cuál es su número/],
    ["   ", /Cuál es su número/],
    ["abc", /No reconozco/],
    ["999 888 777 anexo 2", /No reconozco/], // letras: no se descarta el anexo en silencio
    ["999 888 77", /no está completo/], // 8 dígitos que empiezan con 9
    ["99988877799", /No reconozco/], // 11 dígitos que no empiezan con 51
    ["888 777 666", /No reconozco/], // 9 dígitos que no empiezan con 9
    ["+51 999 888 77", /no está completo/],
    ["+51 888 777 666", /no está completo/],
    ["234 5678", /código de área/], // 7 dígitos: ¿de qué ciudad?
    ["1 234 5678", /código de área/],
    ["+0 1234 5678", /No reconozco/],
    ["+12345", /No reconozco/],
    ["+1234567890123456", /No reconozco/], // 16 dígitos
    ["++51999888777", /No reconozco/],
    ["51+999888777", /No reconozco/],
    ["573001234567", /No reconozco/], // Colombia sin +: no se supone
    ["9".repeat(60), /No reconozco/],
    [{}, /Cuál es su número/],
  ];
  for (const [v, re] of malos) {
    const t = normalizarTelefono(v);
    assert.equal(t.ok, false, String(v));
    if (!t.ok) assert.match(t.error, re, String(v));
  }
});

test("formatearTelefono: agrupa para leerlo", () => {
  assert.equal(formatearTelefono("+51999888777"), "+51 999 888 777");
  assert.equal(formatearTelefono("+5112345678"), "+51 1 234 5678");
  assert.equal(formatearTelefono("+573001234567"), "+57 300 123 4567");
  assert.equal(formatearTelefono("+14155552671"), "+1 415 555 2671");
  assert.equal(formatearTelefono("+5917123456"), "+591 712 3456");
  assert.equal(formatearTelefono("+34612345678"), "+34 612 345 678");
  assert.equal(formatearTelefono("no es un número"), "no es un número");
});

test("urlWhatsapp: api.whatsapp.com (nunca wa.me), teléfono en dígitos y texto codificado", () => {
  const u = urlWhatsapp("+51999888777", "Llego 10 minutos tarde");
  assert.equal(u, "https://api.whatsapp.com/send?phone=51999888777&text=Llego%2010%20minutos%20tarde");
  assert.ok(!u.includes("wa.me"));
  assert.ok(!u.includes("+"), "el + del E.164 no va en la URL");
});

test("urlWhatsapp: emojis, tildes, saltos de línea, & y # llegan intactos al otro lado", () => {
  const texto = "Llegué 😅👍🏽 ¡ojo! Café & té #3 100%\nSegunda línea ñandú / ? = + ";
  const u = urlWhatsapp("+51999888777", texto);
  const url = new URL(u);
  assert.equal(url.origin + url.pathname, "https://api.whatsapp.com/send");
  assert.equal(url.searchParams.get("phone"), "51999888777");
  assert.equal(url.searchParams.get("text"), texto);
  assert.equal([...url.searchParams.keys()].join(","), "phone,text", "el & del texto no abre un parámetro nuevo");
  assert.equal(url.hash, "", "el # del texto no abre un fragmento");
  assert.ok(!/[\s\n]/.test(u), "ni espacios ni saltos crudos");
  assert.ok(u.includes("%F0%9F%98%85"), "el emoji va en UTF-8 por componente, no como par suplente");
  assert.ok(u.includes("%0A"));
  assert.ok(u.includes("%26") && u.includes("%23"));
});

test("urlWhatsapp: sin texto abre el chat; un sustituto suelto no lanza; el tope no parte un emoji", () => {
  assert.equal(urlWhatsapp("+51999888777"), "https://api.whatsapp.com/send?phone=51999888777");
  assert.equal(urlWhatsapp("+51999888777", ""), "https://api.whatsapp.com/send?phone=51999888777");
  assert.doesNotThrow(() => urlWhatsapp("+51999888777", "mitad de un emoji \uD83D y otra \uDE05"));
  const largo = urlWhatsapp("+51999888777", "😅".repeat(600));
  assert.equal(new URL(largo).searchParams.get("text"), "😅".repeat(500));
});

test("urlWhatsapp y urlLlamar rechazan un teléfono que no es E.164", () => {
  for (const mal of ["999888777", "+051999888777", "+51 999 888 777", "", "javascript:alert(1)"]) {
    assert.throws(() => urlWhatsapp(mal, "hola"), /Teléfono/, mal);
    assert.throws(() => urlLlamar(mal), /Teléfono/, mal);
  }
  assert.equal(urlLlamar("+51999888777"), "tel:+51999888777");
});

test("telefonosEnTexto y coincideConDictado: el número del modelo debe ser el que David dijo", () => {
  const dictado = "Guarda a Marco con el 999 888 777, es de Saya";
  assert.deepEqual(telefonosEnTexto(dictado), ["+51999888777"]);
  assert.equal(coincideConDictado("+51999888777", dictado), true);
  assert.equal(coincideConDictado("+51999888778", dictado), false, "un dígito cambiado");
  assert.equal(coincideConDictado("+51999888777", "es el +51 999-888-777 de Marco"), true);
  assert.equal(coincideConDictado("+51999888777", "el de Saya"), false, "sin ningún teléfono dictado no hay con qué contrastar: no se acepta");
  assert.equal(coincideConDictado("+51999888777", "es de Saya | guarda a Marco con el 999 888 777"), true, "el número vino en un turno anterior");
  assert.equal(coincideConDictado("+51999888777", "reunión el 11-10-2026 a las 10"), false, "una fecha no es un teléfono");
  assert.deepEqual(telefonosEnTexto("llego 10 minutos tarde"), []);
  assert.deepEqual(telefonosEnTexto("es el 9 9 9 8 8 8 7 7 7"), ["+51999888777"], "dígito por dígito");
  assert.deepEqual(telefonosEnTexto("999 888 | 777 000"), [], "dos turnos no se funden en un número");
});
