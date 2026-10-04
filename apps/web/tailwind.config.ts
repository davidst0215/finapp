import type { Config } from 'tailwindcss';

const STEPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950] as const;
const scale = (name: string) =>
  Object.fromEntries(STEPS.map((s) => [s, `rgb(var(--${name}-${s}) / <alpha-value>)`]));

export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      // Neutros de Norte + un solo color funcional (rojo). Valores por tema en src/index.css. Ver DESIGN.md.
      // slate-950 = fondo … slate-100 = texto 1; primary-600 = botón (texto encima: slate-950).
      colors: {
        slate: scale('slate'),
        primary: scale('primary'),
        income: 'rgb(var(--income) / <alpha-value>)',
        expense: 'rgb(var(--expense) / <alpha-value>)',
        danger: 'rgb(var(--expense) / <alpha-value>)',
        transfer: 'rgb(var(--transfer) / <alpha-value>)',
      },
      fontFamily: {
        sans: ['Comfortaa', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
} satisfies Config;
