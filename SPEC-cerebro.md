# Spec: Cerebro de caja de Wabid

Estado: APROBADO por David el 2026-10-24 («me gusta, vamos a reflejar esto en Wabid»). Primera entrega: migración 023, `_shared/caja.ts`, herramienta `cuanto_puedo_gastar`, restante de bolsa al anotar un gasto, `pay_recurring` con pagos de una vez y fin de mes, y la carga inicial. Pendientes: tarjeta en la web y línea del brief.

Cambios al construir: las bolsas viven en una tabla propia `bolsas` (no en `budgets`: la bolsa «compras y otros» es «todo lo que no es comida ni gasolina», no una categoría) y pueden programar un tope nuevo desde una fecha. Gasolina es la categoría Transporte, que es como David ya la registra. El gasto de las bolsas se reserva parejo cada día en la proyección. Prototipo de referencia: `Documents/Wabid/cierre-2026.html` (motor probado) y los datos de David en `Documents/Wabid/cierre-2026-v2.json`.

## Objetivo

Que Wabid sepa siempre **qué hay que pagar** y **cuánto puede gastar David**, con cifras calculadas por código (no estimadas por el modelo). Preguntas que tiene que contestar por voz o texto:

- «¿Qué me toca pagar?» → lo vencido primero, después lo de los próximos 7 días, con montos.
- «¿Cuánto puedo gastar?» → lo libre de hoy y lo que queda de cada tope semanal.
- «¿Me alcanza hasta el 15?» / «¿Cómo cierro el año?» → caja proyectada a una fecha, su punto más bajo y cuándo.
- «Pagué el teléfono» / «Me pagaron el bono» → registra el movimiento, mueve el saldo de la cuenta y recalcula.

Éxito: David deja de usar el HTML local; todo lo que hoy anota ahí vive en Wabid y la respuesta a «¿cuánto puedo gastar?» coincide al céntimo con el motor probado.

## Decisiones de David (24-oct)

1. Interbank (S/ 400) pasa a la quincena de noviembre (15-nov).
2. El sueldo cae siempre el último día del mes.
3. El teléfono vencido (22-oct, S/ 50) es la prueba de punta a punta: David lo registra desde la app.
4. Comida: gasto del día a día con **tope semanal**; el monto cambia de un mes a otro.
5. Gasolina: no es diaria (recarga cuando toca); también va con **tope semanal**.
6. La subvención pasa a fin de mes (día 31), después del sueldo.
8. **Deudas reordenadas (24-oct):**
   - Melissa, S/ 1,000, el 1-nov: tiene prioridad.
   - Hugo en tres partes: S/ 1,016 el 1-nov, S/ 1,150 el 15-nov y S/ 300 el 30-nov.
   - Yape (2-nov) e Interbank (15-nov) no se mueven.
   - Compras baja de S/ 100 a S/ 70 por semana desde el 16-nov para cerrar en S/ 10,526.
   - Caja más baja: S/ 26 el 14-nov y S/ 98 el 29-nov.
   - Hasta el 30-oct, antes del sueldo, el gasto variable total no pasa de S/ 214.
   - La caja real de partida es S/ 470, en la Tarjeta débito.
7. **Meta de ahorro: S/ 10,500 en caja al 31-dic.** Wabid siempre dice cuánto presupuesto semanal hay para las tres bolsas sin romper la caja ningún día y sin bajar de la meta al cierre.

## Mapa de módulos

| Id | Qué hace | Depende de |
|---|---|---|
| `pagos-programados` | Pagos y cobros de una sola vez (deudas, bono, CTS, gratificación, cobros) junto a los recurrentes; categoría Deudas | — |
| `topes-semanales` | Presupuesto semanal por categoría (comida, gasolina): cuánto queda esta semana | — |
| `motor-caja` | Proyección diaria determinista: caja, compromisos y topes → serie, mínimo, libre de hoy, cierre a una fecha | los dos anteriores |
| `cerebro-voz` | Herramientas del agente y línea del brief que usan el motor | `motor-caja` |
| `carga-inicial` | Cargar el JSON de David en Wabid (cuentas, pagos, topes, lo de octubre ya pagado) | `pagos-programados`, `topes-semanales` |

Orden: `pagos-programados` + `topes-semanales` → `motor-caja` → `carga-inicial` → `cerebro-voz`. Una rama y un PR por módulo.

## Diseño

