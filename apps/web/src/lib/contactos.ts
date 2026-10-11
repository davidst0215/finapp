// Contactos de Wabid (tabla `contactos`, migración 018): validar el formulario, leer lo que devuelve el selector de contactos
// del celular y filtrar la lista. Lógica pura, sin React ni red: se prueba con Node (contactos.test.ts).
import { formatearTelefono, normalizarTelefono } from './telefono.ts'; // con extensión: las pruebas corren en Node

export type Contacto = { contacto_id: string; nombre: string; alias: string[]; telefono: string; relacion: string | null };

/** Lo que escribe David en el formulario, tal cual. */
export type Borrador = { nombre: string; telefono: string; relacion: string; alias: string };
/** Lo que se guarda: ya limpio y con el teléfono en E.164. */
export type Valores = { nombre: string; telefono: string; relacion: string | null; alias: string[] };
export type Errores = Partial<Record<'nombre' | 'telefono' | 'relacion' | 'alias', string>>;

// Los mismos topes que el esquema (018_contactos.sql) y que Wabid por voz (supabase/functions/_shared/contactos.ts).
export const MAX_NOMBRE = 100;
export const MAX_RELACION = 100;
export const MAX_ALIAS = 10;
export const MAX_ALIAS_LARGO = 60;
/**
 * Tope de contactos por usuario: 1000, el `max_rows` de PostgREST en producción (un `.limit(2000)` se recortaba en silencio).
 * Una sola lectura trae toda la agenda; el trigger de 018_contactos.sql lo hace cumplir y esta constante espeja
 * supabase/functions/_shared/contactos.ts.
 */
export const MAX_CONTACTOS = 1000;

const sinTildes = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
const limpiar = (s: string): string => s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
/** Para comparar: sin tildes, en minúsculas y con una sola clase de espacio. */
export const comparable = (s: string): string => limpiar(sinTildes(s)).toLowerCase();

/** "es de Saya." → "de Saya": la relación se guarda como nota corta, igual que cuando la dice Wabid. */
export const limpiarRelacion = (s: string): string => limpiar(s).replace(/^(?:es|son|era|eran)\s+/i, '').replace(/[.\s]+$/, '');

/** Apodos separados por comas: sin vacíos, sin repetidos y sin el propio nombre. */
export function parsearAlias(texto: string, nombre: string): string[] {
  const vistos = new Set([comparable(nombre)]);
  const salida: string[] = [];
  for (const crudo of texto.split(',')) {
    const a = limpiar(crudo);
    const k = comparable(a);
    if (!a || !k || vistos.has(k)) continue;
    vistos.add(k);
    salida.push(a);
  }
  return salida;
}

export function validarBorrador(b: Borrador): { ok: true; valores: Valores } | { ok: false; errores: Errores } {
  const errores: Errores = {};
  const nombre = limpiar(b.nombre);
  if (!nombre) errores.nombre = 'Escribe el nombre.';
  else if (nombre.length > MAX_NOMBRE) errores.nombre = `Máximo ${MAX_NOMBRE} letras.`;
  else if (!/\p{L}/u.test(nombre)) errores.nombre = 'El nombre necesita letras.';

  const tel = normalizarTelefono(b.telefono);
  if (!tel.ok) errores.telefono = tel.error;

  const relacion = limpiarRelacion(b.relacion);
  if (relacion.length > MAX_RELACION) errores.relacion = `Máximo ${MAX_RELACION} letras.`;

  const alias = parsearAlias(b.alias, nombre);
  if (alias.length > MAX_ALIAS) errores.alias = `Máximo ${MAX_ALIAS} apodos.`;
  else if (alias.some((a) => a.length > MAX_ALIAS_LARGO)) errores.alias = `Cada apodo, de ${MAX_ALIAS_LARGO} letras como máximo.`;

  if (Object.keys(errores).length > 0 || !tel.ok) return { ok: false, errores };
  return { ok: true, valores: { nombre, telefono: tel.e164, relacion: relacion || null, alias } };
}

/** Las iniciales para el círculo de la fila: "Marco Roca" → "MR", "Niñoska" → "N". */
export function monograma(nombre: string): string {
  const palabras = limpiar(nombre).split(' ').filter((p) => /\p{L}/u.test(p));
  return palabras.slice(0, 2).map((p) => ([...p.replace(/^[^\p{L}]+/u, '')][0] ?? '').toUpperCase()).join('') || '?';
}

/** Orden de la lista: alfabético en español, sin distinguir mayúsculas ni tildes. */
export const ordenar = (lista: readonly Contacto[]): Contacto[] =>
  [...lista].sort((a, b) =>
    a.nombre.localeCompare(b.nombre, 'es', { sensitivity: 'base' }) ||
    (a.relacion ?? '').localeCompare(b.relacion ?? '', 'es', { sensitivity: 'base' }) || // dos Marco: por su relación
    a.telefono.localeCompare(b.telefono));

