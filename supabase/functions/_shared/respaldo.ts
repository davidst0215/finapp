// Pedido con respaldo, sin globals de Deno: se prueba con Node (respaldo.test.ts).
//
// MiMo responde casi siempre en ~2 s, pero algunos pedidos se quedan 8–30 s en la cola del proveedor
// (logs del 5-oct). Si el primer pedido no terminó bien en `esperaMs`, o falla antes, sale un segundo
// pedido (que el llamador manda a otro proveedor) y gana el primero que responda bien. Solo los pedidos
// lentos se pagan dos veces.

export async function conRespaldo<T extends { ok: boolean }>(
  pedir: (respaldo: boolean, signal: AbortSignal) => Promise<T>,
  esperaMs: number,
): Promise<T & { respaldo: boolean }> {
  type R = T & { respaldo: boolean };
  const controles = [new AbortController(), new AbortController()];
  const lanzar = (respaldo: boolean): Promise<R> =>
    pedir(respaldo, controles[respaldo ? 1 : 0].signal).then((r) => ({ ...r, respaldo }));

  const primero = lanzar(false);
  let plazo: ReturnType<typeof setTimeout> | undefined;
  let iniciarRespaldo = () => {};
  const segundo = new Promise<R>((ok, falla) => {
    let iniciado = false;
    iniciarRespaldo = () => {
      if (iniciado) return;
      iniciado = true;
      clearTimeout(plazo);
      lanzar(true).then(ok, falla);
    };
    plazo = setTimeout(iniciarRespaldo, esperaMs);
  });
  // Un primero que falla no hace esperar el plazo.
  primero.then((r) => { if (!r.ok) iniciarRespaldo(); }, () => iniciarRespaldo());

  const soloBuenas = (p: Promise<R>) => p.then((r) => (r.ok ? r : Promise.reject(r)));
  try {
    return await Promise.any([soloBuenas(primero), soloBuenas(segundo)]);
  } catch {
    // Ninguno respondió bien: vale lo que contestó el primero; si ni eso, lo del respaldo.
    const [a, b] = await Promise.allSettled([primero, segundo]);
    if (a.status === "fulfilled") return a.value;
    if (b.status === "fulfilled") return b.value;
    throw a.reason;
  } finally {
    clearTimeout(plazo);
    for (const c of controles) c.abort(); // corta el que quedó en vuelo
  }
}