### pagos-programados
- `recurring_transactions.frequency` acepta `'once'` (migración 023: se reemplaza el CHECK por uno más amplio; aditiva, no toca filas).
- Un `once` lleva `next_due_date` = su fecha. Al pagarse (`pay_recurring`), se registra la transacción y queda `is_active = false`, en vez de avanzar la fecha (`nextDueDate`, `finanzas.ts:186`).
- Los ingresos programados (`transaction_type = 'income'`) usan la misma tabla. Al registrarlos, la respuesta dice «cobrado», no «pagado».
- `list_recurring` separa **por pagar** de **por cobrar**; lo vencido va primero.
- Los avisos de «mañana vence» (017) ya cubren `once`. Hay que verificar con un test que el `CASE` de la línea 191 no lo trate como semanal.
- Categorías del sistema nuevas: **Deudas**, **Gasolina**, **Impuestos** (INSERT en la migración 023).

### topes-semanales (tres bolsas)
- Gasto variable en **tres bolsas** (decisión de David, 24-oct):
  - **Comida:** categoría Alimentación.
  - **Gasolina:** categoría nueva Gasolina.
  - **Compras y otros:** todo otro gasto variable (Compras, Ropa, Entretenimiento, Tecnología, Otros gastos…).
- Un gasto que paga un pago programado (`recurring_id` no nulo) **no** descuenta de ninguna bolsa, aunque su categoría sea Alimentación. Así, la subvención no se come la bolsa de comida.
- **El tope semanal total lo calcula el motor; no se fija a mano.**
  - Es el gasto variable más parejo posible que cumple dos condiciones: la caja no baja del colchón ningún día y llega a la meta al cierre.
  - Cada semana (lunes a domingo, hora de Lima) se reserva completa su primer día. Así el tope aguanta aunque se gaste entero el lunes.
  - Se recalcula cada lunes y cada vez que cambian los datos: si una semana se gasta de más, las siguientes se achican; si entra un ingreso extra, crecen.
- **Topes de David (24-oct):** comida S/ 200 por semana, compras S/ 100 por semana y gasolina S/ 350 al mes (unos S/ 81 por semana, con arrastre dentro del mes). El gasto de hoy y mañana (24 y 25-oct) cuenta dentro de la semana del 26-oct al 1-nov.
- **Lo que no entra en las bolsas queda en caja** como libre para cualquier otro gasto: la caja al cierre menos la meta.
- El motor valida los topes contra la capacidad calculada. Si algún día la caja queda en negativo, Wabid dice cuándo, cuánto falta y qué pago conviene mover (por ejemplo, «pasa S/ 450 de Hugo al 15-nov»).
- **Meta:** se guarda en `savings_goals` (`target_amount` 10,500, `target_date` 2026-12-31) con una marca de «meta de caja», que el motor usa como condición al cierre.
- Se reutiliza `budgets` con `period_type = 'weekly'`, que ya existe en el esquema, para el reparto. `fn_get_budget_status` suma también los semanales: gastado desde el lunes y lo que queda.
- `create_budget` acepta «semanal» y porcentajes («la gasolina, 100 fijos a la semana»).

### motor-caja (`supabase/functions/_shared/caja.ts`)
Es el motor del HTML pasado a TypeScript puro: sin red ni base, en céntimos enteros, con invariantes.

- **Entrada:** caja de hoy (suma de saldos de las cuentas, con los dólares pasados a soles vía `fx_rates`), recurrentes activos (mensuales y `once`), topes semanales con lo gastado esta semana, la fecha de hoy en Lima y el horizonte.
- **Reglas:**
  - Lo vencido y sin pagar cuenta como de hoy.
  - De cada tope se reserva lo que queda esta semana (hoy) y el tope completo cada lunes siguiente.
  - Un mes sin el día pedido toma su último día: el 31 cae el 30 de noviembre.
