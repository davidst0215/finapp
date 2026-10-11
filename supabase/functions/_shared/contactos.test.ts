// node --experimental-strip-types --test supabase/functions/_shared/contactos.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import {
  buscarContacto, type Contacto, frasesNoEsta, fraseCreado, fraseLlamar, fraseNumero, fraseWhatsapp, limpiarAlias, limpiarMensaje,
  limpiarRelacion, mismoNombre, preguntaCual, validarContactoNuevo,
} from "./contactos.ts";
import { prepararVoz, VOZ_MAX } from "./voz.ts";

let n = 0;
const c = (nombre: string, telefono: string, relacion: string | null = null, alias: string[] = []): Contacto =>
  ({ contacto_id: `id${++n}`, nombre, telefono, relacion, alias });

const marcoSaya = c("Marco", "+51999888777", "de Saya");
const marcoGym = c("Marco", "+51988111222", "del gimnasio");
const mama = c("Rosa Tarazona", "+51977333444", "mi madre", ["Mamá", "Mami"]);
const jose = c("José Luis Pérez", "+51966555666", "dentista");
const ninoska = c("Niñoska", "+573001234567", null);
const AGENDA = [marcoSaya, marcoGym, mama, jose, ninoska];

const nombreDe = (r: ReturnType<typeof buscarContacto>) => (r.kind === "one" ? r.contacto.nombre : r.kind);

test("busca por nombre con tildes, mayúsculas y relleno", () => {
  assert.equal(nombreDe(buscarContacto("jose luis", AGENDA)), "José Luis Pérez");
  assert.equal(nombreDe(buscarContacto("JOSÉ", AGENDA)), "José Luis Pérez");
  assert.equal(nombreDe(buscarContacto("el contacto de José Pérez", AGENDA)), "José Luis Pérez");
  assert.equal(nombreDe(buscarContacto("ninoska", AGENDA)), "Niñoska");
  assert.equal(nombreDe(buscarContacto("Niñoska", AGENDA)), "Niñoska");
});

test("busca por apodo: «mi mamá» → Rosa", () => {
  assert.equal(nombreDe(buscarContacto("mi mamá", AGENDA)), "Rosa Tarazona");
  assert.equal(nombreDe(buscarContacto("mami", AGENDA)), "Rosa Tarazona");
  assert.equal(nombreDe(buscarContacto("Rosa mamá", AGENDA)), "Rosa Tarazona", "nombre y apodo juntos");
});

test("dos Marco: ambiguo → pregunta; la relación (pista o dicha) los separa", () => {
  const r = buscarContacto("Marco", AGENDA);
  assert.equal(r.kind, "many");
  if (r.kind === "many") assert.deepEqual(r.contactos.map((x) => x.relacion).sort(), ["de Saya", "del gimnasio"]);
  assert.equal(nombreDe(buscarContacto("Marco", AGENDA, "el de Saya")), "Marco");
  const saya = buscarContacto("Marco", AGENDA, "de Saya");
  assert.equal(saya.kind === "one" && saya.contacto.telefono, "+51999888777");
  const gym = buscarContacto("Marco", AGENDA, "del gimnasio");
  assert.equal(gym.kind === "one" && gym.contacto.telefono, "+51988111222");
  const dicha = buscarContacto("Marco Saya", AGENDA);
  assert.equal(dicha.kind === "one" && dicha.contacto.telefono, "+51999888777", "la relación dentro de lo dicho");
  assert.equal(buscarContacto("Marco", AGENDA, "del trabajo").kind, "many", "una pista que no coincide con nadie no elige");
});

test("nombre exacto gana al parcial, pero entre dos exactos se pregunta", () => {
  const roca = c("Marco Roca", "+51955000111", "Saya");
  assert.equal(buscarContacto("Marco", [marcoSaya, roca]).kind, "one");
  assert.equal(buscarContacto("Marco Roca", [marcoSaya, roca]).kind, "one");
  assert.equal(buscarContacto("Marco", [marcoSaya, marcoGym, roca]).kind, "many");
  const r = buscarContacto("Marco", [marcoSaya, marcoGym, roca]);
  assert.equal(r.kind === "many" && r.contactos.length, 2, "Marco Roca queda fuera: hay dos Marco exactos");
});

