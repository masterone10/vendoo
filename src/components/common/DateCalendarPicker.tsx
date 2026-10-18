import React, { useState, useRef, useEffect, useMemo } from 'react';
import { Calendar, ChevronRight, ChevronLeft, Check, X, RotateCcw } from 'lucide-react';

export interface DateCalendarPickerProps {
  mode?: 'single' | 'range';
  // Single mode
  value?: string; // YYYY-MM-DD
  onChange?: (date: string) => void;
  // Range mode
  startDate?: string; // YYYY-MM-DD
  endDate?: string;   // YYYY-MM-DD
  onRangeChange?: (start: string, end: string) => void;
  // Styling & Options
  label?: string;
  placeholder?: string;
  showPresets?: boolean;
  className?: string;
}

const ARABIC_MONTHS = [
  'يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو',
  'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'
];

const WEEKDAY_NAMES = ['سبت', 'أحد', 'اثنين', 'ثلاثاء', 'أربعاء', 'خميس', 'جمعة'];

// Returns Africa/Cairo today YYYY-MM-DD
export function getCairoToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Cairo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

export function formatDateArabic(dateStr: string): string {
  if (!dateStr || dateStr.length < 10) return '';
  const [y, m, d] = dateStr.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return dateStr;
  const monthName = ARABIC_MONTHS[m - 1] || `${m}`;
  return `${d} ${monthName} ${y}`;
}

