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
  Download,
  Eye,
  Layers,
  ArrowRightLeft,
  MessageSquare,
  MapPin,
  Phone,
  Tag,
  AlertCircle,
  Users,
} from 'lucide-react';
import { DateCalendarPicker, getCairoToday, formatDateArabic } from './common/DateCalendarPicker';
import { SystemLogEvent, LogStats } from '../types';
import { LogDetailsModal } from './LogDetailsModal';

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

  const [logs, setLogs] = useState<SystemLogEvent[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [search, setSearch] = useState<string>('');
  const [actor, setActor] = useState<string>('all');
  const [actionType, setActionType] = useState<string>('all');
  const [matchStatus, setMatchStatus] = useState<string>('all');
  const [isAdministrative, setIsAdministrative] = useState<string>('all');
  const [totalCount, setTotalCount] = useState<number>(0);
  const [page, setPage] = useState<number>(1);
  const [stats, setStats] = useState<LogStats | null>(null);

  // Active inspectors & modals
  const [selectedLog, setSelectedLog] = useState<SystemLogEvent | null>(null);
  const [expandedLogIds, setExpandedLogIds] = useState<Set<number>>(new Set());

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
  }, [page, actor, actionType, matchStatus, isAdministrative, startDate, endDate]);

  async function fetchLogs() {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set('page', String(page));
      params.set('limit', '50');
      params.set('offset', String((page - 1) * 50));

      if (search) params.set('search', search.trim());
      if (actor && actor !== 'all') params.set('actor', actor);
      if (actionType && actionType !== 'all') params.set('actionType', actionType);
      if (matchStatus && matchStatus !== 'all') params.set('matchStatus', matchStatus);
      if (isAdministrative && isAdministrative !== 'all') params.set('isAdministrative', isAdministrative);

      if (startDate && endDate) {
        params.set('startDate', startDate);
        params.set('endDate', endDate);
      } else if (startDate) {
        params.set('date', startDate);
      }

      const res = await fetch(`/api/logs?${params.toString()}`);
      if (res.ok) {
        const json = await res.json();
        setLogs(json.logs || []);
        setTotalCount(json.total || 0);
        if (json.stats) {
          setStats(json.stats);
        }
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

  function toggleExpandLog(id: number) {
    setExpandedLogIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  function handleExportCsv() {
    const params = new URLSearchParams();
    params.set('format', 'csv');
    if (search) params.set('search', search.trim());
    if (actor && actor !== 'all') params.set('actor', actor);
    if (actionType && actionType !== 'all') params.set('actionType', actionType);
    if (matchStatus && matchStatus !== 'all') params.set('matchStatus', matchStatus);
    if (isAdministrative && isAdministrative !== 'all') params.set('isAdministrative', isAdministrative);
    if (startDate && endDate) {
      params.set('startDate', startDate);
      params.set('endDate', endDate);
    } else if (startDate) {
      params.set('date', startDate);
    }

    window.open(`/api/logs?${params.toString()}`, '_blank');
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

  const getActionBadge = (type: string) => {
    switch (type) {
      case 'status_change':
        return { label: 'تغيير حالة', className: 'bg-amber-500/10 text-amber-400 border-amber-500/20' };
      case 'note_added':
        return { label: 'إضافة ملاحظة', className: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' };
      case 'address_edit':
        return { label: 'تعديل عنوان', className: 'bg-sky-500/10 text-sky-400 border-sky-500/20' };
      case 'phone_edit':
        return { label: 'تعديل هاتف', className: 'bg-violet-500/10 text-violet-400 border-violet-500/20' };
      case 'order_created':
        return { label: 'إنشاء طلب', className: 'bg-blue-500/10 text-blue-400 border-blue-500/20' };
      case 'customer_edit':
        return { label: 'تعديل عميل', className: 'bg-teal-500/10 text-teal-400 border-teal-500/20' };
      case 'financial_edit':
        return { label: 'تعديل مالي', className: 'bg-amber-600/10 text-amber-300 border-amber-600/20' };
      case 'product_edit':
        return { label: 'تعديل منتج', className: 'bg-purple-500/10 text-purple-400 border-purple-500/20' };
      case 'print':
        return { label: 'طباعة بوليصة', className: 'bg-indigo-500/10 text-indigo-400 border-indigo-500/20' };
      case 'general_edit':
        return { label: 'تعديل بيانات', className: 'bg-slate-800 text-slate-300 border-slate-700' };
      default:
        return { label: 'نشاط عام', className: 'bg-slate-800 text-slate-400 border-slate-700' };
    }
  };

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto font-['Cairo',sans-serif]" dir="rtl">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-800 pb-4">
        <div>
          <div className="flex items-center gap-2">
            <FileText className="w-5 h-5 text-amber-400" />
            <h2 className="text-xl font-bold text-slate-100">
              سجل العمليات والأنشطة المصدري (Vendoor System & Audit Logs)
            </h2>
          </div>
          <p className="text-xs text-slate-400 mt-1">
            مراقبة شاملة ومفصلة لجميع الحركات وتعديلات العناوين وتغييرات الحالات والملاحظات المأخوذة مباشرة من Vendoor
          </p>
        </div>

        {/* Action Buttons */}
        <div className="flex flex-wrap items-center gap-2.5">
          {/* CSV Export Button */}
          <button
            onClick={handleExportCsv}
            className="px-3 py-1.5 bg-slate-900 border border-slate-700 hover:bg-slate-800 text-slate-200 text-xs rounded-xl flex items-center gap-1.5 transition-colors cursor-pointer"
            title="تصدير السجلات الحالية كملف Excel / CSV"
          >
            <Download className="w-3.5 h-3.5 text-emerald-400" />
            <span>تصدير CSV</span>
          </button>

          {/* Period Fetch Button */}
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

      {/* Quick KPI Statistics Cards */}
      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-3">
          <div className="p-3.5 rounded-2xl bg-slate-900/90 border border-slate-800 space-y-1">
            <span className="text-[11px] text-slate-400 block">إجمالي السجلات</span>
            <div className="text-lg font-bold font-mono text-slate-100">{stats.total}</div>
            <span className="text-[10px] text-slate-500 block">في النطاق والمخزن</span>
          </div>

          <div className="p-3.5 rounded-2xl bg-slate-900/90 border border-slate-800 space-y-1">
            <span className="text-[11px] text-slate-400 block">حركات اليوم (Cairo)</span>
            <div className="text-lg font-bold font-mono text-amber-400">{stats.todayLogs}</div>
            <span className="text-[10px] text-amber-500/80 block">منذ منتصف الليل</span>
          </div>

          <div className="p-3.5 rounded-2xl bg-slate-900/90 border border-slate-800 space-y-1">
            <span className="text-[11px] text-slate-400 block">الموظفون النشطون</span>
            <div className="text-lg font-bold font-mono text-sky-400">{stats.activeEmployees}</div>
            <span className="text-[10px] text-slate-500 block">فريق التشغيل والمتابعة</span>
          </div>

          <div className="p-3.5 rounded-2xl bg-slate-900/90 border border-slate-800 space-y-1">
            <span className="text-[11px] text-slate-400 block">مرتبط بطلبات مؤكدة</span>
            <div className="text-lg font-bold font-mono text-emerald-400">{stats.matchedWithOrders}</div>
            <span className="text-[10px] text-emerald-500/80 block">
              {stats.total > 0 ? `${Math.round((stats.matchedWithOrders / stats.total) * 100)}% ربط كامل` : '0%'}
            </span>
          </div>

          <div className="p-3.5 rounded-2xl bg-slate-900/90 border border-slate-800 space-y-1">
            <span className="text-[11px] text-slate-400 block">تغييرات الحالات</span>
            <div className="text-lg font-bold font-mono text-amber-300">{stats.statusChangesCount}</div>
            <span className="text-[10px] text-slate-500 block">تحولات دورة الطلب</span>
          </div>

          <div className="p-3.5 rounded-2xl bg-slate-900/90 border border-slate-800 space-y-1">
            <span className="text-[11px] text-slate-400 block">ملاحظات وعناوين</span>
            <div className="text-lg font-bold font-mono text-teal-400">
              {stats.notesCount + stats.addressEditsCount + stats.phoneEditsCount}
            </div>
            <span className="text-[10px] text-slate-500 block">تدخلات خدمة العملاء</span>
          </div>
        </div>
      )}

      {/* Date Range Selector & Period Controls */}
      <div className="p-4 rounded-2xl bg-slate-900/90 border border-slate-800 flex flex-wrap items-center justify-between gap-4 shadow-lg">
        <div className="flex items-center gap-3">
          <Calendar className="w-4 h-4 text-amber-400" />
          <span className="text-xs font-semibold text-slate-200">نطاق تاريخ السجلات:</span>
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
          إجمالي نتائج التصفية: <span className="text-amber-400 font-bold">{totalCount}</span>
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

      {/* Rich Filters Bar */}
      <div className="p-4 rounded-2xl bg-slate-900/80 border border-slate-800 flex flex-wrap items-center justify-between gap-3 shadow">
        <form onSubmit={handleSearchSubmit} className="flex items-center gap-2 flex-1 min-w-[280px]">
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-slate-400 absolute right-3 top-2.5" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="بحث برقم أو كود الطلب، اسم العميل، الهاتف، الموظف، أو نص الحركة..."
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

        <div className="flex flex-wrap items-center gap-2">
          {/* Action Type Select */}
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
            <option value="note_added">إضافة ملاحظة (Note)</option>
            <option value="address_edit">تعديل عنوان (Address)</option>
            <option value="phone_edit">تعديل هاتف (Phone)</option>
            <option value="customer_edit">تعديل اسم عميل (Customer)</option>
            <option value="order_created">إنشاء طلب جديد (Created)</option>
            <option value="print">طباعة البوليصة (Printed)</option>
            <option value="financial_edit">تعديل مالي / شحن (Financial)</option>
            <option value="product_edit">تعديل منتج / مقاس (Product)</option>
            <option value="general_edit">تعديل بيانات عامة (General)</option>
          </select>

          {/* Match Status Select */}
          <select
            value={matchStatus}
            onChange={(e) => {
              setMatchStatus(e.target.value);
              setPage(1);
            }}
            className="bg-slate-950 border border-slate-800 rounded-xl px-3 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-amber-500"
          >
            <option value="all">كافة حالات الربط بالطلبات</option>
            <option value="MATCHED">مرتبط بطلب في قاعدة البيانات</option>
            <option value="UNRESOLVED">كود طلب غير مؤكد في البيانات النشطة</option>
            <option value="GENERAL_LOG">حركة عامة / غير مرتبطة بطلب</option>
          </select>
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
                <th className="py-3 px-4">الطلب المرتبط</th>
                <th className="py-3 px-4">نص الإجراء والمقارنة</th>
                <th className="py-3 px-4 text-center">حالة الربط</th>
                <th className="py-3 px-4 text-center">إجراءات</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 text-slate-200">
              {loading && logs.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-14 text-center text-slate-400">
                    <RefreshCw className="w-5 h-5 animate-spin mx-auto mb-2 text-slate-500" />
                    <span>جاري تحميل سجل العمليات والمطابقة...</span>
                  </td>
                </tr>
              ) : logs.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-14 text-center text-slate-500">
                    لا توجد سجلات مطابقة للفترة أو الفلاتر المحددة. يمكنك تعديل الفلاتر أو الضغط على «جلب وحفظ لوجز الفترة» لجلبها من Vendoor.
                  </td>
                </tr>
              ) : (
                logs.map((l: SystemLogEvent) => {
                  const badge = getActionBadge(l.action_type);
                  const isExpanded = expandedLogIds.has(l.id);
                  const isLongText = (l.raw_action_text || '').length > 60;

                  return (
                    <tr key={l.id} className="hover:bg-slate-800/40 transition-colors">
                      {/* Timestamp */}
                      <td className="py-3 px-4 font-mono text-[11px] text-slate-300 whitespace-nowrap">
                        {l.event_timestamp
                          ? new Date(l.event_timestamp).toLocaleString('ar-EG', {
                              month: '2-digit',
                              day: '2-digit',
                              hour: '2-digit',
                              minute: '2-digit',
                              second: '2-digit',
                            })
                          : 'غير محدد'}
                      </td>

                      {/* Actor */}
                      <td className="py-3 px-4 font-semibold text-slate-100 whitespace-nowrap">
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

                      {/* Action Type Badge */}
                      <td className="py-3 px-4 whitespace-nowrap">
                        <span className={`px-2 py-0.5 rounded text-[11px] border font-medium ${badge.className}`}>
                          {badge.label}
                        </span>
                      </td>

                      {/* Order Info */}
                      <td className="py-3 px-4 whitespace-nowrap">
                        {l.order_code ? (
                          <div className="flex flex-col gap-0.5">
                            <div className="flex items-center gap-1.5 font-mono font-bold text-amber-400">
                              <span>#{l.order_code}</span>
                              {l.order_no && (
                                <span className="text-[10px] font-normal text-slate-400">
                                  ({l.order_no})
                                </span>
                              )}
                            </div>
                            {l.customer_name && (
                              <span className="text-[10px] text-slate-300 truncate max-w-[130px]">
                                {l.customer_name}
                              </span>
                            )}
                          </div>
                        ) : (
                          <span className="text-slate-500 text-[11px]">حركة عامة</span>
                        )}
                      </td>

                      {/* Raw text & Old -> New Diff */}
                      <td className="py-3 px-4 max-w-lg">
                        <div className="space-y-1">
                          <div className="text-slate-200">
                            {isLongText && !isExpanded ? (
                              <span>
                                {l.raw_action_text.slice(0, 60)}...
                                <button
                                  onClick={() => toggleExpandLog(l.id)}
                                  className="text-amber-400 hover:underline mr-1 text-[11px] cursor-pointer"
                                >
                                  عرض المزيد
                                </button>
                              </span>
                            ) : (
                              <span>
                                {l.raw_action_text || '-'}
                                {isLongText && (
                                  <button
                                    onClick={() => toggleExpandLog(l.id)}
                                    className="text-slate-400 hover:text-slate-300 hover:underline mr-1 text-[11px] cursor-pointer"
                                  >
                                    إخفاء
                                  </button>
                                )}
                              </span>
                            )}
                          </div>

                          {/* Quick Diff Pill if values exist */}
                          {(l.old_value || l.new_value) && (
                            <div className="flex items-center gap-1 text-[10px] font-mono text-slate-400 flex-wrap">
                              {l.field_name && <span className="text-slate-500">[{l.field_name}]:</span>}
                              {l.old_value && (
                                <span className="bg-rose-500/10 text-rose-300 px-1.5 py-0.2 rounded border border-rose-500/20 line-through">
                                  {l.old_value}
                                </span>
                              )}
                              {l.old_value && l.new_value && <span>←</span>}
                              {l.new_value && (
                                <span className="bg-emerald-500/10 text-emerald-300 px-1.5 py-0.2 rounded border border-emerald-500/20 font-bold">
                                  {l.new_value}
                                </span>
                              )}
                            </div>
                          )}
                        </div>
                      </td>

                      {/* Match Status */}
                      <td className="py-3 px-4 text-center whitespace-nowrap">
                        {l.order_match_status === 'MATCHED' ? (
                          <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                            <CheckCircle2 className="w-2.5 h-2.5" />
                            <span>مرتبط</span>
                          </span>
                        ) : l.order_match_status === 'GENERAL_LOG' ? (
                          <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-slate-800 text-slate-400 border border-slate-700">
                            <span>عام</span>
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/20">
                            <span>غير مسجل</span>
                          </span>
                        )}
                      </td>

                      {/* Actions */}
                      <td className="py-3 px-4 text-center whitespace-nowrap">
                        <div className="flex items-center justify-center gap-1.5">
                          {/* Inspect Modal Button */}
                          <button
                            onClick={() => setSelectedLog(l)}
                            className="p-1.5 hover:bg-slate-800 rounded-lg text-slate-400 hover:text-amber-400 transition-colors cursor-pointer"
                            title="عرض كافة تفاصيل الحركة الأصلية"
                          >
                            <Eye className="w-4 h-4" />
                          </button>

                          {/* Open Order Button */}
                          {l.order_code && onSelectOrder && (
                            <button
                              onClick={() => onSelectOrder(l.order_code!)}
                              className="p-1.5 hover:bg-slate-800 rounded-lg text-slate-400 hover:text-emerald-400 transition-colors cursor-pointer"
                              title="فتح تفاصيل الطلب الكاملة"
                            >
                              <ArrowUpRight className="w-4 h-4" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        <div className="p-3 bg-slate-950/60 border-t border-slate-800 flex items-center justify-between text-xs text-slate-400">
          <span>
            صفحة {page} من {Math.max(1, Math.ceil(totalCount / 50))} (عرض {logs.length} من {totalCount} حركة)
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

      {/* Full Log Details Modal */}
      {selectedLog && (
        <LogDetailsModal
          log={selectedLog}
          onClose={() => setSelectedLog(null)}
          onOpenOrder={onSelectOrder}
        />
      )}
    </div>
  );
};
