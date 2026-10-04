// Clases compartidas por las pantallas de agenda y correo.

/** Anillo de foco visible (teclado). Mismo color que el texto principal: se ve en claro y oscuro. */
export const focusRing = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-100';

/** Botón circular de 44 px (objetivo táctil mínimo). */
export const iconButton = `inline-flex h-11 w-11 flex-none items-center justify-center rounded-full border border-slate-700 bg-slate-800 text-slate-200 active:bg-slate-700 disabled:opacity-50 ${focusRing}`;

/** Botón circular principal (acción primaria de la pantalla). */
export const iconButtonPrimary = `inline-flex h-11 w-11 flex-none items-center justify-center rounded-full bg-primary-600 text-slate-950 active:bg-primary-700 disabled:opacity-50 ${focusRing}`;

export const btnPrimary = `btn-primary inline-flex min-h-[44px] items-center justify-center gap-2 ${focusRing}`;
export const btnSecondary = `btn-secondary inline-flex min-h-[44px] items-center justify-center gap-2 ${focusRing}`;
