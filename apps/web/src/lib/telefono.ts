// Teléfonos del formulario de Contactos: normalizar a E.164 (Perú por defecto) y mostrarlos con espacios.
// ESPEJO de supabase/functions/_shared/telefono.ts (lo que usa Wabid por voz): las reglas deben dar el mismo resultado, y
// apps/web/tests/contactos/telefono.test.mjs lo comprueba con una tabla de casos. Si cambias una regla, cámbiala en los dos.
// Lo único que difiere son las frases de error: aquí están escritas para un formulario, allá para decirse en voz.

export type Telefono = { ok: true; e164: string } | { ok: false; error: string };

const PE = '51';
// Móvil peruano: 9 dígitos que empiezan con 9. Fijo: 8 dígitos (Lima = 1 + 7; provincias = código de área de 2 + 6) con primer dígito 1-8.
const PE_MOVIL = /^9\d{8}$/;
const PE_FIJO = /^[1-8]\d{7}$/;

export const TEL_FALTA = 'Escribe el número.';
const TEL_INVALIDO = 'No parece un número válido. En Perú son 9 dígitos y empiezan con 9; de otro país, con el prefijo (+57…).';
const TEL_PE_INCOMPLETO = 'Ese número peruano no está completo: los celulares tienen 9 dígitos y empiezan con 9.';
const TEL_SIN_AREA = 'Falta el código de área (en Lima, el 1) o el prefijo del país.';

const ok = (e164: string): Telefono => ({ ok: true, e164 });
const no = (error: string): Telefono => ({ ok: false, error });

/**
 * "999 888 777" → "+51999888777". Perú por defecto; otros países solo con prefijo ("+57 300 123 4567" o "0057…"). Se aceptan
 * espacios, puntos, guiones y paréntesis; una letra u otro símbolo se rechaza y un número que no encaja nunca se "arregla".
 */
export function normalizarTelefono(v: unknown): Telefono {
  if (typeof v !== 'string' && typeof v !== 'number') return no(TEL_FALTA);
  const crudo = String(v).trim();
  if (!crudo) return no(TEL_FALTA);
  if (crudo.length > 40 || !/^[\d\s().+-]+$/.test(crudo)) return no(TEL_INVALIDO);
  const s = crudo.replace(/[\s().-]/g, '');
  if (!/^\+?\d+$/.test(s)) return no(TEL_INVALIDO);

  const internacional = s.startsWith('+') ? s.slice(1) : s.startsWith('00') ? s.slice(2) : null;
  if (internacional !== null) {
    if (!/^[1-9]\d{7,14}$/.test(internacional)) return no(TEL_INVALIDO);
    if (internacional.startsWith(PE)) {
      const nacional = internacional.slice(PE.length);
      return PE_MOVIL.test(nacional) || PE_FIJO.test(nacional) ? ok(`+${internacional}`) : no(TEL_PE_INCOMPLETO);
    }
    return ok(`+${internacional}`);
  }

  if (PE_MOVIL.test(s)) return ok(`+${PE}${s}`);
  if (s.length === 11 && s.startsWith(PE) && PE_MOVIL.test(s.slice(PE.length))) return ok(`+${s}`);
  if (/^0[1-8]\d{7}$/.test(s)) return ok(`+${PE}${s.slice(1)}`);
  if (/^[1-8]\d{6,7}$/.test(s)) return no(TEL_SIN_AREA);
  if (s.startsWith('9') && s.length < 9) return no(TEL_PE_INCOMPLETO);
  return no(TEL_INVALIDO);
}

const CC_3 = /^(21\d|22\d|23\d|24\d|25\d|26\d|29\d|35\d|37\d|38\d|42\d|50\d|59\d|67\d|68\d|69\d|85\d|87\d|88\d|96\d|97\d|99\d)/;
const largoCodigo = (d: string): number => (/^[17]/.test(d) ? 1 : CC_3.test(d) ? 3 : 2);

/** "+51999888777" → "+51 999 888 777". Un valor que no es E.164 se devuelve tal cual. */
export function formatearTelefono(e164: string): string {
  if (!/^\+[1-9]\d{7,14}$/.test(e164)) return e164;
  const d = e164.slice(1);
  if (d.startsWith(PE)) {
    const n = d.slice(PE.length);
    if (PE_MOVIL.test(n)) return `+${PE} ${n.slice(0, 3)} ${n.slice(3, 6)} ${n.slice(6)}`;
    if (PE_FIJO.test(n)) return `+${PE} ${n[0]} ${n.slice(1, 4)} ${n.slice(4)}`;
  }
  const cc = largoCodigo(d);
  const grupos = d.slice(cc).match(/\d{1,3}/g) ?? [];
  // Un último grupo de un solo dígito se une al anterior: 300 123 4567, no 300 123 456 7.
  if (grupos.length > 1 && grupos[grupos.length - 1]!.length === 1) grupos.splice(-2, 2, grupos.slice(-2).join(''));
  return `+${d.slice(0, cc)} ${grupos.join(' ')}`;
}
