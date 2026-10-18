import React, { useState, useEffect } from 'react';
import {
  FileText,
  Search,
  Filter,
  Calendar,
  User,
  Clock,
  ArrowUpRight,
  RefreshCw,
  DownloadCloud,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  X,
  ShieldCheck,
} from 'lucide-react';
import { DateCalendarPicker, getCairoToday, formatDateArabic } from './common/DateCalendarPicker';

interface LogsViewProps {
  onSelectOrder?: (orderCode: string) => void;
  selectedDate?: string;
}

interface PeriodFetchReport {
  success: boolean;
  startDate: string;
  endDate: string;
  totalDays: number;
  totalFetched: number;
  totalSaved: number;
  totalDuplicates: number;
  failedPages: number;
  coverageStatus: 'COMPLETE' | 'PARTIAL' | 'FAILED';
  days: Array<{
    date: string;
    pagesTotal: number;
    pagesFetched: number;
    eventsFetched: number;
    eventsSaved: number;
    status: 'COMPLETE' | 'PARTIAL' | 'FAILED';
    error?: string | null;
  }>;
  errorMessage?: string | null;
}

export const LogsView: React.FC<LogsViewProps> = ({ onSelectOrder, selectedDate }) => {
  const cairoToday = getCairoToday();
  const [startDate, setStartDate] = useState<string>(selectedDate || cairoToday);
  const [endDate, setEndDate] = useState<string>(selectedDate || cairoToday);

  const [logs, setLogs] = useState<any[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [search, setSearch] = useState<string>('');
  const [actor, setActor] = useState<string>('all');
  const [actionType, setActionType] = useState<string>('all');
  const [totalCount, setTotalCount] = useState<number>(0);
  const [page, setPage] = useState<number>(1);

  // Period Logs Fetching state
  const [isFetchingPeriod, setIsFetchingPeriod] = useState<boolean>(false);
  const [fetchReport, setFetchReport] = useState<PeriodFetchReport | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);

  useEffect(() => {
    if (selectedDate) {
      setStartDate(selectedDate);
      setEndDate(selectedDate);
    }
  }, [selectedDate]);

  useEffect(() => {
    fetchLogs();
  }, [page, actor, actionType, startDate, endDate]);

  async function fetchLogs() {
    setLoading(true);
    try {
      let url = `/api/logs?page=${page}&limit=50`;
      if (search) url += `&search=${encodeURIComponent(search)}`;
      if (actor && actor !== 'all') url += `&actor=${encodeURIComponent(actor)}`;
      if (actionType && actionType !== 'all') url += `&actionType=${encodeURIComponent(actionType)}`;
      if (startDate && endDate) {
        url += `&startDate=${startDate}&endDate=${endDate}`;
      } else if (startDate) {
        url += `&date=${startDate}`;
      }

      const res = await fetch(url);
      if (res.ok) {
        const json = await res.json();
        setLogs(json.logs || []);
        setTotalCount(json.total || 0);
      }
    } catch (err) {
      console.error('Error fetching logs:', err);
    } finally {
      setLoading(false);
    }
  }

  function handleSearchSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPage(1);
    fetchLogs();
  }

  // Trigger Stage 6 action: «جلب وحفظ لوجز الفترة»
  async function handleFetchPeriodLogs() {
    if (!startDate || !endDate) return;
    setIsFetchingPeriod(true);
    setFetchReport(null);
    setFetchError(null);

    try {
      const res = await fetch('/api/logs/fetch-period', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ startDate, endDate }),
      });

      const data = await res.json();
      if (data.success && data.report) {
        setFetchReport(data.report);
        // Refresh local table
        fetchLogs();
      } else {
        setFetchError(data.error || 'تعذر جلب لوجز الفترة من المصدر');
      }
    } catch (err: any) {
      setFetchError(err.message || 'خطأ في الاتصال بالخادم');
    } finally {
      setIsFetchingPeriod(false);
    }
  }

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto font-['Cairo',sans-serif]" dir="rtl">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-800 pb-4">
        <div>
          <div className="flex items-center gap-2">
            <FileText className="w-5 h-5 text-amber-400" />
            <h2 className="text-xl font-bold text-slate-100">
              سجل العمليات والأنشطة المصدري (System & Audit Logs)
            </h2>
          </div>
          <p className="text-xs text-slate-400 mt-1">
            سجل دقيق وموثق لكافة الأنشطة المنفذة من قبل موظفي التشغيل والنظام مستخرج مباشرة من سجلات فيندور ومحفوظ محلياً
          </p>
        </div>

        {/* Action Buttons */}
        <div className="flex flex-wrap items-center gap-2.5">
          {/* Stage 6: جلب وحفظ لوجز الفترة */}
          <button
            onClick={handleFetchPeriodLogs}
            disabled={isFetchingPeriod}
            className="px-3.5 py-1.5 bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-slate-950 font-bold text-xs rounded-xl flex items-center gap-2 transition-all cursor-pointer shadow"
            title="جلب جميع صفحات اللوجز للفترة المحددة وحفظها في قاعدة البيانات"
          >
            <DownloadCloud className={`w-4 h-4 ${isFetchingPeriod ? 'animate-bounce' : ''}`} />
            <span>{isFetchingPeriod ? 'جاري جلب وحفظ اللوجز...' : 'جلب وحفظ لوجز الفترة'}</span>
          </button>

          <button
            onClick={fetchLogs}
            disabled={loading}
            className="px-3 py-1.5 bg-slate-900 border border-slate-800 hover:bg-slate-800 text-slate-300 text-xs rounded-xl flex items-center gap-2 transition-colors cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span>تحديث السجل</span>
          </button>
        </div>
      </div>

      {/* Date Range Selector & Period Controls (Stage 4) */}
      <div className="p-4 rounded-2xl bg-slate-900/90 border border-slate-800 flex flex-wrap items-center justify-between gap-4 shadow-lg">
        <div className="flex items-center gap-3">
          <Calendar className="w-4 h-4 text-amber-400" />
          <span className="text-xs font-semibold text-slate-200">فترة السجلات:</span>
          <DateCalendarPicker
            mode="range"
            startDate={startDate}
            endDate={endDate}
            onRangeChange={(s, e) => {
              setStartDate(s);
              setEndDate(e);
              setPage(1);
            }}
            showPresets={true}
          />
        </div>

        <div className="text-xs text-slate-400 font-mono">
          إجمالي الحركات في النطاق: <span className="text-amber-400 font-bold">{totalCount}</span>
        </div>
      </div>

      {/* Modal / Report for "جلب وحفظ لوجز الفترة" Results */}
      {fetchReport && (
        <div className="p-4 rounded-2xl bg-slate-900 border border-amber-500/30 text-xs space-y-3 animate-in fade-in">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm font-bold text-slate-100">
              {fetchReport.coverageStatus === 'COMPLETE' ? (
                <CheckCircle2 className="w-5 h-5 text-emerald-400" />
              ) : (
                <AlertTriangle className="w-5 h-5 text-amber-400" />
              )}
              <span>نتيجة جلب وحفظ لوجز الفترة ({fetchReport.startDate} ← {fetchReport.endDate})</span>
            </div>
            <button
              onClick={() => setFetchReport(null)}
              className="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-slate-200 cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-5 gap-3 text-center">
            <div className="p-2.5 rounded-xl bg-slate-950 border border-slate-800">
              <span className="text-[10px] text-slate-400 block mb-1">الأيام المغطاة</span>
              <span className="font-bold text-slate-200 text-sm font-mono">{fetchReport.totalDays}</span>
            </div>
            <div className="p-2.5 rounded-xl bg-slate-950 border border-slate-800">
              <span className="text-[10px] text-slate-400 block mb-1">المستلم من Vendoor</span>
              <span className="font-bold text-sky-400 text-sm font-mono">{fetchReport.totalFetched}</span>
            </div>
            <div className="p-2.5 rounded-xl bg-slate-950 border border-slate-800">
              <span className="text-[10px] text-slate-400 block mb-1">المحفوظ بقاعدة البيانات</span>
              <span className="font-bold text-emerald-400 text-sm font-mono">{fetchReport.totalSaved}</span>
            </div>
            <div className="p-2.5 rounded-xl bg-slate-950 border border-slate-800">
              <span className="text-[10px] text-slate-400 block mb-1">المكررات المستبعدة</span>
              <span className="font-bold text-slate-400 text-sm font-mono">{fetchReport.totalDuplicates}</span>
            </div>
            <div className="p-2.5 rounded-xl bg-slate-950 border border-slate-800">
              <span className="text-[10px] text-slate-400 block mb-1">حالة التغطية</span>
              <span className={`font-bold text-xs uppercase px-2 py-0.5 rounded font-mono ${
                fetchReport.coverageStatus === 'COMPLETE' ? 'bg-emerald-500/20 text-emerald-300' : 'bg-amber-500/20 text-amber-300'
              }`}>
                {fetchReport.coverageStatus}
              </span>
            </div>
          </div>
        </div>
      )}

      {fetchError && (
        <div className="p-3.5 rounded-xl bg-rose-500/10 border border-rose-500/20 text-xs text-rose-300 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <XCircle className="w-4 h-4 text-rose-400 shrink-0" />
            <span>{fetchError}</span>
          </div>
          <button onClick={() => setFetchError(null)} className="text-slate-400 hover:text-slate-200">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Filters Bar */}
      <div className="p-4 rounded-2xl bg-slate-900/80 border border-slate-800 flex flex-wrap items-center justify-between gap-4">
        <form onSubmit={handleSearchSubmit} className="flex items-center gap-2 flex-1 min-w-[260px]">
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-slate-400 absolute right-3 top-2.5" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="بحث بكود الطلب أو اسم الموظف أو نص الإجراء..."
              className="w-full bg-slate-950 border border-slate-800 rounded-xl pr-9 pl-3 py-1.5 text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-amber-500"
            />
          </div>
          <button
            type="submit"
            className="px-3.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs rounded-xl font-medium cursor-pointer transition-colors"
          >
            بحث
          </button>
        </form>

        <div className="flex items-center gap-3">
          <div>
            <select
              value={actionType}
              onChange={(e) => {
                setActionType(e.target.value);
                setPage(1);
              }}
              className="bg-slate-950 border border-slate-800 rounded-xl px-3 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-amber-500"
            >
              <option value="all">كافة أنواع الإجراءات</option>
              <option value="status_change">تغيير حالة (Status Change)</option>
              <option value="print">طباعة البوليصة (Print)</option>
              <option value="confirm">تأكيد الطلب (Confirm)</option>
              <option value="cancel">إلغاء الطلب (Cancel)</option>
              <option value="edit">تعديل بيانات (Edit)</option>
              <option value="phone_edit">تعديل هاتف</option>
              <option value="address_edit">تعديل عنوان</option>
              <option value="order_created">إنشاء طلب جديد</option>
            </select>
          </div>
        </div>
      </div>

      {/* Logs Table */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-2xl overflow-hidden shadow-lg">
        <div className="overflow-x-auto">
          <table className="w-full text-right text-xs">
            <thead className="bg-slate-950/80 border-b border-slate-800 text-slate-400 font-medium">
              <tr>
                <th className="py-3 px-4">توقيت الحدث (Cairo)</th>
                <th className="py-3 px-4">الموظف / المنفذ</th>
                <th className="py-3 px-4">نوع الإجراء</th>
                <th className="py-3 px-4">كود الطلب</th>
                <th className="py-3 px-4">تفاصيل الإجراء المصدري</th>
                <th className="py-3 px-4 text-center">عرض</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 text-slate-200">
              {loading && logs.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-12 text-center text-slate-400">
                    <RefreshCw className="w-5 h-5 animate-spin mx-auto mb-2 text-slate-500" />
                    <span>جاري تحميل سجل العمليات...</span>
                  </td>
                </tr>
              ) : logs.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-12 text-center text-slate-500">
                    لا توجد سجلات مطابقة للفترة أو الفلاتر المحددة. يمكنك الضغط على «جلب وحفظ لوجز الفترة» لجلبها من Vendoor.
                  </td>
                </tr>
              ) : (
                logs.map((l: any) => (
                  <tr key={l.id} className="hover:bg-slate-800/40 transition-colors">
                    <td className="py-3 px-4 font-mono text-[11px] text-slate-300">
                      {l.event_timestamp
                        ? new Date(l.event_timestamp).toLocaleString('ar-EG', {
                            year: 'numeric',
                            month: '2-digit',
                            day: '2-digit',
                            hour: '2-digit',
                            minute: '2-digit',
                            second: '2-digit',
                          })
                        : 'غير محدد'}
                    </td>
                    <td className="py-3 px-4 font-semibold text-slate-100">
                      <div className="flex items-center gap-1.5">
                        <User className="w-3.5 h-3.5 text-slate-400" />
                        <span>{l.actor_name || 'النظام'}</span>
                        {l.actor_name && (l.actor_name.includes('CS') || l.actor_name.includes('خدمة العملاء')) && (
                          <span className="text-[10px] px-1.5 py-0.2 rounded bg-sky-500/20 text-sky-300 font-mono">
                            CS
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="py-3 px-4">
                      <span className="px-2 py-0.5 rounded text-[11px] font-mono bg-slate-800 text-slate-300">
                        {l.action_type || 'نشاط'}
                      </span>
                    </td>
                    <td className="py-3 px-4 font-mono font-bold text-amber-400">
                      {l.order_code || 'عام'}
                    </td>
                    <td className="py-3 px-4 text-slate-300 max-w-md truncate">
                      {l.raw_action_text || '-'}
                    </td>
                    <td className="py-3 px-4 text-center">
                      {l.order_code && onSelectOrder && (
                        <button
                          onClick={() => onSelectOrder(l.order_code)}
                          className="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-amber-400 transition-colors cursor-pointer"
                          title="عرض تفاصيل الطلب"
                        >
                          <ArrowUpRight className="w-4 h-4" />
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        <div className="p-3 bg-slate-950/60 border-t border-slate-800 flex items-center justify-between text-xs text-slate-400">
          <span>
            صفحة {page} من {Math.max(1, Math.ceil(totalCount / 50))}
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="px-2.5 py-1 rounded bg-slate-900 border border-slate-800 disabled:opacity-30 hover:bg-slate-800 cursor-pointer"
            >
              السابق
            </button>
            <button
              onClick={() => setPage((p) => p + 1)}
              disabled={page * 50 >= totalCount}
              className="px-2.5 py-1 rounded bg-slate-900 border border-slate-800 disabled:opacity-30 hover:bg-slate-800 cursor-pointer"
            >
              التالي
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
