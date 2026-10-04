// Errores del módulo google y su traducción a mensajes legibles (UI y agente). Lógica pura.

// `fetch` inyectable: en producción es el global; en las pruebas, uno falso.
export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export type Need = "calendar" | "gmail_read" | "gmail_compose";

// Error de la API de Calendar o Gmail (https://www.googleapis.com/…).
export class GoogleApiError extends Error {
  status: number;
  reasons: string[];
  constructor(status: number, reasons: string[], message: string) {
    super(message);
    this.name = "GoogleApiError";
    this.status = status;
    this.reasons = reasons;
  }
}

// Error del endpoint OAuth (https://oauth2.googleapis.com/token).
export class GoogleTokenError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "GoogleTokenError";
    this.status = status;
    this.code = code;
  }
}

export class GoogleNotConnected extends Error {
  constructor() {
    super("Google no está conectado");
    this.name = "GoogleNotConnected";
  }
}

// El refresh_token ya no sirve (revocado, vencido, contraseña cambiada…): hay que reconectar.
export class GoogleReauth extends Error {
  constructor(message = "La autorización de Google venció o fue revocada") {
    super(message);
    this.name = "GoogleReauth";
  }
}

export class GoogleScopeMissing extends Error {
  need: Need;
  constructor(need: Need) {
    super(`Falta el permiso ${need}`);
    this.name = "GoogleScopeMissing";
    this.need = need;
  }
}

export class GoogleInputError extends Error {
  code: string;
  constructor(message: string, code = "invalido") {
    super(message);
    this.name = "GoogleInputError";
    this.code = code;
  }
}

// Una acción que necesita confirmación explícita de David (invitados, borrador que cambió…).
export class GoogleConflict extends Error {
  code: string;
  data: Record<string, unknown>;
  constructor(code: string, message: string, data: Record<string, unknown> = {}) {
    super(message);
    this.name = "GoogleConflict";
    this.code = code;
    this.data = data;
  }
}

export class GoogleConfigError extends Error {
  missing: string[];
  constructor(missing: string[]) {
    super(`Falta configurar: ${missing.join(", ")}`);
    this.name = "GoogleConfigError";
    this.missing = missing;
  }
}

export type Described = { code: string; status: number; message: string; data?: Record<string, unknown> };

const NEED_LABEL: Record<Need, string> = {
  calendar: "la agenda (Calendar)",
  gmail_read: "leer el correo (Gmail)",
  gmail_compose: "dejar borradores (Gmail)",
};

export function describeError(e: unknown): Described {
  if (e instanceof GoogleNotConnected) {
    return { code: "no_conectado", status: 409, message: "Aún no conectas tu Google. Ábrelo desde Agenda con «Conectar Google»." };
  }
  if (e instanceof GoogleReauth) {
    return { code: "reauth", status: 409, message: "Google cerró la conexión (la autorización venció o la revocaron). Vuelve a conectarla desde Agenda." };
  }
  if (e instanceof GoogleScopeMissing) {
    return {
      code: "permiso",
      status: 403,
      message: `Falta el permiso para ${NEED_LABEL[e.need]}. Reconecta Google y deja marcadas todas las casillas.`,
      data: { need: e.need },
    };
  }
  if (e instanceof GoogleInputError) return { code: e.code, status: 400, message: e.message };
  if (e instanceof GoogleConflict) return { code: e.code, status: 409, message: e.message, data: e.data };
  if (e instanceof GoogleConfigError) return { code: "config", status: 500, message: e.message, data: { missing: e.missing } };
  if (e instanceof GoogleTokenError) {
    if (e.code === "invalid_client" || e.code === "unauthorized_client") {
      return { code: "config", status: 500, message: "Las credenciales de Google de Wabid no son válidas. Revisa GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET." };
    }
    return { code: "google", status: 502, message: "Google no respondió bien al renovar el acceso. Intenta de nuevo en un momento." };
  }
  if (e instanceof GoogleApiError) {
    const reasons = e.reasons.map((r) => r.toLowerCase());
    const has = (...rs: string[]) => rs.some((r) => reasons.includes(r.toLowerCase()));
    if (has("accessNotConfigured", "SERVICE_DISABLED")) {
      const api = /gmail/i.test(e.message) ? "Gmail" : /calendar/i.test(e.message) ? "Calendar" : "de Google";
      return { code: "api_deshabilitada", status: 503, message: `Falta habilitar la API ${api} en el proyecto de Google Cloud (APIs y servicios > Biblioteca).` };
    }
    if (has("insufficientPermissions", "ACCESS_TOKEN_SCOPE_INSUFFICIENT")) {
      return { code: "permiso", status: 403, message: "Google dice que falta un permiso. Reconecta Google y deja marcadas todas las casillas." };
    }
    if (e.status === 429 || has("rateLimitExceeded", "userRateLimitExceeded", "RESOURCE_EXHAUSTED")) {
      return { code: "limite", status: 429, message: "Google pidió esperar un momento. Intenta de nuevo en unos segundos." };
    }
    if (e.status === 401) {
      return { code: "reauth", status: 409, message: "Google no aceptó la autorización. Vuelve a conectar tu cuenta desde Agenda." };
    }
    if (e.status === 404) {
      return { code: "no_encontrado", status: 404, message: "Google no encontró ese elemento. Puede que ya lo hayan movido o borrado." };
    }
    if (e.status >= 500) {
      return { code: "google", status: 502, message: "Google tuvo un problema. Intenta de nuevo en un momento." };
    }
    return { code: "google", status: 502, message: "Google rechazó la solicitud.", data: { detail: e.message.slice(0, 200) } };
  }
  return { code: "interno", status: 500, message: "Algo falló. Intenta de nuevo." };
}
