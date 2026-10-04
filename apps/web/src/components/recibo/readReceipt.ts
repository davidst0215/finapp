import { supabase } from '@/lib/supabase';
import {
  READ_TIMEOUT_MS,
  describeFailure,
  limaToday,
  parseReading,
  type ReceiptProblem,
  type ReceiptReading,
} from './reciboLogic.ts';

export type ReadOutcome =
  | { ok: true; reading: ReceiptReading }
  | { ok: false; problem: ReceiptProblem };

const nameOf = (e: unknown): string =>
  typeof e === 'object' && e !== null && 'name' in e ? String((e as { name: unknown }).name) : '';

/** El servidor responde `{ error: "..." }`; si el cuerpo no es eso, null. */
async function serverMessageOf(res: Response): Promise<string | null> {
  try {
    const body: unknown = await res.json();
    const message = (body as { error?: unknown } | null)?.error;
    return typeof message === 'string' ? message : null;
  } catch {
    return null;
  }
}

/** Error de `functions.invoke` -> problema legible. Distingue respuesta HTTP, relay, tiempo agotado y red. */
async function problemFromInvokeError(error: unknown): Promise<ReceiptProblem> {
  const context = (error as { context?: unknown } | null)?.context;
  const name = nameOf(error);
  if (name === 'FunctionsHttpError' && context instanceof Response) {
    return describeFailure({ status: context.status, serverMessage: await serverMessageOf(context) });
  }
  if (name === 'FunctionsRelayError') return describeFailure({ status: 502 });
  // FunctionsFetchError: no hubo respuesta. Abortar por el tiempo límite es distinto de no tener red.
  if (nameOf(context) === 'AbortError') return describeFailure({ timedOut: true });
  return describeFailure({ network: true });
}

/**
 * Envía la foto reducida a `parse-receipt` con la sesión de David y devuelve la lectura.
 * Nunca lanza: todo fallo vuelve como `{ ok: false, problem }`.
 * Quien llama ignora el resultado si la corrida ya no es la vigente (cancelada o reemplazada).
 */
export async function readReceipt(imageBase64: string, signal: AbortSignal): Promise<ReadOutcome> {
  try {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) return { ok: false, problem: describeFailure({ status: 401 }) };

    // Control propio del tiempo límite: no depender de `timeout` de functions.invoke.
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort();
    signal.addEventListener('abort', onAbort);
    if (signal.aborted) controller.abort();
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, READ_TIMEOUT_MS);
    let result;
    try {
      result = await supabase.functions.invoke('parse-receipt', {
        body: { image: imageBase64 },
        headers: { Authorization: `Bearer ${session.access_token}` },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
    const { data, error } = result;
    if (timedOut) return { ok: false, problem: describeFailure({ timedOut: true }) };
    if (error) return { ok: false, problem: await problemFromInvokeError(error) };

    const reading = parseReading(data, limaToday(Date.now()));
    // La función ya rechaza montos <= 0 con 422; esto cubre un monto que no sobrevive a nuestra validación.
    if (reading.amountCents === null) return { ok: false, problem: describeFailure({ status: 422 }) };
    return { ok: true, reading };
  } catch {
    return { ok: false, problem: describeFailure({ network: true }) };
  }
}
