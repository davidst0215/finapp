import { useId, useMemo, useRef, useState } from 'react';
import { CalendarDays } from 'lucide-react';
import { Calendar } from '@/components/ui/Calendar';
import { localDateKey, toLocalDate } from '@/lib/utils';
import { Chip } from './Chip';
import { PriorityBars } from './PriorityBars';
import { Sheet } from './Sheet';
import { addDaysISO, formatShortDate, sectionize } from './format';
import { readStorage, writeStorage } from './storage';
import type { ActionResult } from './useTasks';
import type { CreateTaskInput, Destination, Level, Priority } from './types';

const LAST_DESTINATION_KEY = 'wabid-tareas-destino';

const LEVELS: readonly { id: string; level: Level | undefined; priority: Priority; label: string }[] = [
  { id: 'sin', level: undefined, priority: 0, label: 'Sin' },
  { id: 'bajo', level: 'bajo', priority: 1, label: 'Baja' },
  { id: 'medio', level: 'medio', priority: 2, label: 'Media' },
  { id: 'alto', level: 'alto', priority: 3, label: 'Alta' },
];

/** Último destino usado si sigue existiendo; si no, el cajón desastre. */
function initialFolder(destinations: readonly Destination[]): string {
  const saved = readStorage(LAST_DESTINATION_KEY);
  if (saved && destinations.some((d) => d.folder === saved)) return saved;
  return destinations.find((d) => d.scope === 'cajon')?.folder ?? destinations[0]?.folder ?? '';
}

interface AddTaskSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  destinations: readonly Destination[];
  /** Fecha de hoy en Lima (AAAA-MM-DD) tal como la manda el servidor. */
  hoy: string;
  onCreate: (input: CreateTaskInput, destinationLabel: string) => Promise<ActionResult>;
}

/** Hoja "Agregar tarea". Se monta solo mientras está abierta: cada apertura empieza con el formulario limpio. */
export function AddTaskSheet({ open, ...rest }: AddTaskSheetProps) {
  return open ? <AddTaskDialog {...rest} /> : null;
}

const labelClass = 'mb-1.5 block text-[13px] font-semibold text-slate-400';