export const DateCalendarPicker: React.FC<DateCalendarPickerProps> = ({
  mode = 'single',
  value,
  onChange,
  startDate,
  endDate,
  onRangeChange,
  label,
  placeholder,
  showPresets = true,
  className = '',
}) => {
  const cairoToday = useMemo(() => getCairoToday(), []);

  // Popover open state
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Staged values while calendar is open
  const [stagedSingle, setStagedSingle] = useState<string>(value || cairoToday);
  const [stagedStart, setStagedStart] = useState<string>(startDate || cairoToday);
  const [stagedEnd, setStagedEnd] = useState<string>(endDate || cairoToday);
  const [selectingStep, setSelectingStep] = useState<'start' | 'end'>('start');

  // Currently viewed year and month in the calendar
  const initialYearMonth = useMemo(() => {
    const refDate = mode === 'single' ? (value || cairoToday) : (startDate || cairoToday);
    const [y, m] = refDate.slice(0, 7).split('-').map(Number);
    return { year: y || 2026, month: (m || 10) - 1 };
  }, [mode, value, startDate, cairoToday]);

  const [viewYear, setViewYear] = useState<number>(initialYearMonth.year);
  const [viewMonth, setViewMonth] = useState<number>(initialYearMonth.month); // 0-indexed

  // Sync props to staged state when opened or props change
  useEffect(() => {
    if (value) setStagedSingle(value);
  }, [value]);

  useEffect(() => {
    if (startDate) setStagedStart(startDate);
    if (endDate) setStagedEnd(endDate);
  }, [startDate, endDate]);

  // Close on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  // Navigate months
  function prevMonth() {
    if (viewMonth === 0) {
      setViewMonth(11);
      setViewYear((y) => y - 1);
    } else {
      setViewMonth((m) => m - 1);
    }
  }

  function nextMonth() {
    if (viewMonth === 11) {
      setViewMonth(0);
      setViewYear((y) => y + 1);
    } else {
      setViewMonth((m) => m + 1);
    }
  }

  // Days in view month
  const daysInMonth = useMemo(() => {
    return new Date(viewYear, viewMonth + 1, 0).getDate();
  }, [viewYear, viewMonth]);

  // Day of week for 1st of month (0 = Sunday, 6 = Saturday)
  // Shift so Saturday = 0, Friday = 6
  const firstDayOffset = useMemo(() => {
    const rawDay = new Date(viewYear, viewMonth, 1).getDay(); // 0 is Sun, 6 is Sat
    return (rawDay + 1) % 7; // Sat is 0, Sun is 1, ..., Fri is 6
  }, [viewYear, viewMonth]);

  // Handle day click
  function handleDayClick(dayNum: number) {
    const mm = String(viewMonth + 1).padStart(2, '0');
    const dd = String(dayNum).padStart(2, '0');
    const clickedDate = `${viewYear}-${mm}-${dd}`;

    if (mode === 'single') {
      setStagedSingle(clickedDate);
      if (onChange) {
        onChange(clickedDate);
      }
      setIsOpen(false);
    } else {
      // Range mode
      if (selectingStep === 'start') {
        setStagedStart(clickedDate);
        setStagedEnd(clickedDate);
        setSelectingStep('end');
      } else {
        if (clickedDate < stagedStart) {
          // If clicked date is before start date, treat as new start
          setStagedStart(clickedDate);
          setStagedEnd(stagedStart);
        } else {
          setStagedEnd(clickedDate);
        }
        setSelectingStep('start');
      }
    }
  }

  function applyRange() {
    let finalStart = stagedStart;
    let finalEnd = stagedEnd;
    if (finalStart > finalEnd) {
      const tmp = finalStart;
      finalStart = finalEnd;
      finalEnd = tmp;
    }
    if (onRangeChange) {
      onRangeChange(finalStart, finalEnd);
    }
    setIsOpen(false);
  }

  // Preset buttons
  function applyPreset(preset: 'today' | 'yesterday' | 'last7' | 'last30' | 'thisMonth') {
    const [y, m, d] = cairoToday.split('-').map(Number);
    const todayMs = Date.UTC(y, m - 1, d);

    if (preset === 'today') {
      if (mode === 'single') {
        setStagedSingle(cairoToday);
        onChange?.(cairoToday);
        setIsOpen(false);
      } else {
        setStagedStart(cairoToday);
        setStagedEnd(cairoToday);
        onRangeChange?.(cairoToday, cairoToday);
        setIsOpen(false);
      }
    } else if (preset === 'yesterday') {
      const yesterday = new Date(todayMs - 86400000).toISOString().slice(0, 10);
      if (mode === 'single') {
        setStagedSingle(yesterday);
        onChange?.(yesterday);
        setIsOpen(false);
      } else {
        setStagedStart(yesterday);
        setStagedEnd(yesterday);
        onRangeChange?.(yesterday, yesterday);
        setIsOpen(false);
      }
    } else if (preset === 'last7') {
      const start7 = new Date(todayMs - 6 * 86400000).toISOString().slice(0, 10);
      setStagedStart(start7);
      setStagedEnd(cairoToday);
      onRangeChange?.(start7, cairoToday);
      setIsOpen(false);
    } else if (preset === 'last30') {
      const start30 = new Date(todayMs - 29 * 86400000).toISOString().slice(0, 10);
      setStagedStart(start30);
      setStagedEnd(cairoToday);
      onRangeChange?.(start30, cairoToday);
      setIsOpen(false);
    } else if (preset === 'thisMonth') {
      const mm = String(m).padStart(2, '0');
      const startMonth = `${y}-${mm}-01`;
      setStagedStart(startMonth);
      setStagedEnd(cairoToday);
      onRangeChange?.(startMonth, cairoToday);
      setIsOpen(false);
    }
  }

  // Display label for button
  const buttonLabel = useMemo(() => {
    if (mode === 'single') {
      return formatDateArabic(value || stagedSingle) || placeholder || 'اختر التاريخ';
    } else {
      const s = startDate || stagedStart;
      const e = endDate || stagedEnd;
      if (s === e) {
        return formatDateArabic(s);
      }
      return `${formatDateArabic(s)} ← ${formatDateArabic(e)}`;
    }
  }, [mode, value, stagedSingle, startDate, stagedStart, endDate, stagedEnd, placeholder]);

  return (
    <div className={`relative inline-block text-right font-['Cairo',sans-serif] ${className}`} ref={containerRef} dir="rtl">
      {label && <label className="block text-[11px] text-slate-400 mb-1 font-medium">{label}</label>}

      {/* Trigger Button */}
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center justify-between gap-2.5 px-3 py-1.5 rounded-xl bg-slate-900 border border-slate-700/80 hover:border-amber-500/70 text-slate-200 text-xs shadow-inner hover:bg-slate-850 transition-all cursor-pointer min-w-[140px]"
      >
        <div className="flex items-center gap-2">
          <Calendar className="w-4 h-4 text-amber-400 shrink-0" />
          <span className="font-medium whitespace-nowrap">{buttonLabel}</span>
        </div>
        <span className="text-slate-500 text-[10px]">▼</span>
      </button>

      {/* Calendar Popover */}
      {isOpen && (
        <div className="absolute top-full mt-2 right-0 z-50 bg-slate-900/95 backdrop-blur-md border border-slate-700 rounded-2xl shadow-2xl p-4 w-[340px] text-slate-100 animate-in fade-in zoom-in-95 duration-100">
          {/* Presets Header */}
          {showPresets && (
            <div className="flex flex-wrap gap-1 pb-3 mb-3 border-b border-slate-800 text-[11px]">
              <button
                type="button"
                onClick={() => applyPreset('today')}
                className="px-2 py-1 rounded-lg bg-slate-800/80 hover:bg-amber-500/20 hover:text-amber-300 text-slate-300 transition-colors"
              >
                اليوم
              </button>
              <button
                type="button"
                onClick={() => applyPreset('yesterday')}
                className="px-2 py-1 rounded-lg bg-slate-800/80 hover:bg-amber-500/20 hover:text-amber-300 text-slate-300 transition-colors"
              >
                أمس
              </button>
              {mode === 'range' && (
                <>
                  <button
                    type="button"
                    onClick={() => applyPreset('last7')}
                    className="px-2 py-1 rounded-lg bg-slate-800/80 hover:bg-amber-500/20 hover:text-amber-300 text-slate-300 transition-colors"
                  >
                    آخر 7 أيام
                  </button>
                  <button
                    type="button"
                    onClick={() => applyPreset('last30')}
                    className="px-2 py-1 rounded-lg bg-slate-800/80 hover:bg-amber-500/20 hover:text-amber-300 text-slate-300 transition-colors"
                  >
                    آخر 30 يوماً
                  </button>
                  <button
                    type="button"
                    onClick={() => applyPreset('thisMonth')}
                    className="px-2 py-1 rounded-lg bg-slate-800/80 hover:bg-amber-500/20 hover:text-amber-300 text-slate-300 transition-colors"
                  >
                    هذا الشهر
                  </button>
                </>
              )}
            </div>
          )}

          {/* Month / Year Navigator */}
          <div className="flex items-center justify-between mb-3 px-1">
            <button
              type="button"
              onClick={prevMonth}
              className="p-1 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-slate-100 transition-colors"
              title="الشهر السابق"
            >
              <ChevronRight className="w-4 h-4" />
            </button>

            <div className="flex items-center gap-2">
              <span className="font-bold text-sm text-slate-100">
                {ARABIC_MONTHS[viewMonth]} {viewYear}
              </span>
            </div>

            <button
              type="button"
              onClick={nextMonth}
              className="p-1 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-slate-100 transition-colors"
              title="الشهر التالي"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
          </div>

          {/* Weekdays Header */}
          <div className="grid grid-cols-7 gap-1 text-center text-[10px] text-slate-400 font-bold mb-1">
            {WEEKDAY_NAMES.map((w, idx) => (
              <div key={idx} className="py-1">
                {w}
              </div>
            ))}
          </div>

          {/* Days Grid */}
          <div className="grid grid-cols-7 gap-1 text-xs">
            {/* Empty slots before first day */}
            {Array.from({ length: firstDayOffset }).map((_, i) => (
              <div key={`empty-${i}`} className="h-8" />
            ))}

            {/* Days in Month */}
            {Array.from({ length: daysInMonth }).map((_, i) => {
              const day = i + 1;
              const mm = String(viewMonth + 1).padStart(2, '0');
              const dd = String(day).padStart(2, '0');
              const dateStr = `${viewYear}-${mm}-${dd}`;

              let isSelected = false;
              let isInRange = false;
              let isRangeStart = false;
              let isRangeEnd = false;

              if (mode === 'single') {
                isSelected = dateStr === (value || stagedSingle);
              } else {
                const s = stagedStart <= stagedEnd ? stagedStart : stagedEnd;
                const e = stagedStart <= stagedEnd ? stagedEnd : stagedStart;
                isRangeStart = dateStr === s;
                isRangeEnd = dateStr === e;
                isSelected = isRangeStart || isRangeEnd;
                isInRange = dateStr >= s && dateStr <= e;
              }

              const isTodayCell = dateStr === cairoToday;

              return (
                <button
                  key={day}
                  type="button"
                  onClick={() => handleDayClick(day)}
                  className={`h-8 rounded-lg flex items-center justify-center font-medium transition-all cursor-pointer ${
                    isSelected
                      ? 'bg-amber-500 text-slate-950 font-bold shadow-md scale-105'
                      : isInRange
                      ? 'bg-amber-500/20 text-amber-200'
                      : isTodayCell
                      ? 'border border-amber-500/50 text-amber-300 hover:bg-slate-800'
                      : 'text-slate-300 hover:bg-slate-800 hover:text-slate-100'
                  }`}
                >
                  {day}
                </button>
              );
            })}
          </div>

          {/* Range Mode Selection Instruction & Footer */}
          {mode === 'range' && (
            <div className="mt-4 pt-3 border-t border-slate-800 flex items-center justify-between text-xs">
              <div className="text-[11px] text-slate-400">
                {selectingStep === 'end' ? (
                  <span className="text-amber-400">اختر تاريخ النهاية</span>
                ) : (
                  <span>
                    الفترة: <b className="text-slate-200 font-mono">{stagedStart}</b> إلى <b className="text-slate-200 font-mono">{stagedEnd}</b>
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setIsOpen(false)}
                  className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors"
                >
                  إلغاء
                </button>
                <button
                  type="button"
                  onClick={applyRange}
                  className="px-3 py-1 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold flex items-center gap-1 transition-colors"
                >
                  <Check className="w-3.5 h-3.5" />
                  <span>تطبيق</span>
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
