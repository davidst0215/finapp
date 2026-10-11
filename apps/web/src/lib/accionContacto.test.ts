// Corre con Node: `node --experimental-strip-types --test accionContacto.test.ts`.
// @ts-ignore
import { test } from 'node:test';
// @ts-ignore
import assert from 'node:assert/strict';
import { accionSegura } from './accionContacto.ts';

const WA = 'https://api.whatsapp.com/send?phone=51977333444&text=Llego%2010%20minutos%20tarde';

test('una acción de WhatsApp bien formada pasa tal cual', () => {
  const a = accionSegura({ tipo: 'whatsapp', contacto: 'Rosa', relacion: 'mi madre', numero: '+51 977 333 444', url: WA, texto: 'Llego 10 minutos tarde' });
  assert.deepEqual(a, { tipo: 'whatsapp', contacto: 'Rosa', relacion: 'mi madre', numero: '+51 977 333 444', url: WA, texto: 'Llego 10 minutos tarde' });
});

test('todo lo que encodeURIComponent produce para un mensaje real pasa (emojis, tildes, saltos, & y #)', () => {
  const mensaje = "Llegué 😅👍🏽 ¡ojo! (Café & té) #3 100% ~'*'\nSegunda línea ñandú / ? = + ";
  const url = `https://api.whatsapp.com/send?phone=51977333444&text=${encodeURIComponent(mensaje)}`;
  assert.equal(accionSegura({ tipo: 'whatsapp', contacto: 'Rosa', numero: '+51 977 333 444', url })?.url, url);
});

test('abrir el chat sin mensaje, llamar y mostrar el número', () => {
  const chat = accionSegura({ tipo: 'whatsapp', contacto: 'José', numero: '+51 966 555 666', url: 'https://api.whatsapp.com/send?phone=51966555666' });
  assert.equal(chat?.texto, undefined);
  const llamar = accionSegura({ tipo: 'llamar', contacto: 'José', numero: '+51 966 555 666', url: 'tel:+51966555666' });
  assert.equal(llamar?.url, 'tel:+51966555666');
  const numero = accionSegura({ tipo: 'numero', contacto: 'José', numero: '+51 966 555 666', url: 'tel:+51966555666', urlWhatsapp: 'https://api.whatsapp.com/send?phone=51966555666' });
  assert.equal(numero?.urlWhatsapp, 'https://api.whatsapp.com/send?phone=51966555666');
});

test('lo que la app no reconoce se descarta: otros esquemas, otros dominios, teléfonos mal formados', () => {
  const base = { contacto: 'Rosa', numero: '+51 977 333 444' };
  const malos: unknown[] = [
    null, undefined, 'tel:+51977333444', 42, [], {},
    { ...base, tipo: 'whatsapp', url: 'javascript:alert(1)' },
    { ...base, tipo: 'whatsapp', url: 'https://wa.me/51977333444?text=hola' },
    { ...base, tipo: 'whatsapp', url: 'https://api.whatsapp.com.evil.com/send?phone=51977333444' },
    { ...base, tipo: 'whatsapp', url: 'http://api.whatsapp.com/send?phone=51977333444' },
    { ...base, tipo: 'whatsapp', url: 'https://api.whatsapp.com/send?phone=51977333444&text=hola mundo' },
    { ...base, tipo: 'whatsapp', url: 'https://api.whatsapp.com/send?phone=51977333444&text=a#b' },
    { ...base, tipo: 'whatsapp', url: 'https://api.whatsapp.com/send?phone=51977333444&text=a&phone=1' },
    { ...base, tipo: 'whatsapp', url: 'https://api.whatsapp.com/send?phone=51977333444&text=llegué' }, // tilde cruda: no vino de encodeURIComponent
    { ...base, tipo: 'whatsapp', url: 'https://api.whatsapp.com/send?phone=51977333444&text=hola<script>' },
    { ...base, tipo: 'whatsapp', url: 'https://api.whatsapp.com/send?phone=51977333444&text=100%zz' }, // % sin dos dígitos hexadecimales
    { ...base, tipo: 'whatsapp', url: 'https://api.whatsapp.com/send?phone=51977333444&text=a|b' },
    { ...base, tipo: 'whatsapp', url: 'https://api.whatsapp.com/send?phone=51977333444&text=a"b' },
    { ...base, tipo: 'whatsapp', url: 'https://api.whatsapp.com/send?phone=51977333444&text=a\nb' },
    { ...base, tipo: 'whatsapp', url: 'https://api.whatsapp.com/send?phone=123' },
    { ...base, tipo: 'llamar', url: 'tel:977333444' },
    { ...base, tipo: 'llamar', url: 'tel:+51977333444;ext=1' },
    { ...base, tipo: 'llamar', url: 'sms:+51977333444' },
    { ...base, tipo: 'numero', url: 'tel:+51977333444' },
    { ...base, tipo: 'numero', url: 'tel:+51977333444', urlWhatsapp: 'javascript:1' },
    { ...base, tipo: 'desconocido', url: 'tel:+51977333444' },
    { tipo: 'llamar', numero: '+51 977 333 444', url: 'tel:+51977333444' },
    { tipo: 'llamar', contacto: '  ', numero: '+51 977 333 444', url: 'tel:+51977333444' },
  ];
  for (const m of malos) assert.equal(accionSegura(m), null, JSON.stringify(m));
});

test('el número de la tarjeta sale de la URL, no del campo `numero` del servidor', () => {
  // Un servidor (o un intermediario) que mande otro `numero` no puede hacer que la tarjeta muestre un teléfono y el botón abra otro.
  const wa = accionSegura({ tipo: 'whatsapp', contacto: 'Rosa', numero: '+51 900 000 000', url: WA });
  assert.equal(wa?.numero, '+51 977 333 444');
  const ll = accionSegura({ tipo: 'llamar', contacto: 'Rosa', numero: 'llama al 105', url: 'tel:+51977333444' });
  assert.equal(ll?.numero, '+51 977 333 444');
  const sin = accionSegura({ tipo: 'llamar', contacto: 'Rosa', url: 'tel:+573001234567' }); // sin `numero`: igual se muestra
  assert.equal(sin?.numero, '+57 300 123 4567');
  const nu = accionSegura({ tipo: 'numero', contacto: 'Rosa', numero: 'x', url: 'tel:+5112345678', urlWhatsapp: 'https://api.whatsapp.com/send?phone=5112345678' });
  assert.equal(nu?.numero, '+51 1 234 5678');
  // Los dos botones deben ir al mismo teléfono.
  assert.equal(accionSegura({ tipo: 'numero', contacto: 'Rosa', url: 'tel:+51977333444', urlWhatsapp: 'https://api.whatsapp.com/send?phone=51966555666' }), null);
});

test('los campos de más no se cuelan en lo que se pinta', () => {
  const a = accionSegura({ tipo: 'llamar', contacto: 'Rosa', numero: '+51 977 333 444', url: 'tel:+51977333444', onclick: 'x', extra: 1 });
  assert.deepEqual(Object.keys(a ?? {}).sort(), ['contacto', 'numero', 'tipo', 'url']);
});
