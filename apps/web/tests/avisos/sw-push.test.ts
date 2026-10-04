// Prueba public/sw-push.js tal como se sirve: se evalúa en un contexto con un `self` simulado.
//   node --experimental-strip-types --test apps/web/tests/avisos/sw-push.test.ts
// (El comportamiento con el sw.js real de producción en Chrome se comprobó aparte con Playwright + CDP.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const ORIGEN = "https://myfinai.vercel.app";
const codigo = readFileSync(new URL("../../public/sw-push.js", import.meta.url), "utf8");

type Ventana = {
  url: string;
  focused: boolean;
  navegadas: string[];
  enfocadas: number;
  mensajes: unknown[];
  navigate: (url: string) => Promise<Ventana | null>;
  focus: () => Promise<Ventana>;
  postMessage: (m: unknown) => void;
};

function ventana(url: string, opciones: { focused?: boolean; navigateFalla?: boolean } = {}): Ventana {
  const v: Ventana = {
    url,
    focused: opciones.focused ?? false,
    navegadas: [],
    enfocadas: 0,
    mensajes: [],
    navigate: (destino) => {
      if (opciones.navigateFalla) return Promise.reject(new TypeError("cliente sin controlar"));
      v.navegadas.push(destino);
      return Promise.resolve(v);
    },
    focus: () => {
      v.enfocadas++;
      return Promise.resolve(v);
    },
    postMessage: (m) => v.mensajes.push(JSON.parse(JSON.stringify(m))), // el objeto nace en el "realm" de vm
  };
  return v;
}

// Carga el script en un `self` simulado y devuelve los manejadores registrados y lo que el script hizo con la API.
function cargar(ventanas: Ventana[] = []) {
  const manejadores: Record<string, (e: unknown) => void> = {};
  const mostradas: Array<{ titulo: string; opciones: Record<string, unknown> }> = [];
  const abiertas: string[] = [];
  const self = {
    location: { origin: ORIGEN },
    addEventListener: (tipo: string, fn: (e: unknown) => void) => {
      manejadores[tipo] = fn;
    },
    registration: {
      showNotification: (titulo: string, opciones: Record<string, unknown>) => {
        // El objeto lo crea el script en otro "realm" de vm: se normaliza para poder compararlo.
        mostradas.push({ titulo, opciones: JSON.parse(JSON.stringify(opciones)) });
        return Promise.resolve();
      },
    },
    clients: {
      matchAll: () => Promise.resolve(ventanas),
      openWindow: (url: string) => {
        abiertas.push(url);
        return Promise.resolve(null);
      },
    },
  };
  vm.runInNewContext(codigo, { self, URL, Promise, Date, JSON });
  return { manejadores, mostradas, abiertas };
}

async function recibirPush(sw: ReturnType<typeof cargar>, data: { json?: () => unknown; text?: () => string } | null) {
  const esperas: Promise<unknown>[] = [];
  sw.manejadores["push"]!({ data, waitUntil: (p: Promise<unknown>) => esperas.push(p) });
  await Promise.all(esperas);
  return esperas.length;
}

async function tocar(sw: ReturnType<typeof cargar>, data: Record<string, unknown> | undefined) {
  const esperas: Promise<unknown>[] = [];
  let cerrada = false;
  sw.manejadores["notificationclick"]!({
    notification: { data, close: () => (cerrada = true) },
    waitUntil: (p: Promise<unknown>) => esperas.push(p),
  });
  await Promise.all(esperas);
  return { cerrada };
}

test("registra los dos manejadores que necesita Web Push", () => {
  const sw = cargar();
  assert.deepEqual(Object.keys(sw.manejadores).sort(), ["notificationclick", "push"]);
});

test("push: muestra título, cuerpo, ruta y marca del aviso", async () => {
  const sw = cargar();
  const aviso = { v: 1, id: "n-7", kind: "pago", title: "Netflix vence mañana", body: "S/ 45.90", url: "/recurring", ts: 1759600000000 };
  assert.equal(await recibirPush(sw, { json: () => aviso }), 1, "una sola promesa para waitUntil");
  assert.equal(sw.mostradas.length, 1);
  assert.equal(sw.mostradas[0]!.titulo, "Netflix vence mañana");
  assert.deepEqual(sw.mostradas[0]!.opciones, {
    body: "S/ 45.90",
    icon: "/icons/icon-192.png",
    badge: "/icons/badge-96.png",
    lang: "es",
    tag: "n-7",
    timestamp: 1759600000000,
    data: { url: `${ORIGEN}/recurring`, id: "n-7", kind: "pago" },
  });
});

