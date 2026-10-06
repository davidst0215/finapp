// ¿El usuario es el dueño de Wabid? Falla cerrado: sin WABID_OWNER_ID configurado (o sin usuario) nadie lo es.
// Sin globals de Deno: se prueba con Node (dueno.test.ts).
export const esDueno = (userId: string | null | undefined, ownerId: string | null | undefined): boolean =>
  Boolean(userId) && userId === ownerId; // userId con valor + igualdad implica ownerId con valor
