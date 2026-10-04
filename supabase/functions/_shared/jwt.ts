// `sub` de un token de usuario (rol authenticated), sin verificar la firma. Sirve para arrancar
// trabajo en paralelo mientras auth.getUser valida la sesión: la firma ya la revisó el gateway
// (verify_jwt) y PostgREST la vuelve a revisar en cada consulta. La anon key (rol anon) da null.
// Sin globals de Deno: se prueba con Node (jwt.test.ts).
export function jwtSub(token: string): string | null {
  const partes = token.split(".");
  if (partes.length !== 3) return null;
  try {
    const b64 = partes[1].replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Uint8Array.from(atob(b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), "=")), (c) => c.charCodeAt(0));
    const payload = JSON.parse(new TextDecoder().decode(bytes));
    return payload?.role === "authenticated" && typeof payload.sub === "string" && payload.sub ? payload.sub : null;
  } catch {
    return null;
  }
}

export const bearer = (req: Request) => {
  const auth = req.headers.get("Authorization") ?? "";
  return auth.startsWith("Bearer ") ? auth.slice(7) : "";
};