function AddTaskDialog({ onOpenChange, destinations, hoy, onCreate }: Omit<AddTaskSheetProps, 'open'>) {
  const textRef = useRef<HTMLInputElement>(null);
  const ids = { text: useId(), folder: useId(), priority: useId() };

  const [text, setText] = useState('');
  const [folder, setFolder] = useState(() => initialFolder(destinations));
  const [levelId, setLevelId] = useState('sin');
  const [due, setDue] = useState<string | null>(null);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sections = useMemo(() => sectionize(destinations), [destinations]);
  const tomorrow = addDaysISO(hoy, 1);
  const customDate = due !== null && due !== hoy && due !== tomorrow;
  const canSubmit = text.trim().length > 0 && !pending;

  const submit = async () => {
    if (!canSubmit) return;
    const level = LEVELS.find((l) => l.id === levelId)?.level;
    const input: CreateTaskInput = {
      text: text.trim(),
      ...(folder ? { folder } : {}),
      ...(level ? { level } : {}),
      ...(due ? { due } : {}),
    };
    setPending(true);
    setError(null);
    const label = destinations.find((d) => d.folder === folder)?.label ?? 'el cajón';
    const result = await onCreate(input, label);
    if (result.ok) {
      if (folder) writeStorage(LAST_DESTINATION_KEY, folder);
      onOpenChange(false);
    } else {
      setError(result.message);
      setPending(false);
    }
  };

  const pickDate = (value: string | null) => {
    setDue(value);
    setCalendarOpen(false);
  };

  return (
    <Sheet
      open
      onOpenChange={onOpenChange}
      title="Agregar tarea"
      description="Escribe la tarea, elige dónde va y, si quieres, prioridad y fecha."
      hideDescription
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        textRef.current?.focus();
      }}
      footer={
        <>
          <div aria-live="polite">
            {error && (
              <p role="alert" className="mb-2 break-words text-[14px] leading-snug text-expense">
                {error}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!canSubmit}
            className="btn-primary min-h-12 w-full text-[16px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900"
          >
            {pending ? 'Agregando…' : 'Agregar'}
          </button>
        </>
      }
    >
      <div className="space-y-5">
        {/* El <form> envuelve solo el campo de texto: así Enter envía y el teclado del móvil muestra "Listo",
            sin que los botones internos del calendario (sin type) disparen un envío. */}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label htmlFor={ids.text} className={labelClass}>
            Tarea
          </label>
          <input
            ref={textRef}
            id={ids.text}
            type="text"
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="¿Qué hay que hacer?"
            enterKeyHint="done"
            autoComplete="off"
            className="input text-base"
          />
        </form>

        <div>
          <label htmlFor={ids.folder} className={labelClass}>
            Destino
          </label>
          <select
            id={ids.folder}
            value={folder}
            onChange={(event) => setFolder(event.target.value)}
            className="input text-base"
          >
            {sections.map((section) =>
              section.flat ? (
                section.items.map((d) => (
                  <option key={d.folder} value={d.folder}>
                    {d.label}
                  </option>
                ))
              ) : (
                <optgroup key={section.project} label={section.project}>
                  {section.items.map((d) => (
                    <option key={d.folder} value={d.folder}>
                      {d.label}
                    </option>
                  ))}
                </optgroup>
              ),
            )}
          </select>
        </div>

        <fieldset>
          <legend className={labelClass}>Prioridad</legend>
          <div className="grid grid-cols-4 gap-2">
            {LEVELS.map((l) => (
              <label key={l.id} className="relative block">
                <input
                  type="radio"
                  name={ids.priority}
                  value={l.id}
                  checked={levelId === l.id}
                  onChange={() => setLevelId(l.id)}
                  className="peer sr-only"
                />
                <span className="flex min-h-11 items-center justify-center gap-1.5 rounded-xl border border-slate-700 bg-slate-800 px-1 text-[14px] font-semibold text-slate-200 transition-colors hover:border-slate-500 peer-checked:border-primary-600 peer-checked:bg-primary-600 peer-checked:text-slate-950 peer-focus-visible:ring-2 peer-focus-visible:ring-slate-300">
                  {l.priority > 0 && <PriorityBars priority={l.priority} variant="inline" />}
                  {l.label}
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend className={labelClass}>Fecha</legend>
          <div className="flex flex-wrap gap-x-2 gap-y-3">
            <Chip on={due === null} aria-pressed={due === null} onClick={() => pickDate(null)}>
              Sin fecha
            </Chip>
            <Chip on={due === hoy} aria-pressed={due === hoy} onClick={() => pickDate(hoy)}>
              Hoy
            </Chip>
            <Chip on={due === tomorrow} aria-pressed={due === tomorrow} onClick={() => pickDate(tomorrow)}>
              Mañana
            </Chip>
            <Chip
              on={customDate || calendarOpen}
              aria-expanded={calendarOpen}
              icon={<CalendarDays aria-hidden="true" size={15} />}
              onClick={() => setCalendarOpen((v) => !v)}
            >
              {customDate && due ? formatShortDate(due) : 'Elegir…'}
            </Chip>
          </div>
          {calendarOpen && (
            // Los botones del Calendar compartido miden 32–40 px: aquí se llevan a 44 px sin tocar el componente.
            <div className="mt-3 rounded-xl border border-slate-700 p-3 [&_button]:min-h-11 [&_button]:min-w-11">
              <Calendar selected={due ? toLocalDate(due) : null} onSelect={(date) => pickDate(localDateKey(date))} />
            </div>
          )}
        </fieldset>
      </div>
    </Sheet>
  );
}
