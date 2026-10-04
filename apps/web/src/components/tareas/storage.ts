// localStorage tolerante: puede faltar (modo privado, datos bloqueados) o lanzar (cuota, permisos).
// Lo guardado es comodidad (último destino, búsquedas recientes): sin almacenamiento la pantalla funciona igual.

export function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // sin almacenamiento: la preferencia vale solo para esta sesión
  }
}

export function removeStorage(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // idem
  }
}