- **Salida:** serie diaria, mínimo y su fecha, lista de lo que viene con la caja después de cada movimiento, totales por mes y **libre de hoy**.
- **Libre de hoy** = (menor caja proyectada desde hoy hasta el horizonte) − colchón, con piso en 0. Es lo máximo que David puede gastar hoy, fuera de sus topes, sin que la caja baje del colchón ningún día del horizonte.
- **Horizonte:** 60 días para «libre de hoy»; la fecha que se pregunte para «¿cómo cierro el año?» o «¿me alcanza hasta…?».
- **Capacidad del tramo** («¿cuánto puedo gastar hasta fin de mes / hasta el sueldo?»). Un tramo va hasta el próximo ingreso. La capacidad es el mayor gasto parejo por día que no deja la caja bajo el colchón ningún día del horizonte, contando lo ya gastado en los tramos anteriores: `d = min_t (caja_sin_variables(t) − gastado − colchón) / días(t)`. Se reparte en las tres bolsas; si los topes piden más que la capacidad, la respuesta lo dice con la diferencia. Con los datos de David (24-oct, subvención de octubre movida al 31), la caja del 25 al 30 de octubre deja S/ 214 (unos S/ 36 por día), del 1 al 14 de noviembre S/ 32 por día (lo limita el 14-nov, antes de la CTS) y desde el 15 de noviembre S/ 132 por día.
- **Invariantes** (si alguna falla, la respuesta dice que no confía en la cifra): la caja final es igual a la inicial más todo lo pendiente; el libro y la serie cierran igual; la suma de los meses es igual a la variación.

