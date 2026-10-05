// Tabla de rutas de la función. Una sola función atiende al dispositivo (/device/*, token propio) y a la
// app (/ui/*, JWT): el prefijo de la ruta deja visible de qué lado de la frontera de confianza viene cada pedido.

export type Route =
  | { name: "device.ping" }
  | { name: "device.event" }
  | { name: "device.approval"; id: string }
  | { name: "device.messageNext"; sessionId: string }
  | { name: "device.messageAck"; id: string }
  | { name: "device.taskNext" }
  | { name: "device.taskEvent"; id: string }
  | { name: "ui.overview" }
  | { name: "ui.sessionEvents"; sessionId: string }
  | { name: "ui.sessionTimeline"; sessionId: string }
  | { name: "ui.deviceCreate" }
  | { name: "ui.devicePatch"; id: string }
  | { name: "ui.deviceRevoke"; id: string }
  | { name: "ui.approvalDecision"; id: string }
  | { name: "ui.messageCreate"; sessionId: string }
  | { name: "ui.taskCreate" }
  | { name: "ui.taskCancel"; id: string };

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const SESSION = "[A-Za-z0-9._:-]{1,100}";

// [método, patrón, constructor]
const TABLE: ReadonlyArray<readonly [string, RegExp, (m: RegExpExecArray) => Route]> = [
  ["GET", /^\/device\/ping$/, () => ({ name: "device.ping" })],
  ["POST", /^\/device\/events$/, () => ({ name: "device.event" })],
  ["GET", new RegExp(`^/device/approvals/(${UUID})$`), (m) => ({ name: "device.approval", id: m[1]! })],
  ["POST", new RegExp(`^/device/sessions/(${SESSION})/messages/next$`), (m) => ({ name: "device.messageNext", sessionId: m[1]! })],
  ["POST", new RegExp(`^/device/messages/(${UUID})/ack$`), (m) => ({ name: "device.messageAck", id: m[1]! })],
  ["POST", /^\/device\/tasks\/next$/, () => ({ name: "device.taskNext" })],
  ["POST", new RegExp(`^/device/tasks/(${UUID})/events$`), (m) => ({ name: "device.taskEvent", id: m[1]! })],
  ["GET", /^\/ui\/overview$/, () => ({ name: "ui.overview" })],
  ["GET", new RegExp(`^/ui/sessions/(${SESSION})/events$`), (m) => ({ name: "ui.sessionEvents", sessionId: m[1]! })],
  ["GET", new RegExp(`^/ui/sessions/(${SESSION})/timeline$`), (m) => ({ name: "ui.sessionTimeline", sessionId: m[1]! })],
  ["POST", /^\/ui\/devices$/, () => ({ name: "ui.deviceCreate" })],
  ["PATCH", new RegExp(`^/ui/devices/(${UUID})$`), (m) => ({ name: "ui.devicePatch", id: m[1]! })],
  ["DELETE", new RegExp(`^/ui/devices/(${UUID})$`), (m) => ({ name: "ui.deviceRevoke", id: m[1]! })],
  ["POST", new RegExp(`^/ui/approvals/(${UUID})/decision$`), (m) => ({ name: "ui.approvalDecision", id: m[1]! })],
  ["POST", new RegExp(`^/ui/sessions/(${SESSION})/messages$`), (m) => ({ name: "ui.messageCreate", sessionId: m[1]! })],
  ["POST", /^\/ui\/tasks$/, () => ({ name: "ui.taskCreate" })],
  ["POST", new RegExp(`^/ui/tasks/(${UUID})/cancel$`), (m) => ({ name: "ui.taskCancel", id: m[1]! })],
];

// Quita el prefijo con el que Supabase entrega la ruta (/claude-events/...) y la barra final.
function normalize(pathname: string): string {
  let p = pathname.replace(/^\/functions\/v1/, "").replace(/^\/claude-events(?=\/|$)/, "");
  p = p.replace(/\/+$/, "");
  return p === "" ? "/" : p;
}

export function matchRoute(method: string, pathname: string): Route | "not_found" | "method_not_allowed" {
  const path = normalize(pathname);
  const verb = method.toUpperCase();
  let pathExists = false;
  for (const [routeMethod, pattern, build] of TABLE) {
    const m = pattern.exec(path);
    if (!m) continue;
    pathExists = true;
    if (routeMethod === verb) return build(m);
  }
  return pathExists ? "method_not_allowed" : "not_found";
}