test("sin coincidencia: none; nunca adivina", () => {
  assert.equal(buscarContacto("Pedro", AGENDA).kind, "none");
  assert.equal(buscarContacto("Marco Gómez", AGENDA).kind, "none", "una palabra de más no se carga al único Marco");
  assert.equal(buscarContacto("Saya", AGENDA).kind, "none", "una relación sola no elige a nadie");
  assert.equal(buscarContacto("Mar", AGENDA).kind, "none", "sin abreviaturas");
  assert.equal(buscarContacto("Ana", [c("Anabel", "+51900000001")]).kind, "none");
  assert.equal(buscarContacto("", AGENDA).kind, "none");
  assert.equal(buscarContacto("mi", AGENDA).kind, "none", "solo relleno");
  assert.equal(buscarContacto(undefined, AGENDA).kind, "none");
  assert.equal(buscarContacto("Marco", []).kind, "none");
});

test("plural y variantes de la voz: «Marcos» y «Rosas» cubren a Marco y Rosa", () => {
  assert.equal(nombreDe(buscarContacto("Rosas", AGENDA)), "Rosa Tarazona");
});

test("mismoNombre ignora orden, tildes y relleno", () => {
  assert.equal(mismoNombre("Marco Roca", "roca marco"), true);
  assert.equal(mismoNombre("José", "jose"), true);
  assert.equal(mismoNombre("Marco", "Marco Roca"), false);
});

// --- Validación de altas -----------------------------------------------------------------------------------------------
const DICTADO = "Guarda a Marco con el 999 888 777, es de Saya";

test("alta: normaliza el número, limpia la relación y guarda los apodos", () => {
  const v = validarContactoNuevo({ nombre: " Marco ", telefono: "999 888 777", relacion: "es de Saya.", alias: ["Marquitos", "marco", "Marquitos"] }, [], DICTADO);
  assert.deepEqual(v, { ok: true, contacto: { nombre: "Marco", alias: ["Marquitos"], telefono: "+51999888777", relacion: "de Saya" } });
  const sinRel = validarContactoNuevo({ nombre: "Rosa", telefono: "+57 300 123 4567" }, [], "guarda a Rosa con el +57 300 123 4567");
  assert.deepEqual(sinRel, { ok: true, contacto: { nombre: "Rosa", alias: [], telefono: "+573001234567", relacion: null } });
});

test("alta: falta el nombre o el número → se pregunta; número malo → error con frase", () => {
  const sinNombre = validarContactoNuevo({ telefono: "999888777" }, [], "999888777");
  assert.deepEqual([sinNombre.ok, !sinNombre.ok && sinNombre.pregunta], [false, true]);
  const sinTel = validarContactoNuevo({ nombre: "Marco" }, [], "guarda a Marco");
  assert.deepEqual([sinTel.ok, !sinTel.ok && sinTel.pregunta], [false, true]);
  const malo = validarContactoNuevo({ nombre: "Marco", telefono: "999 888" }, [], "guarda a Marco con el 999 888");
  assert.equal(malo.ok, false);
  assert.ok(!malo.ok && !malo.pregunta && /no está completo|No reconozco/.test(malo.error));
  assert.equal(validarContactoNuevo({ nombre: "123", telefono: "999888777" }, [], "").ok, false);
  assert.equal(validarContactoNuevo({ nombre: "x".repeat(101), telefono: "999888777" }, [], "").ok, false);
});

