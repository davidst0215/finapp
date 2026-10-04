import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { X } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { supabase } from '@/lib/supabase';
import type { Transaction } from '@/types/database';
import { CapturePanel } from '@/components/recibo/CapturePanel';
import { DonePanel } from '@/components/recibo/DonePanel';
import { ProblemPanel } from '@/components/recibo/ProblemPanel';
import { ReadingPanel } from '@/components/recibo/ReadingPanel';
import { ReceiptForm } from '@/components/recibo/ReceiptForm';
import { ImageTooLargeError, prepareReceiptImage, type PreparedImage } from '@/components/recibo/prepareImage';
import { readReceipt } from '@/components/recibo/readReceipt';
import {
  buildFormValues,
  dateToTimestamp,
  limaToday,
  needsDoubleCheck,
  pickAccountId,
  problemOf,
  readingSummary,
  validateForm,
  type FormErrors,
  type ReceiptFormValues,
  type ReceiptProblem,
  type ReceiptReading,
} from '@/components/recibo/reciboLogic';

/**
 * Foto de una boleta -> gasto registrado.
 * idle -> preparing (reducir la foto) -> reading (parse-receipt) -> review (editable) -> done.
 * Cualquier fallo de lectura pasa por `problem`, con salidas que sí sirven.
 */
type Flow =
  | { phase: 'idle' }
  | { phase: 'preparing' }
  | { phase: 'reading'; photo: PreparedImage; startedAt: number }
  | { phase: 'problem'; photo: PreparedImage | null; problem: ReceiptProblem }
  | { phase: 'review'; photo: PreparedImage; reading: ReceiptReading | null }
  | { phase: 'done'; tx: Transaction };

const ANNOUNCE: Record<Flow['phase'], string> = {
  idle: '',
  preparing: 'Preparando la foto.',
  reading: 'Leyendo la boleta.',
  problem: 'No se pudo leer la boleta.',
  review: 'Revisa los datos y registra el gasto.',
  done: 'Gasto registrado.',
};

const LOOKUPS_TIMEOUT_MS = 8000;

const EMPTY_FORM: ReceiptFormValues = {
  description: '',
  amountText: '',
  currency: 'PEN',
  date: '',
  categoryId: '',
  accountId: '',
};

// La última cuenta usada en una boleta: la siguiente arranca ahí.
const ACCOUNT_KEY = 'wabid_recibo_cuenta';
const loadPreferredAccount = (): string | null => {
  try {
    return localStorage.getItem(ACCOUNT_KEY);
  } catch {
    return null;
  }
};
const savePreferredAccount = (accountId: string) => {
  try {
    localStorage.setItem(ACCOUNT_KEY, accountId);
  } catch {
    /* sin almacenamiento disponible: la preferencia es solo una comodidad */
  }
};

/** Lee de vuelta un gasto ya guardado (con categoría y cuenta, como lo devuelve addTransaction). */
async function fetchSaved(id: string): Promise<Transaction | null> {
  try {
    const { data } = await supabase
      .from('transactions')
      .select('*, category:categories(*), account:accounts!transactions_account_id_fkey(*)')
      .eq('transaction_id', id)
      .single();
    return (data as Transaction | null) ?? null;
  } catch {
    return null;
  }
}