/** Búsqueda por nombre, apodo, relación o dígitos del teléfono. Cada palabra escrita debe aparecer en algún campo. */
export function filtrar(lista: readonly Contacto[], consulta: string): readonly Contacto[] {
  const palabras = comparable(consulta).split(' ').filter(Boolean);
  if (palabras.length === 0) return lista;
  return lista.filter((c) => {
    const texto = comparable([c.nombre, ...c.alias, c.relacion ?? ''].join(' '));
    const digitos = c.telefono.replace(/\D/g, '');
    return palabras.every((p) => texto.includes(p) || (/^\d+$/.test(p) && digitos.includes(p)));
  });
}

// --- Selector de contactos del celular (Contact Picker API) -----------------------------------------------------------
/** Lo que devuelve `navigator.contacts.select(['name', 'tel'])`: cada contacto trae listas. */
export type ContactoDelSelector = { name?: string[]; tel?: string[] };

export type Importacion = {
  nuevos: Valores[];
  yaEstaban: number;
  sinNumero: number;
  sinNombre: number;
  /** Contactos con más de un número válido: se guardó el primero. */
  conVarios: number;
  /** Nuevos que no caben porque se llegó al tope de MAX_CONTACTOS. */
  sinCupo: number;
};

/**
 * Convierte lo elegido en el selector a contactos nuevos. Un contacto del celular puede tener varios números, pero aquí cada
 * número es una fila: se guarda el primero válido (dos "Marco" sin relación obligarían a Wabid a preguntar cuál cada vez).
 * No se repiten números: ni los que ya tiene David ni los que vienen dos veces en la selección. Con el tope de MAX_CONTACTOS
 * solo entran los que caben (en el orden elegido); el resto se cuenta en `sinCupo` para avisarlo.
 */
export function desdeSelector(elegidos: readonly ContactoDelSelector[], existentes: readonly Contacto[]): Importacion {
  const vistos = new Set(existentes.map((c) => c.telefono));
  const cupo = Math.max(0, MAX_CONTACTOS - existentes.length);
  const r: Importacion = { nuevos: [], yaEstaban: 0, sinNumero: 0, sinNombre: 0, conVarios: 0, sinCupo: 0 };
  for (const e of elegidos) {
    const nombre = limpiar(String(e.name?.[0] ?? '')).slice(0, MAX_NOMBRE);
    const validos: string[] = [];
    for (const t of e.tel ?? []) {
      const n = normalizarTelefono(t);
      if (n.ok && !validos.includes(n.e164)) validos.push(n.e164);
    }
    if (validos.length === 0) { r.sinNumero++; continue; }
    if (!nombre || !/\p{L}/u.test(nombre)) { r.sinNombre++; continue; }
    if (validos.length > 1) r.conVarios++;
    const telefono = validos[0]!;
    if (vistos.has(telefono)) { r.yaEstaban++; continue; }
    vistos.add(telefono);
    if (r.nuevos.length >= cupo) { r.sinCupo++; continue; }
    r.nuevos.push({ nombre, telefono, relacion: null, alias: [] });
  }
  return r;
}

/** "Importé 3 contactos. 1 ya estaba, 2 sin número válido." */
export function resumenImportacion(r: Importacion): string {
  const n = r.nuevos.length;
  const partes: string[] = [];
  if (r.yaEstaban) partes.push(r.yaEstaban === 1 ? '1 ya estaba' : `${r.yaEstaban} ya estaban`);
  if (r.sinNumero) partes.push(`${r.sinNumero} sin número válido`);
  if (r.sinNombre) partes.push(`${r.sinNombre} sin nombre`);
  if (r.conVarios) partes.push(r.conVarios === 1 ? '1 tenía varios números: guardé el primero' : `${r.conVarios} tenían varios números: guardé el primero de cada uno`);
  if (r.sinCupo) partes.push(`${r.sinCupo === 1 ? '1 no cupo' : `${r.sinCupo} no cupieron`}: el tope es de ${MAX_CONTACTOS} contactos`);
  const cabeza = n === 0 ? 'No importé ningún contacto nuevo' : n === 1 ? 'Importé 1 contacto' : `Importé ${n} contactos`;
  return partes.length ? `${cabeza}. ${partes.join(', ')}.` : `${cabeza}.`;
}

/** ¿Este navegador tiene el selector de contactos? (Chrome en Android, con HTTPS.) */
export function soportaSelector(nav: { contacts?: { select?: unknown } } | undefined, ventana: object | undefined): boolean {
  return !!nav && !!ventana && typeof nav.contacts?.select === 'function' && 'ContactsManager' in ventana;
}

/** Para mostrar el número bajo el nombre. */
export const numeroLegible = (c: Pick<Contacto, 'telefono'>): string => formatearTelefono(c.telefono);