test("push: avisa a las ventanas abiertas para que refresquen su bandeja", async () => {
  const abierta = ventana(`${ORIGEN}/tareas`);
  const sw = cargar([abierta]);
  await recibirPush(sw, { json: () => ({ id: "n-8", kind: "tarea", title: "x" }) });
  assert.deepEqual(abierta.mensajes, [{ type: "wabid:aviso", id: "n-8", kind: "tarea" }]);
});

test("push: un mensaje ilegible o vacío igual muestra una notificación", async () => {
  const sw = cargar();
  await recibirPush(sw, { json: () => { throw new SyntaxError("no es json"); }, text: () => "texto suelto" });
  await recibirPush(sw, null);
  await recibirPush(sw, { json: () => null });
  assert.equal(sw.mostradas.length, 3);
  assert.equal(sw.mostradas[0]!.titulo, "Wabid");
  assert.equal(sw.mostradas[0]!.opciones["body"], "texto suelto");
  assert.equal(sw.mostradas[1]!.titulo, "Wabid");
  assert.equal(sw.mostradas[1]!.opciones["body"], "");
  assert.equal(sw.mostradas[2]!.titulo, "Wabid");
});

test("push: ignora campos con tipos raros y no deja sacar al usuario de la app", async () => {
  const sw = cargar();
  await recibirPush(sw, { json: () => ({ title: 42, body: { x: 1 }, id: 7, url: "https://evil.example/robo", ts: "ayer" }) });
  const { titulo, opciones } = sw.mostradas[0]!;
  assert.equal(titulo, "Wabid");
  assert.equal(opciones["body"], "");
  assert.equal(opciones["tag"], undefined);
  assert.equal((opciones["data"] as { url: string }).url, `${ORIGEN}/avisos`);
  assert.equal(typeof opciones["timestamp"], "number");
  for (const hostil of ["//evil.example/x", "javascript:alert(1)", "data:text/html,hola"]) {
    await recibirPush(sw, { json: () => ({ title: "x", url: hostil }) });
    assert.equal((sw.mostradas.at(-1)!.opciones["data"] as { url: string }).url, `${ORIGEN}/avisos`, hostil);
  }
});

test("clic: cierra el aviso y abre la app en su ruta si no hay ventanas", async () => {
  const sw = cargar([]);
  const { cerrada } = await tocar(sw, { url: `${ORIGEN}/recurring` });
  assert.equal(cerrada, true);
  assert.deepEqual(sw.abiertas, [`${ORIGEN}/recurring`]);
});

test("clic: reutiliza la ventana abierta (la enfocada primero), navega y la enfoca", async () => {
  const otra = ventana(`${ORIGEN}/dashboard`);
  const enfocada = ventana(`${ORIGEN}/tareas`, { focused: true });
  const sw = cargar([otra, enfocada]);
  await tocar(sw, { url: `${ORIGEN}/recurring` });
  assert.deepEqual(enfocada.navegadas, [`${ORIGEN}/recurring`]);
  assert.equal(enfocada.enfocadas, 1);
  assert.deepEqual(otra.navegadas, []);
  assert.deepEqual(sw.abiertas, []);
});

test("clic: si la ventana ya está en esa ruta solo la enfoca (sin recargar)", async () => {
  const aqui = ventana(`${ORIGEN}/avisos`);
  const sw = cargar([aqui]);
  await tocar(sw, { url: `${ORIGEN}/avisos` });
  assert.deepEqual(aqui.navegadas, []);
  assert.equal(aqui.enfocadas, 1);
});

test("clic: si la ventana no se deja navegar, abre una nueva", async () => {
  const sw = cargar([ventana(`${ORIGEN}/tareas`, { navigateFalla: true })]);
  await tocar(sw, { url: `${ORIGEN}/recurring` });
  assert.deepEqual(sw.abiertas, [`${ORIGEN}/recurring`]);
});

test("clic: sin datos o con una URL ajena abre la bandeja", async () => {
  const sw = cargar([]);
  await tocar(sw, undefined);
  await tocar(sw, { url: "https://evil.example/robo" });
  assert.deepEqual(sw.abiertas, [`${ORIGEN}/avisos`, `${ORIGEN}/avisos`]);
});
