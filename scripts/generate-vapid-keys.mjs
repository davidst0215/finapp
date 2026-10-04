#!/usr/bin/env node
// Genera un par de claves VAPID para los avisos push de Wabid.
//
//   node scripts/generate-vapid-keys.mjs
//
// Solo imprime en pantalla: no escribe nada en disco, asi que no hay nada que commitear.
// La salida es un archivo .env valido (las lineas con # son comentarios).
//
// Formato: el estandar de `web-push generate-vapid-keys`.
//   publica  = punto P-256 sin comprimir (65 bytes) en base64url; es la misma que usa el navegador
//   privada  = escalar de 32 bytes en base64url
// Si cambias el par, todos los dispositivos deben volver a activar los avisos (sus suscripciones
// quedan atadas a la clave publica con la que se crearon).
import { generateKeyPairSync } from 'node:crypto';

const SUBJECT = 'mailto:salguedotarazona@gmail.com';
const PROJECT_REF = 'rrhyyclltgaecfyertqh';

const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const { x, y } = publicKey.export({ format: 'jwk' });
const { d } = privateKey.export({ format: 'jwk' });
const publica = Buffer.concat([Buffer.from([4]), Buffer.from(x, 'base64url'), Buffer.from(y, 'base64url')]).toString('base64url');

console.log(`# Claves VAPID de Wabid. Generadas ahora; no se guardaron en ningun archivo.
#
# 1) Secretos de las edge functions (Supabase). Copia estas 3 lineas a un archivo FUERA del repo,
#    por ejemplo %TEMP%/vapid.env, cargalas y borra el archivo:
#      npx supabase secrets set --env-file <ese archivo> --project-ref ${PROJECT_REF}
VAPID_PUBLIC_KEY=${publica}
VAPID_PRIVATE_KEY=${d}
VAPID_SUBJECT=${SUBJECT}
#
# 2) Variable publica del frontend (Vercel: Settings > Environment Variables; o apps/web/.env.local).
#    Es la misma clave publica. La app se la pide al servidor (accion vapid-key); esta variable solo es
#    un respaldo si la funcion no responde.
VITE_VAPID_PUBLIC_KEY=${publica}
#
# La clave PRIVADA solo va en Supabase. Si se filtra, genera un par nuevo y repite los pasos.`);