test("alta: el número del modelo debe ser el que David dictó (un dígito cambiado no pasa)", () => {
  const v = validarContactoNuevo({ nombre: "Marco", telefono: "999 888 778" }, [], DICTADO);
  assert.equal(v.ok, false);
  assert.ok(!v.ok && /No estoy segura del número/.test(v.error));
  // Un número que David no dijo en ningún momento se rechaza, aunque el modelo lo traiga bien formado.
  const inventado = validarContactoNuevo({ nombre: "Marco", telefono: "999 888 777", relacion: "de Saya" }, [], "es de Saya");
  assert.ok(!inventado.ok && /No estoy segura del número/.test(inventado.error));
  // Si lo dijo en un turno anterior, el dictado junta los turnos.
  assert.equal(validarContactoNuevo({ nombre: "Marco", telefono: "999 888 777", relacion: "de Saya" }, [], "es de Saya | Guarda a Marco con el 999 888 777").ok, true);
});

test("alta: número repetido → dice de quién es; mismo nombre pide relación; misma relación se rechaza", () => {
  const dup = validarContactoNuevo({ nombre: "Otro", telefono: "999 888 777" }, [marcoSaya], DICTADO);
  assert.ok(!dup.ok && /Ya tienes ese número guardado como Marco \(de Saya\)/.test(dup.error) && dup.duplicado === marcoSaya);

  const homonimo = validarContactoNuevo({ nombre: "Marco", telefono: "988 111 222" }, [marcoSaya], "Guarda a Marco con el 988 111 222");
  assert.ok(!homonimo.ok && homonimo.pregunta === true && /Ya tienes a Marco \(de Saya\)/.test(homonimo.error));

  const conRelacion = validarContactoNuevo({ nombre: "Marco", telefono: "988 111 222", relacion: "del gimnasio" }, [marcoSaya], "Guarda a Marco con el 988 111 222 del gimnasio");
  assert.equal(conRelacion.ok, true);

  const igualRel = validarContactoNuevo({ nombre: "marco", telefono: "988 111 222", relacion: "De Saya" }, [marcoSaya], "Guarda a marco con el 988 111 222 de Saya");
  assert.ok(!igualRel.ok && /con otro número/.test(igualRel.error));
});

test("limpiarRelacion y limpiarAlias", () => {
  assert.equal(limpiarRelacion("  es mi primo.  "), "mi primo");
  assert.equal(limpiarRelacion("son del gimnasio"), "del gimnasio");
  assert.equal(limpiarRelacion(undefined), "");
  assert.deepEqual(limpiarAlias("Mamá, mami, MAMÁ,  ", "Rosa"), ["Mamá", "mami"]);
  assert.deepEqual(limpiarAlias(["Rosa", "Rosi"], "Rosa"), ["Rosi"]);
  assert.deepEqual(limpiarAlias(5, "Rosa"), []);
});

// --- Mensajes ---------------------------------------------------------------------------------------------------------
test("limpiarMensaje: primera persona de David, sin comillas ni firma de Wabid", () => {
  assert.equal(limpiarMensaje("Llego 10 minutos tarde"), "Llego 10 minutos tarde");
  assert.equal(limpiarMensaje("«Llego 10 minutos tarde»"), "Llego 10 minutos tarde");
  assert.equal(limpiarMensaje('"Llego 10 minutos tarde."'), "Llego 10 minutos tarde.");
  for (const firma of ["— Wabid", "Wabid", "Enviado por Wabid", "(Mensaje de Wabid)", "Atentamente, Wabid", "De parte de Wabid.", "- Tu asistente"]) {
    assert.equal(limpiarMensaje(`Llego 10 minutos tarde\n${firma}`), "Llego 10 minutos tarde", firma);
  }
  assert.equal(limpiarMensaje("Hola Marco\n\n\n\nLlego tarde  \n\n"), "Hola Marco\n\nLlego tarde");
  assert.equal(limpiarMensaje("Prueba Wabid, la app que armé"), "Prueba Wabid, la app que armé", "una mención de Wabid dentro del mensaje se respeta");
  assert.equal(limpiarMensaje('Dijo "hola" y "chao"'), 'Dijo "hola" y "chao"', "comillas internas no se tocan");
  assert.equal(limpiarMensaje("Línea 1\r\nLínea 2\u0000"), "Línea 1\nLínea 2");
  assert.equal(limpiarMensaje(undefined), "");
  assert.equal(limpiarMensaje(42), "");
});

