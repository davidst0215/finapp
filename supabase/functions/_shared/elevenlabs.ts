// Voz de Wabid en ElevenLabs, compartida por /tts y por el agente (que la manda junto con su respuesta).
import { paraVoz } from "./voz.ts";

const API_KEY = Deno.env.get("ELEVENLABS_API_KEY");
const VOICE_ID = Deno.env.get("ELEVENLABS_VOICE_ID");
const MODEL_ID = Deno.env.get("ELEVENLABS_MODEL") ?? "eleven_v4";
const SPEED = Number(Deno.env.get("ELEVENLABS_SPEED") ?? "1.13");

export const vozConfigurada = () => Boolean(API_KEY && VOICE_ID);

/** MP3 en streaming: ElevenLabs manda los primeros fragmentos apenas los genera. */
export function pedirVoz(texto: string): Promise<Response> {
  return fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "xi-api-key": API_KEY ?? "" },
    body: JSON.stringify({ text: paraVoz(texto), model_id: MODEL_ID, voice_settings: { speed: SPEED } }),
  });
}
