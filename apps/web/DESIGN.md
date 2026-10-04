# Wabid · Design

Mundo visual heredado de **Norte** (gestor de pendientes de David): monocromo "80s noir", calmo y preciso. Aprobado por David el 2026-10-04 (paleta v2). Reemplaza el mundo anterior de finapp (burdeos/cobre, tarjetas holográficas), que queda como anti-referencia.

## Color

Estrategia: **restringida**. Neutros + un único color funcional. **Dos temas: oscuro y claro** (David los quiere ambos, 2026-10-04), con opción "automático" que sigue al sistema. Hoy solo el oscuro está implementado; el claro requiere pasar los tokens a variables CSS. Maqueta de ambos: `scratchpad/wabid_maqueta/maqueta.html` (`?light` para claro).

| Rol | Oscuro | Claro (pendiente) |
|---|---|---|
| Fondo | `#141417` | `#fafafa` |
| Superficie | `#1f1f23` | `#ffffff` |
| Elevada | `#2a2a30` | `#f3f3f6` |
| Borde | `#34343a` | `#e1e1e6` |
| Texto 1 | `#f0f0f2` | `#1a1a1e` |
| Texto 2 | `#c8ccd4` | `#3e3e41` |
| Texto 3 | `#9a9aa6` | `#6b6b70` |
| Acción principal | fondo `#f0f0f2`, texto `#141417` | fondo `#1a1a1e`, texto `#ffffff` |
| **Rojo (único color)** | `#F0766B` | `#C23B30` |

- El rojo significa alarma: gasto, alerta, vencido, error. Nunca decoración.
- Ingreso = texto 1 con signo "+" y peso 700. Sin verde.
- Categorías y series de gráficos: rampa de grises; el ícono o la etiqueta distingue, no el color.
- Contrastes verificados ≥ AA (texto 3 sobre fondo 6.6:1; rojo sobre fondo 6.6:1; botón 16:1).

Tokens Tailwind: `slate-950…50` = rampa de neutros; `primary` = grises claros para la acción principal (`primary-600` botón, `primary-700` pulsado); `income`, `expense`/`danger`, `transfer`.

## Tipografía

**Comfortaa** 400–700 (la misma de Norte), una sola familia. Cuerpo ≥ 16px. Cifras con `font-variant-numeric: tabular-nums`; montos en peso 700.

## Orb (estado del asistente)

Esfera plata/grafito/perla, sin color. Cada estado se distingue por luminancia y halo, **también sin animación** (David tiene `prefers-reduced-motion`):

| Estado | Lectura |
|---|---|
| Reposo | grafito-plata suave, halo mínimo |
| Escuchando | más claro + halo doble visible |
| Pensando | gris medio plano, pulso lento |
| Hablando | núcleo claro con brillo difuso que respira |

## Componentes

- Radios: 12px tarjetas e inputs; píldora para chips y botones circulares.
- Bordes de 1px `#34343a`; sin sombras decorativas, sin gradientes en superficies, sin vidrio.
- Superficies planas: tarjeta = `#1f1f23` + borde.
