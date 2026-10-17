import React, { useState, useEffect } from 'react';
import { BarChart3, Calendar, AlertTriangle, Users, ArrowRightLeft, XCircle, RefreshCw } from 'lucide-react';

interface ReportsViewProps {
  onSelectOrder?: (orderCode: string) => void;
}

export const ReportsView: React.FC<ReportsViewProps> = () => {
  const [period, setPeriod] = useState<'today' | 'yesterday' | 'last_7_days' | 'last_30_days' | 'custom'>('today');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetchReport();
  }, [period, startDate, endDate]);

  async function fetchReport() {
    setLoading(true);
    try {
      let url = `/api/reports?period=${period}`;
      if (period === 'custom' && startDate && endDate) {
        url = `/api/reports?startDate=${startDate}&endDate=${endDate}`;
      }
      const res = await fetch(url);
      const json = await res.json();
      setData(json);
    } catch (err) {
      console.error('Error fetching report:', err);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      {/* Header & Controls */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-800 pb-4">
        <div>
          <h2 className="text-xl font-bold text-slate-100 flex items-center gap-2">
            <BarChart3 className="w-5 h-5 text-amber-400" />
            <span>التقارير التشغيلية المتقدمة (Operational Reports)</span>
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            تحليل دقيق لأعداد الطلبات المنشأة، الطلبات التي طرأ عليها نشاط، وتفصيل الحركات والإلغاءات
          </p>
        </div>

        {/* Filter Buttons */}
        <div className="flex items-center gap-1.5 p-1 bg-slate-900 border border-slate-800 rounded-lg text-xs font-medium flex-wrap">
          <button
            onClick={() => setPeriod('today')}
            className={`px-3 py-1.5 rounded-md transition-all cursor-pointer ${
              period === 'today' ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            اليوم
          </button>
          <button
            onClick={() => setPeriod('yesterday')}
            className={`px-3 py-1.5 rounded-md transition-all cursor-pointer ${
              period === 'yesterday' ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            أمس
          </button>
          <button
            onClick={() => setPeriod('last_7_days')}
            className={`px-3 py-1.5 rounded-md transition-all cursor-pointer ${
              period === 'last_7_days' ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            آخر 7 أيام
          </button>
          <button
            onClick={() => setPeriod('last_30_days')}
            className={`px-3 py-1.5 rounded-md transition-all cursor-pointer ${
              period === 'last_30_days' ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            آخر 30 يوماً
          </button>
          <button
            onClick={() => setPeriod('custom')}
            className={`px-3 py-1.5 rounded-md transition-all cursor-pointer ${
              period === 'custom' ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            نطاق مخصص
          </button>
        </div>
      </div>

      {period === 'custom' && (
        <div className="flex items-center gap-3 p-3 bg-slate-900/60 border border-slate-800 rounded-xl text-xs">
          <Calendar className="w-4 h-4 text-amber-400" />
          <span className="text-slate-400">من:</span>
          <input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            className="px-2 py-1 bg-slate-950 border border-slate-700 rounded text-slate-200"
          />
          <span className="text-slate-400">إلى:</span>
          <input
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            className="px-2 py-1 bg-slate-950 border border-slate-700 rounded text-slate-200"
          />
        </div>
      )}

      {/* Coverage Status Banner */}
      {data?.coverage && !data.coverage.isFullyComplete && (
        <div className="p-3.5 rounded-lg bg-amber-500/10 border border-amber-500/30 text-xs text-amber-300 flex items-start gap-2.5">
          <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
          <div>
            <span className="font-bold">تنبيه تغطية البيانات:</span> يحتوي النطاق الزمني على أيام تغطيتها جزئية أو قيد الاستكمال ({data.coverage.completeDays} من أصل {data.coverage.totalDays} يوماً مكتملة). الأرقام المعروضة تعكس فقط السجلات المؤكدة دون اختلاق.
          </div>
        </div>
      )}

      {loading ? (
        <div className="py-20 text-center text-slate-500">جاري إعداد التقرير التشغيلي...</div>
      ) : data ? (
        <div className="space-y-6">
          {/* Top KPI Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="p-5 rounded-xl bg-slate-900 border border-slate-800">
              <div className="text-xs text-slate-400">الطلبات المنشأة في الفترة</div>
              <div className="text-2xl font-bold font-mono text-slate-100 mt-1">
                {data.createdCount}
              </div>
              <div className="text-[11px] text-slate-500 mt-1">
                بناءً على تاريخ الإنشاء الأصلي في Vendoor
              </div>
            </div>

            <div className="p-5 rounded-xl bg-slate-900 border border-slate-800">
              <div className="text-xs text-slate-400">الطلبات التي طرأ عليها نشاط</div>
              <div className="text-2xl font-bold font-mono text-sky-400 mt-1">
                {data.touchedCount}
              </div>
              <div className="text-[11px] text-slate-500 mt-1">
                طلبات فريدة سُجلت لها حركات في سجلات النشاط
              </div>
            </div>

            <div className="p-5 rounded-xl bg-slate-900 border border-slate-800">
              <div className="text-xs text-slate-400">إجمالي الحركات والعمليات</div>
              <div className="text-2xl font-bold font-mono text-emerald-400 mt-1">
                {data.totalEvents}
              </div>
              <div className="text-[11px] text-slate-500 mt-1">
                أحداث فريدة موثقة بعد إزالة التكرار
              </div>
            </div>
          </div>

          {/* Status Transitions Breakdown */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="p-5 rounded-xl bg-slate-900 border border-slate-800 space-y-3">
              <h3 className="text-sm font-bold text-slate-200 flex items-center gap-2">
                <ArrowRightLeft className="w-4 h-4 text-amber-400" />
                <span>انتقالات الحالات المسجلة بالفترة</span>
              </h3>
              <div className="divide-y divide-slate-800/60 max-h-64 overflow-y-auto">
                {data.transitions.length === 0 ? (
                  <div className="text-slate-500 text-xs py-4 text-center">لا توجد انتقالات مسجلة في هذا النطاق</div>
                ) : (
                  data.transitions.map((t: any, idx: number) => (
                    <div key={idx} className="py-2.5 flex items-center justify-between text-xs">
                      <div className="font-mono text-slate-300">
                        {t.from_status || 'البداية'} ← <span className="text-emerald-400 font-bold">{t.to_status}</span>
                      </div>
                      <span className="font-mono font-bold text-slate-100">{t.count} مرة</span>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* Cancellations Breakdown */}
            <div className="p-5 rounded-xl bg-slate-900 border border-slate-800 space-y-3">
              <h3 className="text-sm font-bold text-slate-200 flex items-center gap-2">
                <XCircle className="w-4 h-4 text-rose-400" />
                <span>حركات الإلغاء المسجلة بالفترة</span>
              </h3>
              <div className="divide-y divide-slate-800/60 max-h-64 overflow-y-auto">
                {data.cancellations.length === 0 ? (
                  <div className="text-slate-500 text-xs py-4 text-center">لا توجد حركات إلغاء في هذا النطاق</div>
                ) : (
                  data.cancellations.map((c: any, idx: number) => (
                    <div key={idx} className="py-2.5 flex items-center justify-between text-xs">
                      <span className="text-slate-300 font-medium">{c.to_status}</span>
                      <span className="font-mono font-bold text-rose-400">{c.count} عملية</span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
};
