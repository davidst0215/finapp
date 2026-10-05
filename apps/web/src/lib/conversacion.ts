// Modo conversación del orbe: lo que no depende de React. Se prueba con Node (conversacion.test.ts).

/** Silencios seguidos (cada uno ~5–8 s, lo que tarda el navegador en rendirse) antes de dejar de escuchar. */
export const MAX_SILENCIOS = 2;

// Solo cuando la frase COMPLETA es una despedida: «gracias, ahora agenda…» sigue la conversación.
const CIERRE = /^(muchas gracias|gracias|listo|ok gracias|chao|chau|adi[oó]s|hasta luego|eso es todo|nada m[aá]s|ya est[aá]|terminamos)( wabid)?$/;

export function esFraseDeCierre(texto: string): boolean {
  const limpio = texto.toLowerCase().replace(/[.,;:!¡?¿]/g, ' ').replace(/\s+/g, ' ').trim();
  return CIERRE.test(limpio);
}

// «Escuchar al abrir»: al abrir Wabid (o volver a él) el orbe arranca escuchando. Así el doble toque atrás del
// celular, configurado para abrir Wabid, sirve para invocarlo. Encendido por defecto; se apaga en Más.
const CLAVE = 'wabid_escuchar_al_abrir';

export function leerEscucharAlAbrir(): boolean {
  try {
    return localStorage.getItem(CLAVE) !== '0';
  } catch {
    return true;
  }
}

export function guardarEscucharAlAbrir(activo: boolean) {
  try {
    localStorage.setItem(CLAVE, activo ? '1' : '0');
  } catch {
    /* sin almacenamiento (modo privado): queda el valor por defecto */
  }
}