// --- Frases -----------------------------------------------------------------------------------------------------------
const SIN_NUMEROS = /\d{4,}|\+\d/;
const dice = (f: { message: string; voz: string }) => prepararVoz(f.voz);

test("«¿cuál?»: nombra relaciones, nunca teléfonos, y la voz cabe", () => {
  const f = preguntaCual([marcoSaya, marcoGym]);
  assert.equal(f.message, "Tengo a Marco (de Saya) y Marco (del gimnasio). ¿Cuál?");
  assert.equal(f.voz, "¿Cuál Marco: de Saya o del gimnasio?");
  assert.doesNotMatch(f.message + f.voz, SIN_NUMEROS);
  assert.ok(dice(f).length <= VOZ_MAX);

  const distintos = preguntaCual([c("Marco Roca", "+51955000111"), c("Marco López", "+51955000222")]);
  assert.equal(distintos.message, "Tengo a Marco Roca y Marco López. ¿Cuál?");
  assert.equal(distintos.voz, "¿Cuál: Marco Roca o Marco López?");

  const muchos = preguntaCual(Array.from({ length: 7 }, (_, i) => c(`Carlos Alberto Fernández de la Vega ${i}`, `+5190000000${i}`, `relación larga número ${i}`)));
  assert.match(muchos.message, /y 3 más\. ¿Cuál\?$/);
  assert.ok(dice(muchos).length <= VOZ_MAX && muchos.voz.length > 0);
});

test("«¿cuál?» con dos contactos que no se distinguen avisa en vez de preguntar", () => {
  const f = preguntaCual([c("Marco", "+51999000111"), c("Marco", "+51999000222")]);
  assert.match(f.message, /no los distingo/);
  assert.ok(dice(f).length <= VOZ_MAX);
});

test("las frases de cada acción: cortas, sin teléfono, en femenino y con tope de voz", () => {
  const largo = "Alejandra Fernanda de los Ángeles Pérez-Villanueva y Salcedo";
  const frases = [
    frasesNoEsta("Pedro", "buscar"), frasesNoEsta("Pedro", "escribir"), frasesNoEsta("Pedro", "llamar"), frasesNoEsta(largo, "escribir"), frasesNoEsta("", "llamar"),
    fraseCreado({ nombre: "Marco", relacion: "de Saya" }), fraseCreado({ nombre: largo, relacion: null }),
    fraseWhatsapp("Marco", "Llego 10 minutos tarde"), fraseWhatsapp(largo, ""), fraseLlamar("Marco"), fraseLlamar(largo),
    fraseNumero(marcoSaya), fraseNumero({ nombre: largo, relacion: null }),
  ];
  for (const f of frases) {
    assert.doesNotMatch(f.message + f.voz, SIN_NUMEROS, f.message);
    assert.ok(dice(f).length <= VOZ_MAX, `${dice(f).length}: ${f.voz}`);
    assert.ok(f.voz.length >= 10 && f.message.length >= 10);
  }
  assert.equal(fraseWhatsapp("Marco", "Llego 10 minutos tarde").voz, "Listo, te dejo el WhatsApp de Marco.");
  assert.equal(fraseWhatsapp("Marco", "Llego 10 minutos tarde").message, "WhatsApp para Marco: «Llego 10 minutos tarde»");
  assert.equal(fraseWhatsapp("Marco", "").message, "Chat de WhatsApp con Marco.");
  assert.equal(frasesNoEsta("Pedro", "escribir").message, "No tengo a Pedro guardado. Dime su número y te dejo el WhatsApp.");
  assert.equal(fraseCreado({ nombre: "Marco", relacion: "de Saya" }).message, "Guardé a Marco (de Saya).");
});
