// Consulta real del saldo de IA (la función `saldo` y la tool `saldo` del agente comparten esto).
// Las llaves se leen del entorno del servidor en cada consulta y nunca viajan al cliente.
import { conCache, consultarSaldo, type Cruda, type Saldo, saldoVigente } from "./saldo.ts";

export const CACHE_MS = 60_000;
const TIEMPO_MS = 6000;

async function pedir(url: string, llave: { cabecera: string; valor: string }): Promise<Cruda> {
  try {
    const r = await fetch(url, { headers: { [llave.cabecera]: llave.valor }, signal: AbortSignal.timeout(TIEMPO_MS) });
    const cuerpo = await r.json().catch(() => null);
    return { status: r.status, cuerpo };
  } catch {
    return null; // red caída o tiempo agotado: se reporta como "no respondió"
  }
}

/** Saldo con caché de 60 s por instancia (OpenRouter y ElevenLabs no necesitan más frescura, y así abrir Más no martilla sus APIs). */
export const obtenerSaldo: () => Promise<Saldo> = conCache(
  () => consultarSaldo({ openrouter: Deno.env.get("OPENROUTER_API_KEY"), elevenlabs: Deno.env.get("ELEVENLABS_API_KEY") }, pedir),
  saldoVigente,
  CACHE_MS,
);
