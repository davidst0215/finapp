import { useState, useMemo } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

interface CalendarProps {
  selected?: Date | null;
  rangeStart?: Date | null;
  rangeEnd?: Date | null;
  onSelect?: (date: Date) => void;
  markers?: Record<string, { color: string; count: number }>;
  className?: string;
}

const DAYS = ['Lu', 'Ma', 'Mi', 'Ju', 'Vi', 'Sa', 'Do'];
const MONTHS = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
];

function toKey(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function sameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function inRange(date: Date, start: Date | null | undefined, end: Date | null | undefined) {
  if (!start || !end) return false;
  const t = date.getTime();
  return t >= start.getTime() && t <= end.getTime();
}

export function Calendar({ selected, rangeStart, rangeEnd, onSelect, markers, className }: CalendarProps) {
  const [viewDate, setViewDate] = useState(() => selected ?? new Date());

  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();

  const days = useMemo(() => {
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);

    // Monday-based week (0=Mon, 6=Sun)
    let startDow = firstDay.getDay() - 1;
    if (startDow < 0) startDow = 6;

    const cells: (Date | null)[] = [];
    for (let i = 0; i < startDow; i++) cells.push(null);
    for (let d = 1; d <= lastDay.getDate(); d++) cells.push(new Date(year, month, d));
    // Pad to full rows
    while (cells.length % 7 !== 0) cells.push(null);
    return cells;
  }, [year, month]);

  const today = new Date();

  const prev = () => setViewDate(new Date(year, month - 1, 1));
  const next = () => setViewDate(new Date(year, month + 1, 1));

  return (
    <div className={cn('w-full', className)}>
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <button onClick={prev} className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 active:bg-slate-800">
          <ChevronLeft size={18} />
        </button>
        <span className="text-sm font-semibold text-slate-200">
          {MONTHS[month]} {year}
        </span>
        <button onClick={next} className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 active:bg-slate-800">
          <ChevronRight size={18} />
        </button>
      </div>

      {/* Weekday headers */}
      <div className="grid grid-cols-7 mb-1">
        {DAYS.map(d => (
          <div key={d} className="text-center text-[10px] font-medium text-slate-500 py-1">{d}</div>
        ))}
      </div>

      {/* Days grid */}
      <div className="grid grid-cols-7 gap-y-0.5">
        {days.map((date, i) => {
          if (!date) return <div key={`e-${i}`} />;

          const key = toKey(date);
          const isToday = sameDay(date, today);
          const isSelected = selected && sameDay(date, selected);
          const isRangeStart = rangeStart && sameDay(date, rangeStart);
          const isRangeEnd = rangeEnd && sameDay(date, rangeEnd);
          const isInRange = inRange(date, rangeStart, rangeEnd);
          const marker = markers?.[key];

          return (
            <button
              key={key}
              onClick={() => onSelect?.(date)}
              className={cn(
                'relative flex flex-col items-center justify-center h-10 rounded-lg text-sm transition-colors',
                isSelected || isRangeStart || isRangeEnd
                  ? 'bg-primary-600 text-slate-950 font-semibold'
                  : isInRange
                    ? 'bg-primary-600/15 text-primary-300'
                    : 'text-slate-300 active:bg-slate-800',
                isToday && !isSelected && !isRangeStart && !isRangeEnd && 'font-bold text-primary-400',
              )}
            >
              {date.getDate()}
              {/* Marker dot */}
              {marker && (
                <span
                  className="absolute bottom-1 w-1 h-1 rounded-full"
                  style={{ backgroundColor: marker.color }}
                />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