export function ReciboPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const accounts = useAppStore((s) => s.accounts);
  const categories = useAppStore((s) => s.categories);

  const [flow, setFlow] = useState<Flow>({ phase: 'idle' });
  const [form, setForm] = useState<ReceiptFormValues>(EMPTY_FORM);
  const [attempted, setAttempted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<{ message: string; detail: string | null } | null>(null);

  const runRef = useRef(0); // corrida vigente: el resultado de una anterior se descarta
  const abortRef = useRef<AbortController | null>(null);
  const txIdRef = useRef('');
  const savingRef = useRef(false); // evita el doble toque antes de que React repinte
  const lookupsRef = useRef<Promise<unknown>>(Promise.resolve());
  const cameraRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const shownPhase = useRef<Flow['phase']>('idle');

  // Cuentas y categorías: se piden al entrar si aún no están (la ruta puede abrirse directo).
  useEffect(() => {
    const store = useAppStore.getState();
    // Nunca rechaza: si fallan, el formulario avisa que no hay cuentas en vez de quedarse esperando.
    const lookups = Promise.all([
      store.accounts.length ? null : store.fetchAccounts(),
      store.categories.length ? null : store.fetchCategories(),
    ]).catch(() => undefined);
    // Tope de 8 s: si Supabase no contesta, el formulario sale igual (avisa que faltan cuentas).
    lookupsRef.current = Promise.race([lookups, new Promise((resolve) => setTimeout(resolve, LOOKUPS_TIMEOUT_MS))]);
    return () => {
      runRef.current += 1;
      abortRef.current?.abort();
    };
  }, []);

  // Al cambiar de etapa: arriba de la página y el foco en el panel nuevo (lectores de pantalla y teclado).
  useEffect(() => {
    if (shownPhase.current === flow.phase) return;
    shownPhase.current = flow.phase;
    window.scrollTo(0, 0);
    panelRef.current?.focus({ preventScroll: true });
  }, [flow.phase]);

  const cancelRun = () => {
    runRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
  };

  const openReview = (photo: PreparedImage, reading: ReceiptReading | null) => {
    const { accounts: accs, categories: cats } = useAppStore.getState();
    setForm(
      buildFormValues(reading, {
        today: limaToday(Date.now()),
        categories: cats,
        accounts: accs,
        preferredAccountId: loadPreferredAccount(),
      }),
    );
    setAttempted(false);
    setSaveError(null);
    txIdRef.current = crypto.randomUUID(); // mismo id en cada reintento: una respuesta perdida no duplica el gasto
    setFlow({ phase: 'review', photo, reading });
  };

  const readPhoto = async (photo: PreparedImage, run: number) => {
    const controller = new AbortController();
    abortRef.current = controller;
    setFlow({ phase: 'reading', photo, startedAt: Date.now() });

    const outcome = await readReceipt(photo.base64, controller.signal);
    if (run !== runRef.current) return;
    if (!outcome.ok) {
      setFlow({ phase: 'problem', photo, problem: outcome.problem });
      return;
    }
    await lookupsRef.current; // el formulario necesita cuentas y categorías ya cargadas
    if (run !== runRef.current) return;
    openReview(photo, outcome.reading);
  };

  const handleFile = async (file: File) => {
    cancelRun();
    const run = runRef.current;
    setFlow({ phase: 'preparing' });
    let photo: PreparedImage;
    try {
      photo = await prepareReceiptImage(file);
    } catch (e) {
      const kind = e instanceof ImageTooLargeError ? 'too-large' : 'image';
      if (run === runRef.current) setFlow({ phase: 'problem', photo: null, problem: problemOf(kind) });
      return;
    }
    if (run !== runRef.current) return;
    await readPhoto(photo, run);
  };

  const onPick = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // permite volver a elegir la misma foto
    if (file) void handleFile(file);
  };

  const startOver = (openCamera: boolean) => {
    cancelRun();
    setFlow({ phase: 'idle' });
    if (openCamera) cameraRef.current?.click();
  };

  const retry = (photo: PreparedImage) => {
    cancelRun();
    void readPhoto(photo, runRef.current);
  };

  const writeByHand = async (photo: PreparedImage) => {
    cancelRun();
    const run = runRef.current;
    await lookupsRef.current;
    if (run === runRef.current) openReview(photo, null);
  };

  const close = () => {
    cancelRun();
    // 'default' = la ruta se abrió directo, sin pantalla anterior a la que volver.
    if (location.key === 'default') navigate('/');
    else navigate(-1);
  };

  const register = async () => {
    if (flow.phase !== 'review' || savingRef.current) return;
    const now = Date.now();
    const checked = validateForm(form, { today: limaToday(now), accounts });
    if (!checked.ok) {
      setAttempted(true);
      requestAnimationFrame(() => document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
      return;
    }

    const v = checked.value;
    savingRef.current = true;
    setSaving(true);
    setSaveError(null);
    let tx: Transaction | null = null;
    try {
      // Mismo camino que el resto de la app. El esquema solo admite input_method manual|voice|recurring|import:
      // la boleta entra como 'manual' (David confirma cada dato) y se marca con la etiqueta 'boleta'.
      tx = await useAppStore.getState().addTransaction({
        transaction_id: txIdRef.current,
        transaction_type: 'expense',
        amount: v.amountCents / 100,
        currency_code: v.currency,
        description: v.description,
        notes: null,
        account_id: v.accountId,
        category_id: v.categoryId,
        transaction_date: dateToTimestamp(v.date, now),
        transfer_to_account_id: null,
        input_method: 'manual',
        raw_voice_text: null,
        is_recurring: false,
        recurring_id: null,
        tags: ['boleta'],
      });
    } catch {
      tx = null;
    }
    savingRef.current = false;
    setSaving(false);

    if (!tx && /duplicate key|23505/i.test(useAppStore.getState().error ?? '')) {
      // Un intento anterior sí llegó a guardarse (se perdió la respuesta): es el mismo gasto, no un error.
      tx = await fetchSaved(txIdRef.current);
      if (tx) useAppStore.getState().clearError();
    }

    if (!tx) {
      const detail = useAppStore.getState().error;
      useAppStore.getState().clearError(); // el mensaje de abajo reemplaza al aviso global
      setSaveError({
        message: 'No pude registrar el gasto. Tus datos siguen aquí: revisa tu conexión e inténtalo de nuevo.',
        detail,
      });
      return;
    }
    savePreferredAccount(v.accountId);
    setFlow({ phase: 'done', tx });
  };

  const problemPhoto = flow.phase === 'problem' ? flow.photo : null;

  // Los errores aparecen recién al intentar registrar (después, se corrigen en vivo). No al salir de un
  // campo: el mensaje movería los botones entre el toque y el soltar, y el toque en "Registrar" se perdería.
  const today = limaToday(Date.now());
  let shownErrors: FormErrors = {};
  if (flow.phase === 'review' && attempted) {
    const checked = validateForm(form, { today, accounts });
    if (!checked.ok) shownErrors = checked.errors;
  }

  return (
    <div className="space-y-5">
      <header className="flex items-center justify-between">
        <button
          type="button"
          onClick={close}
          aria-label="Cerrar"
          className="flex h-11 w-11 items-center justify-center rounded-full border border-slate-700 bg-slate-800 text-slate-200 transition-colors active:bg-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
        >
          <X size={19} strokeWidth={1.7} aria-hidden="true" />
        </button>
        <h1 className="text-xl font-bold">Leer recibo</h1>
        <span aria-hidden="true" className="h-11 w-11" />
      </header>

      <p role="status" aria-live="polite" className="sr-only">
        {ANNOUNCE[flow.phase]}
      </p>

      <div ref={panelRef} tabIndex={-1} className="outline-none">
        {flow.phase === 'idle' && (
          <CapturePanel onTakePhoto={() => cameraRef.current?.click()} onPickFile={() => galleryRef.current?.click()} />
        )}

        {flow.phase === 'preparing' && (
          <ReadingPanel stage="preparing" photo={null} startedAt={null} onCancel={() => startOver(false)} />
        )}

        {flow.phase === 'reading' && (
          <ReadingPanel stage="reading" photo={flow.photo} startedAt={flow.startedAt} onCancel={() => startOver(false)} />
        )}

        {flow.phase === 'problem' && (
          <ProblemPanel
            problem={flow.problem}
            photo={flow.photo}
            onTakeAnother={() => startOver(true)}
            onRetry={flow.problem.canRetry && problemPhoto ? () => retry(problemPhoto) : undefined}
            onWriteByHand={flow.problem.canWriteByHand && problemPhoto ? () => void writeByHand(problemPhoto) : undefined}
          />
        )}

        {flow.phase === 'review' && (
          <ReceiptForm
            photo={flow.photo}
            values={form}
            errors={shownErrors}
            onChange={(patch) =>
              setForm((current) => {
                const next = { ...current, ...patch };
                // Cambiar la moneda busca una cuenta de esa moneda (conserva la actual si ya calza).
                if (patch.currency && patch.currency !== current.currency) {
                  next.accountId = pickAccountId(accounts, patch.currency, current.accountId);
                }
                return next;
              })
            }
            onSubmit={() => void register()}
            onRetake={() => startOver(true)}
            categories={categories}
            accounts={accounts}
            today={today}
            saving={saving}
            saveError={saveError}
            summary={readingSummary(flow.reading)}
            doubtful={flow.reading !== null && needsDoubleCheck(flow.reading)}
            dateGuessed={flow.reading !== null && flow.reading.date === null}
          />
        )}

        {flow.phase === 'done' && (
          <DonePanel tx={flow.tx} onAnother={() => startOver(true)} onViewList={() => navigate('/transactions')} />
        )}
      </div>

      <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={onPick} />
      <input ref={galleryRef} type="file" accept="image/*" className="hidden" onChange={onPick} />
    </div>
  );
}
