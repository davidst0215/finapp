import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Check, ChevronDown, RotateCcw } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { PreparedImage } from './prepareImage.ts';
import { PhotoThumb } from './PhotoThumb';
import {
  centsToInputText,
  currencyName,
  currencySymbol,
  describeDate,
  expenseCategories,
  parseAmountToCents,
  type AccountLike,
  type CategoryLike,
  type Currency,
  type FormErrors,
  type FormField,
  type ReceiptFormValues,
} from './reciboLogic.ts';

interface Props {
  photo: PreparedImage;
  values: ReceiptFormValues;
  /** Solo los errores que ya toca mostrar. */
  errors: FormErrors;
  onChange: (patch: Partial<ReceiptFormValues>) => void;
  onSubmit: () => void;
  onRetake: () => void;
  categories: CategoryLike[];
  accounts: AccountLike[];
  /** AAAA-MM-DD de hoy en Lima: tope del selector de fecha. */
  today: string;
  saving: boolean;
  saveError: { message: string; detail: string | null } | null;
  summary: string;
  /** Lectura con poca confianza: pide comparar el total con la foto. */
  doubtful: boolean;
  /** La boleta no traía fecha y se puso hoy. */
  dateGuessed: boolean;
}

const CURRENCIES: Currency[] = ['PEN', 'USD'];
/** Lo que no puede ir en un monto: se descarta al teclear o pegar (queda dígitos, punto, coma y espacio). */
const NOT_AMOUNT_CHARS = /[^\d.,\s]/g;