### cerebro-voz
- **Herramienta nueva `cuanto_puedo_gastar`**, con periodo opcional: hoy, esta semana, hasta fin de mes o hasta una fecha. Ejemplo de voz: «Hasta el sueldo tienes S/ 214: comida S/ 120, gasolina S/ 60 y para compras S/ 34. Ojo, del 1 al 14 de noviembre baja a S/ 32 por día.» El detalle por bolsa y lo próximo van en pantalla. Si el tramo está en negativo, lo primero que dice es cuánto falta y qué pago lo causa.
- **`analyze_finances` con `projection`** recibe en su contexto las cifras del motor (cierre, mínimo y fecha, libre) y deja de estimar.
- **Brief de las 7:00:** suma «Hoy puedes gastar S/ X» y lo que vence hoy. Lo despliega David con `--no-verify-jwt`.
- Todo respeta las reglas de voz vigentes (#44): 2 o 3 frases, máximo 3 montos.

### carga-inicial (`scripts/cargar-cierre.mjs`)
- Lee `cierre-2026-v2.json` y genera **un archivo SQL para revisar antes de aplicarlo**. Se aplica con la API de administración, como las migraciones.
- **Mensuales:** `monthly` con su día. Si octubre está marcado como pagado, `next_due_date` cae en noviembre. El teléfono queda con `2026-10-22`: vencido, para la prueba.
- **Únicos:** `once` (Hugo, Interbank 15-nov, Yape, bono, CTS, gratificación y los dos cobros).
- **Sueldo:** `monthly`, día 31, ingreso.
- **CTS y gratificación:** van como montos fijos (2,625 y 4,905) en esta versión.
- **Topes:** los que defina David (pregunta abierta 2).
- **Repetible:** cada fila lleva `notes = 'cierre-2026'`; correrlo dos veces no duplica nada.

## Comandos

```bash
# Tests de funciones (73 archivos hoy; todos, también brief y vault)
node --experimental-strip-types --test $(find supabase/functions -name "*.test.ts" -not -path "*/node_modules/*")
# Tipos (en una COPIA con deno.json {"nodeModulesDir":"auto"})
npx -y deno check agent/index.ts
# Web
pnpm --filter @finapp/web build
# Despliegue de funciones (agent; brief lo corre David con --no-verify-jwt)
npx -y supabase@latest functions deploy agent --project-ref rrhyyclltgaecfyertqh --use-api
# Migración y carga: POST /v1/projects/rrhyyclltgaecfyertqh/database/query (Management API), con check-023.mjs en PGlite antes
```

## Estructura

```
supabase/migrations/023_cerebro_caja.sql      'once' + categorías + presupuestos semanales en fn_get_budget_status
supabase/migrations/check-023.mjs             prueba de la migración en PGlite (como check-016…021)
supabase/functions/_shared/caja.ts            motor-caja
supabase/functions/_shared/caja.test.ts       incluye el caso de paridad con el HTML y los datos de David
supabase/functions/agent/tools/finanzas.ts    once en pay/list/create_recurring, topes, cuanto_puedo_gastar
supabase/functions/brief/logic.ts             línea «puedes gastar»
scripts/cargar-cierre.mjs                     carga inicial → SQL para revisar
apps/web/src/routes/Dashboard.tsx             tarjeta «Puedes gastar hoy» + próximos pagos (pasa por skill de diseño)
```

## Estilo

El del repositorio: TypeScript sin dependencias nuevas, comentarios en español que dicen el porqué, montos en céntimos dentro del motor y `S/ 45.90` en el texto. Ejemplo del contrato del motor:

```ts
export type Compromiso = { key: string; fecha: string; monto: number /* céntimos, + entra − sale */; concepto: string; origen: "recurrente" | "once" | "tope" };
export function simularCaja(e: EntradaCaja): ResultadoCaja; // pura: misma entrada → misma salida
```

## Pruebas

- **`caja.test.ts`:**
  - Paridad con el HTML: con `cierre-2026-v2.json`, la caja del 31-dic, el mínimo y su fecha salen iguales al motor del prototipo.
  - Libre de hoy con y sin topes.
  - Vencido contado como hoy.
  - Día 31 en noviembre.
  - Reinicio del tope el lunes en hora de Lima.
- **`finanzas.test.ts`:** `once` se paga y queda inactivo; un ingreso se registra como «cobrado»; `list_recurring` pone lo vencido primero; la voz de `cuanto_puedo_gastar` queda dentro del tope y con máximo 3 montos.
- **`check-023.mjs`:** el CHECK nuevo acepta `once` y rechaza valores inventados; las categorías se crean una sola vez; el estado de los presupuestos semanales cuenta solo desde el lunes.
- **Prueba de punta a punta en producción:** el teléfono vencido (criterio 2).

## Límites

- **Siempre:**
  - Tests en verde y `deno check` antes de cada PR.
  - Una rama y un PR por módulo.
  - Cifras solo del motor.
  - Fechas en hora de Lima.
  - Dólares convertidos con `fx_rates`.
- **Preguntar antes:**
  - Aplicar la migración 023.
  - Aplicar el SQL de la carga en producción (David lo lee primero).
  - Cualquier cambio de la tarjeta de la web (pasa por la skill de diseño).
  - Desplegar `brief` (lo corre David).
- **Nunca:**
  - Inventar montos o fechas.
  - Registrar un pago que David no pidió.
  - Borrar movimientos.
  - Mover dinero real.
  - Dar consejos de inversión.
  - Leer el almacenamiento del navegador.

## Criterios de éxito

1. «¿Qué me toca pagar?» dice primero el teléfono vencido (22-oct, S/ 50) y después lo de los próximos 7 días; coincide con la base.
2. «Pagué el teléfono» crea un egreso de S/ 50 en Servicios, baja S/ 50 el saldo de la cuenta, pasa la próxima fecha al 22-nov y deja 0 vencidos. El libre de hoy cambia en consecuencia.
3. «¿Cuánto puedo gastar?» devuelve lo mismo que `simularCaja` con los datos de la base (test con datos fijos y prueba en producción).
4. Interbank aparece el 15-nov; una vez pagado, queda inactivo y sale de la lista.
5. «Gasté 80 en comida» deja el tope de comida en (tope − 80) esa semana; el lunes vuelve al tope completo. Pagar la subvención (programada, Alimentación) no toca la bolsa de comida.
8. Con `cierre-2026-v3.json` y la meta de S/ 10,500, el motor da estos topes semanales para las tres bolsas: 25-oct S/ 25 · 26-oct S/ 185 · 2-nov y 9-nov S/ 225 · del 16-nov al 27-dic S/ 580 · 28-dic S/ 330, en total S/ 4,470. Gastándolos completos el lunes, la caja cierra en S/ 10,504 y su mínimo es S/ 4, el 30-oct. Es el test de paridad: los mismos números que el script del prototipo.
6. «¿Cómo cierro el año?» da la misma caja al 31-dic que el HTML con los mismos datos.
7. Suite completa en verde; `deno check` sin errores; voz ≤ 250 caracteres.

## Preguntas abiertas

1. **Cuentas:** ¿cuáles usas y cuánto hay en cada una? (Hoy suman S/ 470.) Wabid exige una cuenta para cada pago.
2. ~~Reparto de las tres bolsas~~: resuelto (comida 200 por semana, compras 100 por semana, gasolina 350 al mes). Pendiente: ¿Hugo acepta S/ 450 el 15-nov? Sin eso, del 2 al 14 de noviembre la caja queda en negativo con estos topes.
3. **Colchón:** ¿cuánto no quieres tocar nunca? Si no hay respuesta, va S/ 0.
4. **Deuda banco (S/ 920 al mes):** ¿hasta qué mes?
5. ~~Subvención del 30-oct~~: resuelto, pasa a fin de mes.
6. **CTS y gratificación:** ¿te sirven como montos fijos en esta versión, o el cálculo desde el sueldo bruto entra ya?
7. **La herramienta HTML:** ¿queda como borrador hasta que la tarjeta de Wabid esté en producción, y después se retira?
