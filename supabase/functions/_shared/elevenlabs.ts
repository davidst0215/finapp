// Voz de Wabid en ElevenLabs, compartida por /tts y por el agente (que la manda junto con su respuesta).
// ElevenLabs cobra por carácter: quien llama prepara el texto con `prepararVoz` (montos en palabras + tope VOZ_MAX)
// y manda exactamente eso, así lo que se cuenta en los logs (`voz_chars`) es lo que se cobra.

const API_KEY = Deno.env.get("ELEVENLABS_API_KEY");
const VOICE_ID = Deno.env.get("ELEVENLABS_VOICE_ID");
const SPEED = Number(Deno.env.get("ELEVENLABS_SPEED") ?? "1.13");

/** Modelo por defecto. Otro (p. ej. uno más barato) se activa con el secreto ELEVENLABS_MODEL, sin tocar el código. */
export const MODELO_POR_DEFECTO = "eleven_v4";

/**
 * Modelo de voz. Se lee en cada pedido y no al arrancar el módulo: cambiar el secreto vale para el siguiente pedido que
 * llegue a una instancia nueva o ya iniciada, sin redeploy. Un secreto vacío o con espacios no rompe la voz: vale el default.
 */
export const vozModelo = (): string => Deno.env.get("ELEVENLABS_MODEL")?.trim() || MODELO_POR_DEFECTO;

export const vozConfigurada = () => Boolean(API_KEY && VOICE_ID);

/** MP3 en streaming: ElevenLabs manda los primeros fragmentos apenas los genera. `hablado` va tal cual, ya preparado. */
export function pedirVoz(hablado: string): Promise<Response> {
  return fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "xi-api-key": API_KEY ?? "" },
    body: JSON.stringify({ text: hablado, model_id: vozModelo(), voice_settings: { speed: SPEED } }),
  });
}
