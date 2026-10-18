import React, { useState, useEffect } from 'react';
import { ArrowRightLeft, Calendar, TrendingUp, TrendingDown, Minus, CheckCircle2, AlertTriangle, RefreshCw } from 'lucide-react';
import { DateCalendarPicker } from './common/DateCalendarPicker';

export const ComparisonView: React.FC = () => {
  const cairoToday = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Cairo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

  // Default: Period A = Yesterday, Period B = Today
  const [periodAStart, setPeriodAStart] = useState<string>('2026-10-16');
  const [periodAEnd, setPeriodAEnd] = useState<string>('2026-10-16');
  const [periodBStart, setPeriodBStart] = useState<string>(cairoToday);
  const [periodBEnd, setPeriodBEnd] = useState<string>(cairoToday);

  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchComparison();
  }, [periodAStart, periodAEnd, periodBStart, periodBEnd]);

  async function fetchComparison() {
    setLoading(true);
    setError(null);
    try {
      const url = `/api/comparison?periodAStart=${periodAStart}&periodAEnd=${periodAEnd}&periodBStart=${periodBStart}&periodBEnd=${periodBEnd}`;
      const res = await fetch(url);
      if (res.ok) {
        const json = await res.json();
        setData(json);
      } else {
        const errJson = await res.json();
        setError(errJson.error || 'فشل جلب المقارنة');
      }
    } catch (err: any) {
      setError(err.message || 'خطأ في الاتصال');
    } finally {
      setLoading(false);
    }
  }

  function setPreset(type: 'today_vs_yesterday' | 'week_vs_last_week') {
    if (type === 'today_vs_yesterday') {
      const [y, m, d] = cairoToday.split('-').map(Number);
      const yesterday = new Date(Date.UTC(y, m - 1, d) - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      setPeriodAStart(yesterday);
      setPeriodAEnd(yesterday);
      setPeriodBStart(cairoToday);
      setPeriodBEnd(cairoToday);
    } else if (type === 'week_vs_last_week') {
      const [y, m, d] = cairoToday.split('-').map(Number);
      const bStart = new Date(Date.UTC(y, m - 1, d) - 6 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const aEnd = new Date(Date.UTC(y, m - 1, d) - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const aStart = new Date(Date.UTC(y, m - 1, d) - 13 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      setPeriodAStart(aStart);
      setPeriodAEnd(aEnd);
      setPeriodBStart(bStart);
      setPeriodBEnd(cairoToday);
    }
  }

  const pA = data?.periodA;
  const pB = data?.periodB;
  const comp = data?.comparison;

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto font-['Cairo',sans-serif]" dir="rtl">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-stone-800 pb-4">
        <div>
          <h2 className="text-xl font-bold text-stone-100 flex items-center gap-2">
            <ArrowRightLeft className="w-5 h-5 text-amber-400" />
            <span>مقارنة الفترات التشغيلية (Period A vs Period B)</span>
          </h2>
          <p className="text-xs text-stone-400 mt-1">
            مقارنة دقيقة ومستقلة للأداء التشغيلي ومعدلات الإلغاء والطباعة بين فترتين زمنيتين محددتين
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setPreset('today_vs_yesterday')}
            className="px-3 py-1.5 bg-stone-900 border border-stone-800 hover:bg-stone-800 text-stone-300 text-xs rounded-lg transition-colors cursor-pointer"
          >
            اليوم مقارنة بالأمس
          </button>
          <button
            onClick={() => setPreset('week_vs_last_week')}
            className="px-3 py-1.5 bg-stone-900 border border-stone-800 hover:bg-stone-800 text-stone-300 text-xs rounded-lg transition-colors cursor-pointer"
          >
            آخر 7 أيام مقارنة بالسابقة
          </button>
          <button
            onClick={fetchComparison}
            disabled={loading}
            className="p-1.5 bg-stone-900 border border-stone-800 hover:bg-stone-800 text-stone-300 text-xs rounded-lg transition-colors cursor-pointer"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Date Range Selectors */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Period A */}
        <div className="p-4 rounded-xl bg-stone-900/80 border border-stone-800 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-bold text-stone-200">الفترة الأولى (Period A - الأساس)</span>
            {pA?.isComplete ? (
              <span className="text-[11px] text-emerald-400 flex items-center gap-1 font-mono">
                <CheckCircle2 className="w-3.5 h-3.5" /> أرشيف مكتمل
              </span>
            ) : (
              <span className="text-[11px] text-amber-400 flex items-center gap-1 font-mono">
                <AlertTriangle className="w-3.5 h-3.5" /> تغطية جزئية
              </span>
            )}
          </div>
          <div className="pt-1">
            <DateCalendarPicker
              mode="range"
              startDate={periodAStart}
              endDate={periodAEnd}
              onRangeChange={(s, e) => {
                setPeriodAStart(s);
                setPeriodAEnd(e);
              }}
              label="تحديد نطاق الفترة الأولى بالتقويم:"
              showPresets={true}
            />
          </div>
        </div>

        {/* Period B */}
        <div className="p-4 rounded-xl bg-stone-900/80 border border-stone-800 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-bold text-stone-200">الفترة الثانية (Period B - المقارنة)</span>
            {pB?.isComplete ? (
              <span className="text-[11px] text-emerald-400 flex items-center gap-1 font-mono">
                <CheckCircle2 className="w-3.5 h-3.5" /> أرشيف مكتمل
              </span>
            ) : (
              <span className="text-[11px] text-amber-400 flex items-center gap-1 font-mono">
                <AlertTriangle className="w-3.5 h-3.5" /> تغطية جزئية
              </span>
            )}
          </div>
          <div className="pt-1">
            <DateCalendarPicker
              mode="range"
              startDate={periodBStart}
              endDate={periodBEnd}
              onRangeChange={(s, e) => {
                setPeriodBStart(s);
                setPeriodBEnd(e);
              }}
              label="تحديد نطاق الفترة الثانية بالتقويم:"
              showPresets={true}
            />
          </div>
        </div>
      </div>

      {error && (
        <div className="p-4 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs">
          {error}
        </div>
      )}

      {/* Comparison Metrics Grid */}
      {data && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {/* Orders Created */}
          <div className="p-5 rounded-xl bg-stone-900/90 border border-stone-800 space-y-3">
            <span className="text-xs text-stone-400 font-medium">الطلبات المنشأة مصدرياً (Orders Created)</span>
            <div className="flex items-end justify-between">
              <div>
                <span className="text-2xl font-bold text-stone-100 font-mono">{pB?.created || 0}</span>
                <span className="text-xs text-stone-400 mr-2">مقابل {pA?.created || 0}</span>
              </div>
              <div className="flex items-center gap-1 text-xs font-bold font-mono">
                {comp?.created?.diff > 0 ? (
                  <span className="text-emerald-400 flex items-center gap-0.5">
                    <TrendingUp className="w-4 h-4" /> +{comp.created.diff} ({comp.created.pct !== null ? `+${comp.created.pct}%` : 'N/A'})
                  </span>
                ) : comp?.created?.diff < 0 ? (
                  <span className="text-rose-400 flex items-center gap-0.5">
                    <TrendingDown className="w-4 h-4" /> {comp.created.diff} ({comp.created.pct !== null ? `${comp.created.pct}%` : 'N/A'})
                  </span>
                ) : (
                  <span className="text-stone-400 flex items-center gap-0.5">
                    <Minus className="w-4 h-4" /> لا يوجد تغيير
                  </span>
                )}
              </div>
            </div>
            <div className="pt-2 border-t border-stone-800 text-[11px] text-stone-400 flex justify-between font-mono">
              <span>معدل يومي A: {pA?.dailyCreated || 0}</span>
              <span>معدل يومي B: {pB?.dailyCreated || 0}</span>
            </div>
          </div>

          {/* Orders Touched */}
          <div className="p-5 rounded-xl bg-stone-900/90 border border-stone-800 space-y-3">
            <span className="text-xs text-stone-400 font-medium">الطلبات التي طرأ عليها نشاط (Orders Touched)</span>
            <div className="flex items-end justify-between">
              <div>
                <span className="text-2xl font-bold text-stone-100 font-mono">{pB?.touched || 0}</span>
                <span className="text-xs text-stone-400 mr-2">مقابل {pA?.touched || 0}</span>
              </div>
              <div className="flex items-center gap-1 text-xs font-bold font-mono">
                {comp?.touched?.diff > 0 ? (
                  <span className="text-emerald-400 flex items-center gap-0.5">
                    <TrendingUp className="w-4 h-4" /> +{comp.touched.diff} ({comp.touched.pct !== null ? `+${comp.touched.pct}%` : 'N/A'})
                  </span>
                ) : comp?.touched?.diff < 0 ? (
                  <span className="text-rose-400 flex items-center gap-0.5">
                    <TrendingDown className="w-4 h-4" /> {comp.touched.diff} ({comp.touched.pct !== null ? `${comp.touched.pct}%` : 'N/A'})
                  </span>
                ) : (
                  <span className="text-stone-400 flex items-center gap-0.5">
                    <Minus className="w-4 h-4" /> لا يوجد تغيير
                  </span>
                )}
              </div>
            </div>
            <div className="pt-2 border-t border-stone-800 text-[11px] text-stone-400 flex justify-between font-mono">
              <span>معدل يومي A: {pA?.dailyTouched || 0}</span>
              <span>معدل يومي B: {pB?.dailyTouched || 0}</span>
            </div>
          </div>

          {/* Printed Transitions */}
          <div className="p-5 rounded-xl bg-stone-900/90 border border-stone-800 space-y-3">
            <span className="text-xs text-stone-400 font-medium">حركات التحويل للمطبوعة (Printed Actions)</span>
            <div className="flex items-end justify-between">
              <div>
                <span className="text-2xl font-bold text-emerald-400 font-mono">{pB?.printedTransitions || 0}</span>
                <span className="text-xs text-stone-400 mr-2">مقابل {pA?.printedTransitions || 0}</span>
              </div>
              <div className="flex items-center gap-1 text-xs font-bold font-mono">
                {comp?.printedTransitions?.diff > 0 ? (
                  <span className="text-emerald-400 flex items-center gap-0.5">
                    <TrendingUp className="w-4 h-4" /> +{comp.printedTransitions.diff}
                  </span>
                ) : comp?.printedTransitions?.diff < 0 ? (
                  <span className="text-rose-400 flex items-center gap-0.5">
                    <TrendingDown className="w-4 h-4" /> {comp.printedTransitions.diff}
                  </span>
                ) : (
                  <span className="text-stone-400 flex items-center gap-0.5">
                    <Minus className="w-4 h-4" /> 0
                  </span>
                )}
              </div>
            </div>
            <div className="pt-2 border-t border-stone-800 text-[11px] text-stone-400 flex justify-between font-mono">
              <span>الإلغاءات B: {pB?.canceledTransitions || 0}</span>
              <span>الإلغاءات A: {pA?.canceledTransitions || 0}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