function Field({
  label,
  htmlFor,
  error,
  hint,
  aside,
  children,
}: {
  label: string;
  htmlFor: string;
  error?: string;
  hint?: string | null;
  /** Texto que acompaña a la etiqueta, a la derecha. */
  aside?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <label htmlFor={htmlFor} className="text-[13px] font-semibold text-slate-400">
          {label}
        </label>
        {aside && <span className="text-[13px] tabular-nums text-slate-300">{aside}</span>}
      </div>
      {children}
      {error ? (
        <p id={`${htmlFor}-error`} role="alert" className="mt-1.5 text-sm text-expense">
          {error}
        </p>
      ) : hint ? (
        <p id={`${htmlFor}-hint`} className="mt-1.5 text-sm text-slate-400">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

function SelectShell({ children }: { children: ReactNode }) {
  return (
    <div className="relative">
      {children}
      <ChevronDown
        size={18}
        strokeWidth={1.8}
        aria-hidden="true"
        className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-slate-400"
      />
    </div>
  );
}

/** Revisión de lo leído: todo editable, con el monto como protagonista. */
export function ReceiptForm({
  photo,
  values,
  errors,
  onChange,
  onSubmit,
  onRetake,
  categories,
  accounts,
  today,
  saving,
  saveError,
  summary,
  doubtful,
  dateGuessed,
}: Props) {
  const uid = useId();
  const id = (name: string) => `${uid}-${name}`;
  const errorId = (name: string, field: FormField) => (errors[field] ? `${id(name)}-error` : undefined);
  const [photoOpen, setPhotoOpen] = useState(false);
  const actionsRef = useRef<HTMLDivElement>(null);

  // Si el registro falla, el mensaje empuja los botones hacia la barra de pestañas: se dejan a la vista.
  useEffect(() => {
    if (saveError) actionsRef.current?.scrollIntoView({ block: 'end' });
  }, [saveError]);

  const account = accounts.find((a) => a.account_id === values.accountId);
  const mismatch =
    account && account.currency_code !== values.currency
      ? `La boleta está en ${currencyName(values.currency)} y esta cuenta en ${currencyName(account.currency_code)}.`
      : null;

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit();
  };

  // Al salir del monto se muestra tal como se guardará: "86,4" -> "86.40". Sin mensajes: ver ReciboPage.
  const settleAmount = () => {
    const cents = parseAmountToCents(values.amountText);
    if (cents !== null && cents > 0) onChange({ amountText: centsToInputText(cents) });
  };

  return (
    <form onSubmit={handleSubmit} noValidate aria-labelledby={id('title')} className="space-y-4">
      <div className="card space-y-5">
        <div className="flex items-center gap-3.5">
          <PhotoThumb photo={photo} expanded={photoOpen} onToggle={() => setPhotoOpen((open) => !open)} />
          <div className="min-w-0 flex-1">
            <h2 id={id('title')} className="text-base font-semibold text-slate-100">
              Revisa los datos
            </h2>
            <p
              className={cn(
                'mt-0.5 flex items-start gap-1.5 text-[13px] leading-snug',
                doubtful ? 'text-slate-100' : 'text-slate-400',
              )}
            >
              {doubtful && <AlertTriangle size={14} strokeWidth={2} className="mt-0.5 shrink-0" aria-hidden="true" />}
              <span>{doubtful ? 'Lectura dudosa: compara el total con la foto.' : summary}</span>
            </p>
          </div>
        </div>

        {photoOpen && (
          <img
            src={photo.previewUrl}
            alt="Foto de la boleta"
            className="max-h-[60vh] w-full rounded-xl border border-slate-700 bg-slate-800 object-contain"
          />
        )}

        <Field label="Comercio" htmlFor={id('desc')}>
          <input
            id={id('desc')}
            type="text"
            className="input"
            value={values.description}
            maxLength={120}
            placeholder="Nombre del comercio"
            autoComplete="off"
            enterKeyHint="next"
            onChange={(e) => onChange({ description: e.target.value })}
          />
        </Field>

        <Field label="Monto" htmlFor={id('amount')} error={errors.amount}>
          <div className="flex items-stretch gap-2">
            <div
              className={cn(
                'input flex min-w-0 flex-1 items-center gap-2 py-0',
                'focus-within:border-primary-500 focus-within:ring-1 focus-within:ring-primary-500',
                errors.amount && 'border-expense focus-within:border-expense focus-within:ring-expense',
              )}
            >
              <span aria-hidden="true" className="text-lg font-bold text-expense">
                {currencySymbol(values.currency)}
              </span>
              <input
                id={id('amount')}
                type="text"
                inputMode="decimal"
                autoComplete="off"
                enterKeyHint="done"
                placeholder="0.00"
                value={values.amountText}
                aria-invalid={errors.amount ? true : undefined}
                aria-describedby={errorId('amount', 'amount')}
                className="min-w-0 flex-1 bg-transparent py-3 text-2xl font-bold tabular-nums text-expense outline-none placeholder-slate-400"
                onChange={(e) => onChange({ amountText: e.target.value.replace(NOT_AMOUNT_CHARS, '') })}
                onBlur={settleAmount}
              />
            </div>

            <fieldset className="flex shrink-0 rounded-xl border border-slate-700 bg-slate-800 p-1">
              <legend className="sr-only">Moneda</legend>
              {CURRENCIES.map((code) => (
                <label key={code} className="relative flex">
                  <input
                    type="radio"
                    name={id('currency')}
                    value={code}
                    checked={values.currency === code}
                    onChange={() => onChange({ currency: code })}
                    className="peer sr-only"
                  />
                  <span className="flex min-h-[44px] min-w-[46px] cursor-pointer items-center justify-center rounded-lg px-2.5 text-sm font-semibold text-slate-400 peer-checked:bg-primary-600 peer-checked:text-slate-950 peer-focus-visible:ring-2 peer-focus-visible:ring-primary-500">
                    {currencySymbol(code)}
                  </span>
                </label>
              ))}
            </fieldset>
          </div>
        </Field>

        <Field
          label="Fecha"
          htmlFor={id('date')}
          error={errors.date}
          aside={describeDate(values.date, today)}
          hint={dateGuessed ? 'No vi la fecha en la boleta, puse hoy.' : null}
        >
          <input
            id={id('date')}
            type="date"
            className="input min-h-[3rem] tabular-nums"
            value={values.date}
            max={today}
            aria-invalid={errors.date ? true : undefined}
            aria-describedby={errorId('date', 'date')}
            onChange={(e) => onChange({ date: e.target.value })}
          />
        </Field>

        <Field label="Categoría" htmlFor={id('category')}>
          <SelectShell>
            <select
              id={id('category')}
              className="input appearance-none pr-11"
              value={values.categoryId}
              onChange={(e) => onChange({ categoryId: e.target.value })}
            >
              <option value="">Sin categoría</option>
              {expenseCategories(categories).map((c) => (
                <option key={c.category_id} value={c.category_id}>
                  {c.category_name}
                </option>
              ))}
            </select>
          </SelectShell>
        </Field>

        {accounts.length === 0 ? (
          <div>
            <p className="mb-1.5 text-[13px] font-semibold text-slate-400">Cuenta</p>
            <p className="text-base leading-relaxed text-slate-300">
              No encontré cuentas. Crea una en Finanzas para poder registrar el gasto.
            </p>
            <Link to="/accounts" className="btn-secondary mt-3 inline-flex items-center justify-center">
              Ir a Cuentas
            </Link>
          </div>
        ) : (
          <Field label="Cuenta" htmlFor={id('account')} error={errors.account} hint={mismatch}>
            <SelectShell>
              <select
                id={id('account')}
                className="input appearance-none pr-11"
                value={values.accountId}
                aria-invalid={errors.account ? true : undefined}
                aria-describedby={errorId('account', 'account')}
                onChange={(e) => onChange({ accountId: e.target.value })}
              >
                {values.accountId === '' && <option value="">Elige una cuenta</option>}
                {accounts.map((a) => (
                  <option key={a.account_id} value={a.account_id}>
                    {a.account_name}
                    {a.currency_code !== 'PEN' ? ` · ${a.currency_code}` : ''}
                  </option>
                ))}
              </select>
            </SelectShell>
          </Field>
        )}
      </div>

      {saveError && (
        <div role="alert" className="space-y-1">
          <p className="text-base leading-relaxed text-expense">{saveError.message}</p>
          {saveError.detail && (
            <p className="break-words text-xs leading-relaxed text-slate-400">Detalle técnico: {saveError.detail}</p>
          )}
        </div>
      )}

      <div ref={actionsRef} className="flex scroll-mb-24 gap-3">
        <button
          type="button"
          onClick={onRetake}
          disabled={saving}
          className="btn-secondary flex flex-1 items-center justify-center gap-2 whitespace-nowrap disabled:opacity-50"
        >
          <RotateCcw size={17} strokeWidth={1.8} aria-hidden="true" />
          Volver a tomar
        </button>
        <button
          type="submit"
          disabled={saving || accounts.length === 0}
          className="btn-primary flex flex-1 items-center justify-center gap-2 whitespace-nowrap"
        >
          {saving ? (
            'Registrando…'
          ) : (
            <>
              <Check size={18} strokeWidth={2} aria-hidden="true" />
              Registrar
            </>
          )}
        </button>
      </div>
    </form>
  );
}
