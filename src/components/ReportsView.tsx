import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
  BarChart3,
  Calendar,
  AlertTriangle,
  Users,
  ArrowRightLeft,
  XCircle,
  RefreshCw,
  Printer,
  Copy,
  Check,
  Search,
  Building2,
  TrendingUp,
  MapPin,
  PackageCheck,
  Clock,
  Layers,
  ShieldAlert,
  DollarSign,
  Download,
  Boxes,
  CheckCircle2,
  Filter,
  ChevronLeft,
  ChevronRight,
  User,
  Phone,
  FileText,
  Activity,
  AlertCircle,
  HelpCircle,
  Info,
  ExternalLink,
  FileSpreadsheet,
  Database,
} from 'lucide-react';
import { DateCalendarPicker, getCairoToday, formatDateArabic } from './common/DateCalendarPicker';
import { ReportKpiDrilldownModal, DrilldownPillar } from './ReportKpiDrilldownModal';
import { BatchLogsImportModal } from './BatchLogsImportModal';
import { LogsIntelligenceReport, RangeJobState, HistoricalDayStatus } from '../types';

interface ReportsViewProps {
  onSelectOrder?: (orderCode: string) => void;
}

export const ReportsView: React.FC<ReportsViewProps> = ({ onSelectOrder }) => {
  const cairoToday = useMemo(() => getCairoToday(), []);

  // Selection mode: 'single' (day) or 'range' (week / custom)
  const [calendarMode, setCalendarMode] = useState<'single' | 'range'>('single');
  const [singleDate, setSingleDate] = useState<string>(cairoToday);
  const [startDate, setStartDate] = useState<string>(cairoToday);
  const [endDate, setEndDate] = useState<string>(cairoToday);

  // Quick preset button active state
  const [activePreset, setActivePreset] = useState<'today' | 'yesterday' | 'week' | 'custom'>('today');

  // Intelligence Report state
  const [report, setReport] = useState<LogsIntelligenceReport | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [jobStatus, setJobStatus] = useState<RangeJobState | null>(null);
  const [copiedSummary, setCopiedSummary] = useState<boolean>(false);

  // Active view tab
  const [activeTab, setActiveTab] = useState<'overview' | 'daily_breakdown' | 'employees' | 'transitions' | 'admin_edits' | 'unresolved'>('overview');

  // Filters & drilldown
  const [drilldownPillar, setDrilldownPillar] = useState<DrilldownPillar | null>(null);
  const [drilldownActor, setDrilldownActor] = useState<string | undefined>(undefined);
  const [employeeSearch, setEmployeeSearch] = useState<string>('');
  const [employeeTypeFilter, setEmployeeTypeFilter] = useState<'ALL' | 'STAFF' | 'SYSTEM'>('ALL');

  // Polling ref for job status
  const pollIntervalRef = useRef<any>(null);

  // Batch Logs Import Modal state
  const [showImportModal, setShowImportModal] = useState<boolean>(false);

  // Day Provenance & Resolution Status
  const [dayStatus, setDayStatus] = useState<HistoricalDayStatus | null>(null);
  const [dayActionLoading, setDayActionLoading] = useState<boolean>(false);

  // Effective start & end dates
  const effectiveStart = calendarMode === 'single' ? singleDate : startDate;
  const effectiveEnd = calendarMode === 'single' ? singleDate : endDate;

  // Load report when date selection changes
  useEffect(() => {
    fetchReport(effectiveStart, effectiveEnd);
    if (calendarMode === 'single' || effectiveStart === effectiveEnd) {
      fetchDayStatus(effectiveStart);
    } else {
      setDayStatus(null);
    }
    return () => {
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    };
  }, [effectiveStart, effectiveEnd, calendarMode]);

  async function fetchDayStatus(date: string) {
    try {
      const res = await fetch(`/api/reports/day-status?date=${date}`);
      if (!res.ok) return;
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('application/json')) return;
      const data = await res.json();
      if (data.success && data.dayStatus) {
        setDayStatus(data.dayStatus);
      }
    } catch (err) {
      console.error('Error fetching day status:', err);
    }
  }

  async function handleDayAction(action: 'recheck' | 'complete_missing' | 'force_refetch' | 'sync_supabase' | 'reconcile') {
    if (!effectiveStart) return;
    if (action === 'force_refetch') {
      const ok = window.confirm('هل تريد بالتأكيد إعادة جلب هذا اليوم بالكامل من Vendoor وتحديث الحركات؟');
      if (!ok) return;
    }
    setDayActionLoading(true);
    try {
      const res = await fetch('/api/reports/day-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: effectiveStart, action }),
      });
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('application/json')) {
        const text = await res.text();
        console.warn(`Non-JSON response for day action (${res.status}):`, text.slice(0, 100));
        return;
      }
      let data: any = null;
      try {
        data = await res.json();
      } catch (parseErr) {
        console.warn('Failed to parse JSON for day action:', parseErr);
        return;
      }
      if (data && data.success && data.dayStatus) {
        setDayStatus(data.dayStatus);
      }
      await fetchReport(effectiveStart, effectiveEnd, action === 'force_refetch');
    } catch (err) {
      console.error('Error executing day action:', err);
    } finally {
      setDayActionLoading(false);
    }
  }

  async function fetchReport(s: string, e: string, forceFetch = false) {
    setLoading(true);
    try {
      const url = forceFetch
        ? `/api/reports/logs-fetch`
        : `/api/reports/logs-intelligence?startDate=${s}&endDate=${e}&autoFetch=true`;

      let res;
      if (forceFetch) {
        res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ startDate: s, endDate: e, force: true }),
        });
      } else {
        res = await fetch(url);
      }

      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('application/json')) {
        const text = await res.text();
        console.warn(`Non-JSON response fetching report (${res.status}):`, text.slice(0, 100));
        setLoading(false);
        return;
      }

      let json: any = null;
      try {
        json = await res.json();
      } catch (parseErr) {
        console.warn('Failed to parse JSON for report:', parseErr);
        setLoading(false);
        return;
      }
      if (json.success && json.report) {
        setReport(json.report);
        setJobStatus(json.jobStatus || null);

        // If job is running, start polling status
        const isRunning =
          json.jobStatus &&
          (json.jobStatus.stage === 'CHECKING_STORAGE' ||
            json.jobStatus.stage === 'FETCHING_VENDOOR' ||
            json.jobStatus.stage === 'SAVING_RECORDS' ||
            json.jobStatus.stage === 'ANALYZING_ACTIONS' ||
            json.jobStatus.stage === 'COMPUTING_METRICS' ||
            json.jobStatus.stage === 'PREPARING_REPORT');

        if (isRunning) {
          startPolling(s, e);
        } else {
          setLoading(false);
        }
      } else {
        setLoading(false);
      }
    } catch (err) {
      console.error('Error fetching logs intelligence report:', err);
      setLoading(false);
    }
  }

  function startPolling(s: string, e: string) {
    if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);

    pollIntervalRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/reports/logs-status?startDate=${s}&endDate=${e}`);
        const ct = res.headers.get('content-type') || '';
        if (!ct.includes('application/json')) return;
        const data = await res.json();
        if (data.success && data.job) {
          setJobStatus(data.job);
          if (data.job.stage === 'COMPLETE' || data.job.stage === 'PARTIAL' || data.job.stage === 'FAILED') {
            clearInterval(pollIntervalRef.current);
            // Refresh final report data
            const repRes = await fetch(`/api/reports/logs-intelligence?startDate=${s}&endDate=${e}&autoFetch=false`);
            const repCt = repRes.headers.get('content-type') || '';
            if (repCt.includes('application/json')) {
              const repData = await repRes.json();
              if (repData.success && repData.report) {
                setReport(repData.report);
              }
            }
            setLoading(false);
          }
        }
      } catch (pollErr) {
        console.error('Error polling logs status:', pollErr);
      }
    }, 1500);
  }

  // Preset handlers
  function handlePresetToday() {
    setActivePreset('today');
    setCalendarMode('single');
    setSingleDate(cairoToday);
  }

  function handlePresetYesterday() {
    setActivePreset('yesterday');
    setCalendarMode('single');
    const now = new Date();
    const y = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const yStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' }).format(y);
    setSingleDate(yStr);
  }

  function handlePresetWeek() {
    setActivePreset('week');
    setCalendarMode('range');
    const now = new Date();
    const past = new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000);
    const sStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' }).format(past);
    setStartDate(sStr);
    setEndDate(cairoToday);
  }

  // Copy Executive Arabic Summary
  function handleCopySummary() {
    if (!report) return;
    const m = report.metrics;
    const periodLabel = report.periodLabel;

    const summary = `📊 *تقرير نشاط عمليات Vendoor الذكي (مبني على اللوجز المصدرية وحدها)*
الفترة: ${periodLabel}
توقيت البداية إلى النهاية: [${report.cairoInterval.startCairo} إلى ${report.cairoInterval.endExclusiveCairo})
-----------------------------------------
🎯 *إجابات مؤشرات النشاط الأساسية:*
• إجمالي حركات اللوجز المسجلة: ${m.totalLogs.toLocaleString()} حركة
• عدد الطلبات الفريدة التي شهدت نشاطاً: ${m.uniqueOrdersTouched.toLocaleString()} طلب فريد

📦 *1. الأوردرات المنشأة (Created):*
• طلبات منشأة جديدة: ${m.createdOrdersCount.toLocaleString()} طلب فريد
• إجمالي أحداث إنشاء الطلبات: ${m.createdEventsCount.toLocaleString()} حدث

✅ *2. الأوردرات المؤكدة (Printed = تأكيد الأوردر):*
• طلبات تم تأكيدها: ${m.confirmedOrdersCount.toLocaleString()} طلب فريد وصلت لحالة Printed
• إجمالي أحداث الطباعة والتأكيد: ${m.printedEventsCount.toLocaleString()} حدث طباعة

❌ *3. الأوردرات الملغاة (Canceled):*
• طلبات ألغيت نهائياً: ${m.canceledOrdersCount.toLocaleString()} طلب فريد (حالة Canceled)
• أحداث الإلغاء النهائي: ${m.canceledEventsCount.toLocaleString()} حدث
• أحداث قيد الإلغاء (معزولة): ${m.cancelingEventsCount.toLocaleString()} حدث Canceling

📞 *4. حركات الهاتف الإضافي:*
• طلبات أضيف لها رقم إضافي: ${m.extraPhonesAddedUniqueOrders.toLocaleString()} طلب فريد
• إجمالي أحداث إضافة رقم إضافي: ${m.extraPhonesAddedEvents.toLocaleString()} حركة
• استبدال أرقام هواتف: ${m.extraPhonesReplacedCount.toLocaleString()} حركة
• حذف أرقام هواتف: ${m.extraPhonesDeletedCount.toLocaleString()} حركة

👥 *5. كادر العمليات والنشاط البشري:*
• عدد الموظفين الفاعلين: ${report.employees.filter((e) => e.is_system === 0).length} موظف
• إجمالي التعديلات الإدارية: ${m.adminEditsCount.toLocaleString()} تعديل
• حركات تحتاج إلى مراجعة: ${m.unresolvedCount.toLocaleString()} حركة
-----------------------------------------
حالة التغطية: ${report.status === 'COMPLETE' ? '✅ مكتملة وموثقة' : '⚠️ جزئية'}
المصدر: لوجز Vendoor المصدرية المباشرة`;

    navigator.clipboard.writeText(summary);
    setCopiedSummary(true);
    setTimeout(() => setCopiedSummary(false), 2500);
  }

  // Filtered employees list
  const filteredEmployees = useMemo(() => {
    if (!report?.employees) return [];
    return report.employees.filter((emp) => {
      const matchSearch =
        !employeeSearch.trim() ||
        emp.actor_name.toLowerCase().includes(employeeSearch.trim().toLowerCase());
      const matchType =
        employeeTypeFilter === 'ALL' ||
        (employeeTypeFilter === 'STAFF' && emp.is_system === 0) ||
        (employeeTypeFilter === 'SYSTEM' && emp.is_system === 1);
      return matchSearch && matchType;
    });
  }, [report?.employees, employeeSearch, employeeTypeFilter]);

  // Is infinity loading active?
  const isFetchingLogs = Boolean(
    loading ||
    (jobStatus &&
      (jobStatus.stage === 'CHECKING_STORAGE' ||
        jobStatus.stage === 'FETCHING_VENDOOR' ||
        jobStatus.stage === 'SAVING_RECORDS' ||
        jobStatus.stage === 'ANALYZING_ACTIONS' ||
        jobStatus.stage === 'COMPUTING_METRICS' ||
        jobStatus.stage === 'PREPARING_REPORT'))
  );

  return (
    <div className="space-y-6 animate-in fade-in duration-300 pb-16">
      {/* 1. Header with Period Picker, Mode Switch, and Quick Presets */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-xl">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2.5">
              <div className="p-2.5 rounded-xl bg-amber-500/10 text-amber-400 border border-amber-500/20">
                <Activity className="w-6 h-6" />
              </div>
              <div>
                <h1 className="text-xl font-bold text-slate-100 flex items-center gap-2">
                  <span>تقرير النشاط التشغيلي الذكي من اللوجز</span>
                  <span className="text-xs px-2.5 py-0.5 rounded-full bg-amber-500/10 text-amber-300 border border-amber-500/20 font-sans">
                    لوجز Vendoor وحدها
                  </span>
                </h1>
                <p className="text-xs text-slate-400 mt-0.5 font-sans">
                  مصدر جميع المؤشرات التاريخية المعتمدة • قاعدة معتمدة:{' '}
                  <span className="text-emerald-400 font-bold">Printed = تأكيد الأوردر</span>
                </p>
              </div>
            </div>
          </div>

          {/* Quick Presets & Calendar Mode Switcher */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="bg-slate-950 p-1 rounded-xl border border-slate-800 flex items-center gap-1 text-xs">
              <button
                onClick={handlePresetToday}
                className={`px-3 py-1.5 rounded-lg font-medium transition ${
                  activePreset === 'today'
                    ? 'bg-amber-500 text-slate-950 font-bold shadow'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                اليوم
              </button>
              <button
                onClick={handlePresetYesterday}
                className={`px-3 py-1.5 rounded-lg font-medium transition ${
                  activePreset === 'yesterday'
                    ? 'bg-amber-500 text-slate-950 font-bold shadow'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                أمس
              </button>
              <button
                onClick={handlePresetWeek}
                className={`px-3 py-1.5 rounded-lg font-medium transition ${
                  activePreset === 'week'
                    ? 'bg-amber-500 text-slate-950 font-bold shadow'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                آخر 7 أيام
              </button>
            </div>

            {/* Mode switch: Single Day vs Range */}
            <div className="bg-slate-950 p-1 rounded-xl border border-slate-800 flex items-center gap-1 text-xs font-sans">
              <button
                onClick={() => {
                  setCalendarMode('single');
                  setActivePreset('custom');
                }}
                className={`px-3 py-1.5 rounded-lg font-medium transition ${
                  calendarMode === 'single' && activePreset === 'custom'
                    ? 'bg-slate-800 text-amber-400 font-bold'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                يوم واحد
              </button>
              <button
                onClick={() => {
                  setCalendarMode('range');
                  setActivePreset('custom');
                }}
                className={`px-3 py-1.5 rounded-lg font-medium transition ${
                  calendarMode === 'range' && activePreset === 'custom'
                    ? 'bg-slate-800 text-amber-400 font-bold'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                أسبوع / نطاق
              </button>
            </div>

            {/* Arabic RTL Date Picker */}
            {calendarMode === 'single' ? (
              <DateCalendarPicker
                mode="single"
                value={singleDate}
                onChange={(d) => {
                  setSingleDate(d);
                  setActivePreset('custom');
                }}
                showPresets={false}
              />
            ) : (
              <DateCalendarPicker
                mode="range"
                startDate={startDate}
                endDate={endDate}
                onRangeChange={(s, e) => {
                  setStartDate(s);
                  setEndDate(e);
                  setActivePreset('custom');
                }}
                showPresets={false}
              />
            )}

            {/* Force Refresh / Sync Button */}
            <button
              onClick={() => fetchReport(effectiveStart, effectiveEnd, true)}
              disabled={isFetchingLogs}
              className="p-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700/60 transition disabled:opacity-50"
              title="إعادة فحص وجلب اللوجز الناقصة من Vendoor"
            >
              <RefreshCw className={`w-4 h-4 text-amber-400 ${isFetchingLogs ? 'animate-spin' : ''}`} />
            </button>

            {/* Batch Logs Import Button */}
            <button
              onClick={() => setShowImportModal(true)}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 border border-amber-500/30 text-xs font-semibold transition"
              title="استيراد لوجز Excel أو CSV متعددة الأيام"
            >
              <FileSpreadsheet className="w-4 h-4 text-amber-400" />
              <span>استيراد لوجز (Excel / CSV)</span>
            </button>

            {/* Copy Executive Summary */}
            <button
              onClick={handleCopySummary}
              disabled={!report || isFetchingLogs}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700/60 text-xs font-semibold transition disabled:opacity-50"
              title="نسخ التقرير التنفيذي بالعربية"
            >
              {copiedSummary ? (
                <>
                  <Check className="w-4 h-4 text-emerald-400" />
                  <span className="text-emerald-400">تم النسخ!</span>
                </>
              ) : (
                <>
                  <Copy className="w-4 h-4 text-amber-400" />
                  <span>نسخ التقرير</span>
                </>
              )}
            </button>
          </div>
        </div>

        {/* Period Details & Coverage Bar */}
        {report && (
          <div className="mt-4 pt-4 border-t border-slate-800/80 flex flex-wrap items-center justify-between gap-3 text-xs">
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-slate-400">الفترة المعتمدة:</span>
              <span className="px-2.5 py-1 rounded-lg bg-slate-950 font-mono text-amber-300 font-bold border border-slate-800">
                {report.periodLabel}
              </span>
              <span className="text-slate-500 font-mono text-[11px]">
                [{report.cairoInterval.startCairo.replace('T', ' ').slice(0, 19)} إلى{' '}
                {report.cairoInterval.endExclusiveCairo.replace('T', ' ').slice(0, 19)})
              </span>
            </div>

            <div className="flex items-center gap-3">
              {/* Coverage Badge */}
              <div className="flex items-center gap-1.5">
                <span className="text-slate-400">التغطية:</span>
                {report.status === 'COMPLETE' ? (
                  <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-sans font-medium">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    {report.loadedFromCache ? 'مكتمل (بيانات مخزنة)' : 'مكتمل من Vendoor'}
                  </span>
                ) : report.status === 'PARTIAL' ? (
                  <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/20 font-sans font-medium">
                    <AlertTriangle className="w-3.5 h-3.5" />
                    تغطية جزئية ({report.coverage.completeDays}/{report.coverage.totalDays} يوم)
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-rose-500/10 text-rose-400 border border-rose-500/20 font-sans font-medium">
                    <XCircle className="w-3.5 h-3.5" />
                    غير مكتملة
                  </span>
                )}
              </div>

              {report.coverage.pagesRead > 0 && (
                <span className="text-slate-400 font-mono">
                  الصفحات: <strong className="text-slate-200">{report.coverage.pagesRead}</strong>
                </span>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Day Provenance & Resolution Status Banner */}
      {dayStatus && (
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 shadow-lg text-xs animate-in fade-in duration-300">
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
            {/* Title & Provenance Badges */}
            <div className="flex flex-wrap items-center gap-3">
              <div className="p-2 rounded-xl bg-slate-800 text-amber-400 border border-slate-700/60">
                <Database className="w-5 h-5" />
              </div>
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-bold text-slate-100 text-sm">سجل اليوم الموحد ({dayStatus.date})</span>

                  {/* Data Source Badge */}
                  <span
                    className={`px-2.5 py-0.5 rounded-full text-[11px] font-sans font-medium border ${
                      dayStatus.dataSource === 'EXCEL_IMPORT' || dayStatus.dataSource === 'CSV_IMPORT'
                        ? 'bg-purple-500/10 text-purple-300 border-purple-500/30'
                        : dayStatus.dataSource === 'SUPABASE_ARCHIVE'
                        ? 'bg-sky-500/10 text-sky-300 border-sky-500/30'
                        : dayStatus.dataSource === 'VENDOOR_FETCH'
                        ? 'bg-amber-500/10 text-amber-300 border-amber-500/30'
                        : 'bg-slate-800 text-slate-400 border-slate-700'
                    }`}
                  >
                    {dayStatus.dataSource === 'EXCEL_IMPORT'
                      ? 'ملف Excel مستورد'
                      : dayStatus.dataSource === 'CSV_IMPORT'
                      ? 'ملف CSV مستورد'
                      : dayStatus.dataSource === 'SUPABASE_ARCHIVE'
                      ? 'أرشيف Supabase البعيد'
                      : dayStatus.dataSource === 'VENDOOR_FETCH'
                      ? 'جلب Vendoor المباشر'
                      : 'مصدر غير مسجل'}
                  </span>

                  {/* Completion Status Badge */}
                  <span
                    className={`px-2.5 py-0.5 rounded-full text-[11px] font-sans font-medium border ${
                      dayStatus.completionStatus === 'COMPLETE'
                        ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                        : dayStatus.completionStatus === 'UNVERIFIED_SOURCE'
                        ? 'bg-amber-500/10 text-amber-300 border-amber-500/30'
                        : dayStatus.completionStatus === 'EMPTY_VERIFIED'
                        ? 'bg-blue-500/10 text-blue-300 border-blue-500/30'
                        : 'bg-rose-500/10 text-rose-300 border-rose-500/30'
                    }`}
                  >
                    {dayStatus.completionStatus === 'COMPLETE'
                      ? '✅ مكتمل وموثق'
                      : dayStatus.completionStatus === 'UNVERIFIED_SOURCE'
                      ? '⚠️ اكتمال المصدر غير مؤكد'
                      : dayStatus.completionStatus === 'EMPTY_VERIFIED'
                      ? 'ℹ️ يوم فارغ تم التحقق منه'
                      : dayStatus.completionStatus === 'PARTIAL'
                      ? '⚠️ تغطية جزئية'
                      : '❌ غير مكتمل'}
                  </span>
                </div>
                <p className="text-[11px] text-slate-400 mt-1 font-sans">
                  {dayStatus.messageAr}
                </p>
              </div>
            </div>

            {/* Counts, Remote Status, and Explicit User Actions */}
            <div className="flex flex-wrap items-center gap-2.5">
              <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-slate-950 border border-slate-800 font-mono text-xs">
                <span className="text-slate-400">حركات خام:</span>
                <span className="text-amber-300 font-bold">{dayStatus.rawRecordsCount.toLocaleString()}</span>
              </div>
              <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-slate-950 border border-slate-800 font-mono text-xs">
                <span className="text-slate-400">أحداث معيارية:</span>
                <span className="text-emerald-400 font-bold">{dayStatus.canonicalEventsCount.toLocaleString()}</span>
              </div>
              <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-slate-950 border border-slate-800 text-xs">
                <span className="text-slate-400">Supabase:</span>
                <span
                  className={
                    dayStatus.remoteArchiveStatus === 'REMOTE_VERIFIED'
                      ? 'text-emerald-400 font-medium'
                      : 'text-amber-400 font-medium'
                  }
                >
                  {dayStatus.remoteArchiveStatus === 'REMOTE_VERIFIED'
                    ? 'مؤرشف ومتحقق منه'
                    : dayStatus.remoteArchiveStatus === 'PENDING_REMOTE'
                    ? 'قيد المزامنة'
                    : dayStatus.remoteArchiveStatus === 'REMOTE_FAILED'
                    ? 'فشلت المزامنة'
                    : 'محلي فقط'}
                </span>
              </div>

              {/* Action buttons */}
              <div className="flex items-center gap-1.5 mr-auto lg:mr-0">
                {(dayStatus.completionStatus === 'PARTIAL' ||
                  dayStatus.completionStatus === 'UNVERIFIED_SOURCE') && (
                  <button
                    onClick={() => handleDayAction('complete_missing')}
                    disabled={dayActionLoading}
                    className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 border border-amber-500/30 text-xs font-semibold transition disabled:opacity-50"
                    title="جلب الصفحات الناقصة فقط من Vendoor دون مسح البيانات الحالية"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${dayActionLoading ? 'animate-spin' : ''}`} />
                    <span>استكمال اليوم من Vendoor</span>
                  </button>
                )}

                <button
                  onClick={() => handleDayAction('recheck')}
                  disabled={dayActionLoading}
                  className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 text-xs font-medium transition disabled:opacity-50"
                  title="إعادة فحص حالة اليوم"
                >
                  <span>إعادة فحص</span>
                </button>

                <button
                  onClick={() => handleDayAction('reconcile')}
                  disabled={dayActionLoading}
                  className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 text-xs font-semibold transition disabled:opacity-50"
                  title="مطابقة السجلات مع أرشيف Supabase واسترجاع أي سجلات ناقصة تلقائياً"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${dayActionLoading ? 'animate-spin' : ''}`} />
                  <span>مطابقة واسترجاع الأرشيف</span>
                </button>

                {dayStatus.remoteArchiveStatus !== 'REMOTE_VERIFIED' && (
                  <button
                    onClick={() => handleDayAction('sync_supabase')}
                    disabled={dayActionLoading}
                    className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-sky-500/10 hover:bg-sky-500/20 text-sky-300 border border-sky-500/30 text-xs font-medium transition disabled:opacity-50"
                    title="مزامنة بيانات اليوم إلى Supabase"
                  >
                    <span>مزامنة للأرشيف</span>
                  </button>
                )}

                <button
                  onClick={() => handleDayAction('force_refetch')}
                  disabled={dayActionLoading}
                  className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-rose-500/10 hover:bg-rose-500/20 text-rose-300 border border-rose-500/30 text-xs font-medium transition disabled:opacity-50"
                  title="إعادة سحب اليوم كاملاً من Vendoor"
                >
                  <span>إعادة سحب كامل</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 2. THE ANIMATED INFINITY LOADING INDICATOR (∞) */}
      {isFetchingLogs && (
        <div className="bg-slate-900/90 border border-amber-500/30 rounded-2xl p-6 shadow-2xl backdrop-blur-md flex flex-col items-center justify-center text-center animate-in fade-in duration-300">
          {/* Animated Lemniscate SVG */}
          <div className="relative mb-3 flex items-center justify-center animate-infinity-glow">
            <svg
              className="w-24 h-14"
              viewBox="0 0 100 60"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              {/* Background trace */}
              <path
                d="M 30,30 C 15,10 5,20 5,30 C 5,40 15,50 30,30 C 45,10 55,10 70,30 C 85,50 95,40 95,30 C 95,20 85,10 70,30 C 55,50 45,50 30,30 Z"
                stroke="currentColor"
                className="text-amber-500/20"
                strokeWidth="6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              {/* Glowing animated stroke */}
              <path
                d="M 30,30 C 15,10 5,20 5,30 C 5,40 15,50 30,30 C 45,10 55,10 70,30 C 85,50 95,40 95,30 C 95,20 85,10 70,30 C 55,50 45,50 30,30 Z"
                stroke="url(#infinityGradient)"
                strokeWidth="6"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="animate-infinity-path"
              />
              <defs>
                <linearGradient id="infinityGradient" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor="#f59e0b" />
                  <stop offset="50%" stopColor="#38bdf8" />
                  <stop offset="100%" stopColor="#f59e0b" />
                </linearGradient>
              </defs>
            </svg>
          </div>

          <div className="space-y-1.5">
            <h3 className="text-base font-bold text-amber-300 font-sans">
              {jobStatus?.stageLabelAr || 'جاري فحص وتجهيز تقرير اللوجز...'}
            </h3>
            <p className="text-xs text-slate-400 font-sans max-w-md">
              يفحص النظام اللوجز المحفوظة محلياً ويجلب الصفحات الناقصة من Vendoor مباشرةً لضمان دقة المؤشرات التاريخية
            </p>
            {jobStatus && jobStatus.pagesTotal > 0 && jobStatus.pagesFetched > 0 && (
              <div className="pt-2 flex items-center justify-center gap-3 text-xs font-mono text-slate-300">
                <span className="px-2 py-0.5 rounded bg-slate-950 border border-slate-800">
                  الصفحة {jobStatus.pagesFetched} من {jobStatus.pagesTotal}
                </span>
                <span className="px-2 py-0.5 rounded bg-slate-950 border border-slate-800 text-emerald-400">
                  {jobStatus.eventsSaved.toLocaleString()} حركة محفوظة
                </span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 3. EXECUTIVE QUESTIONS & ANSWERS KPI CARDS (CLICKABLE FOR DRILLDOWN) */}
      {report && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
          {/* Card 1: What happened? Total Logs & Unique Orders Touched */}
          <div
            onClick={() => setDrilldownPillar('all')}
            className="bg-slate-900 border border-slate-800 hover:border-slate-700 p-5 rounded-2xl shadow-lg cursor-pointer transition transform hover:-translate-y-0.5 group"
          >
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-slate-400 font-sans font-semibold">ماذا حدث في الفترة؟</span>
              <div className="p-2 rounded-xl bg-slate-800 text-slate-300 group-hover:text-amber-400 transition">
                <Activity className="w-5 h-5" />
              </div>
            </div>
            <div className="text-2xl font-black text-slate-100 font-mono">
              {report.metrics.totalLogs.toLocaleString()}
            </div>
            <div className="mt-2 pt-2 border-t border-slate-800/80 flex items-center justify-between text-xs">
              <span className="text-slate-400 font-sans">أوردرات شهدت نشاطاً:</span>
              <span className="font-bold text-amber-400 font-mono">
                {report.metrics.uniqueOrdersTouched.toLocaleString()} طلب
              </span>
            </div>
          </div>

          {/* Card 2: Created Orders */}
          <div
            onClick={() => setDrilldownPillar('created')}
            className="bg-slate-900 border border-slate-800 hover:border-sky-500/40 p-5 rounded-2xl shadow-lg cursor-pointer transition transform hover:-translate-y-0.5 group"
          >
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-sky-400 font-sans font-semibold">كم أوردر تم إنشاؤه؟</span>
              <div className="p-2 rounded-xl bg-sky-500/10 text-sky-400 border border-sky-500/20 group-hover:bg-sky-500/20 transition">
                <TrendingUp className="w-5 h-5" />
              </div>
            </div>
            <div className="text-2xl font-black text-sky-300 font-mono">
              {report.metrics.createdOrdersCount.toLocaleString()}
            </div>
            <div className="mt-2 pt-2 border-t border-slate-800/80 flex items-center justify-between text-xs">
              <span className="text-slate-400 font-sans">إجمالي أحداث الإنشاء:</span>
              <span className="font-bold text-slate-300 font-mono">
                {report.metrics.createdEventsCount.toLocaleString()} حدث
              </span>
            </div>
          </div>

          {/* Card 3: Confirmed Orders (RULE: Printed = التأكيد) */}
          <div
            onClick={() => setDrilldownPillar('confirmed')}
            className="bg-slate-900 border border-emerald-500/30 hover:border-emerald-500/60 p-5 rounded-2xl shadow-lg cursor-pointer transition transform hover:-translate-y-0.5 group relative overflow-hidden"
          >
            <div className="absolute top-0 right-0 left-0 h-1 bg-emerald-500" />
            <div className="flex items-center justify-between mb-2">
              <div>
                <span className="text-xs text-emerald-400 font-sans font-bold">كم أوردر تم تأكيده؟</span>
                <span className="block text-[10px] text-slate-400">حالة Printed = تأكيد</span>
              </div>
              <div className="p-2 rounded-xl bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 group-hover:bg-emerald-500/20 transition">
                <CheckCircle2 className="w-5 h-5" />
              </div>
            </div>
            <div className="text-2xl font-black text-emerald-300 font-mono">
              {report.metrics.confirmedOrdersCount.toLocaleString()}
            </div>
            <div className="mt-2 pt-2 border-t border-slate-800/80 flex items-center justify-between text-xs">
              <span className="text-slate-400 font-sans">أحداث الطباعة والتأكيد:</span>
              <span className="font-bold text-emerald-400 font-mono">
                {report.metrics.printedEventsCount.toLocaleString()} حركة
              </span>
            </div>
          </div>

          {/* Card 4: Canceled Orders (Strictly Canceled, Canceling separated) */}
          <div
            onClick={() => setDrilldownPillar('canceled')}
            className="bg-slate-900 border border-slate-800 hover:border-rose-500/40 p-5 rounded-2xl shadow-lg cursor-pointer transition transform hover:-translate-y-0.5 group"
          >
            <div className="flex items-center justify-between mb-2">
              <div>
                <span className="text-xs text-rose-400 font-sans font-semibold">كم أوردر تم إلغاؤه؟</span>
                <span className="block text-[10px] text-slate-400">حالة Canceled المؤكدة</span>
              </div>
              <div className="p-2 rounded-xl bg-rose-500/10 text-rose-400 border border-rose-500/20 group-hover:bg-rose-500/20 transition">
                <XCircle className="w-5 h-5" />
              </div>
            </div>
            <div className="text-2xl font-black text-rose-400 font-mono">
              {report.metrics.canceledOrdersCount.toLocaleString()}
            </div>
            <div className="mt-2 pt-2 border-t border-slate-800/80 flex flex-col gap-1 text-xs">
              <div className="flex items-center justify-between">
                <span className="text-slate-400 font-sans">حركات الإلغاء النهائي:</span>
                <span className="font-bold text-rose-400 font-mono">
                  {report.metrics.canceledEventsCount.toLocaleString()} حركة
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-400 font-sans">قيد الإلغاء (معزول):</span>
                <span className="font-bold text-amber-400 font-mono">
                  {report.metrics.cancelingEventsCount.toLocaleString()} طلب
                </span>
              </div>
            </div>
          </div>

          {/* Card 5: Extra Phones Added */}
          <div
            onClick={() => setDrilldownPillar('extra_phone')}
            className="bg-slate-900 border border-slate-800 hover:border-cyan-500/40 p-5 rounded-2xl shadow-lg cursor-pointer transition transform hover:-translate-y-0.5 group"
          >
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-cyan-400 font-sans font-semibold">كم رقم إضافي أُضيف؟</span>
              <div className="p-2 rounded-xl bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 group-hover:bg-cyan-500/20 transition">
                <Phone className="w-5 h-5" />
              </div>
            </div>
            <div className="text-2xl font-black text-cyan-300 font-mono">
              {report.metrics.extraPhonesAddedUniqueOrders.toLocaleString()}
            </div>
            <div className="mt-2 pt-2 border-t border-slate-800/80 flex items-center justify-between text-xs">
              <span className="text-slate-400 font-sans">إجمالي الإضافات:</span>
              <span className="font-bold text-slate-300 font-mono">
                {report.metrics.extraPhonesAddedEvents.toLocaleString()} حركة
              </span>
            </div>
          </div>
        </div>
      )}

      {/* 4. Navigation Tabs */}
      <div className="border-b border-slate-800 flex items-center gap-2 overflow-x-auto text-xs font-sans">
        <button
          onClick={() => setActiveTab('overview')}
          className={`pb-3 px-4 font-bold border-b-2 transition flex items-center gap-2 ${
            activeTab === 'overview'
              ? 'border-amber-400 text-amber-400'
              : 'border-transparent text-slate-400 hover:text-slate-200'
          }`}
        >
          <BarChart3 className="w-4 h-4" />
          النظرة العامة والتحليل
        </button>

        {report && report.days.length > 1 && (
          <button
            onClick={() => setActiveTab('daily_breakdown')}
            className={`pb-3 px-4 font-bold border-b-2 transition flex items-center gap-2 ${
              activeTab === 'daily_breakdown'
                ? 'border-amber-400 text-amber-400'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Calendar className="w-4 h-4" />
            المقارنة اليومية للأسبوع ({report.days.length} أيام)
          </button>
        )}

        <button
          onClick={() => setActiveTab('employees')}
          className={`pb-3 px-4 font-bold border-b-2 transition flex items-center gap-2 ${
            activeTab === 'employees'
              ? 'border-amber-400 text-amber-400'
              : 'border-transparent text-slate-400 hover:text-slate-200'
          }`}
        >
          <Users className="w-4 h-4" />
          نشاط الموظفين ({report?.employees.length || 0})
        </button>

        <button
          onClick={() => setActiveTab('transitions')}
          className={`pb-3 px-4 font-bold border-b-2 transition flex items-center gap-2 ${
            activeTab === 'transitions'
              ? 'border-amber-400 text-amber-400'
              : 'border-transparent text-slate-400 hover:text-slate-200'
          }`}
        >
          <ArrowRightLeft className="w-4 h-4" />
          تغييرات الحالات ({report?.transitions.length || 0})
        </button>

        <button
          onClick={() => setActiveTab('admin_edits')}
          className={`pb-3 px-4 font-bold border-b-2 transition flex items-center gap-2 ${
            activeTab === 'admin_edits'
              ? 'border-amber-400 text-amber-400'
              : 'border-transparent text-slate-400 hover:text-slate-200'
          }`}
        >
          <FileText className="w-4 h-4" />
          التعديلات الإدارية ({report?.administrativeEdits.length || 0})
        </button>

        <button
          onClick={() => setActiveTab('unresolved')}
          className={`pb-3 px-4 font-bold border-b-2 transition flex items-center gap-2 ${
            activeTab === 'unresolved'
              ? 'border-purple-400 text-purple-400'
              : 'border-transparent text-slate-400 hover:text-slate-200'
          }`}
        >
          <ShieldAlert className="w-4 h-4" />
          حركات للمراجعة ({report?.unresolvedActions.length || 0})
        </button>
      </div>

      {/* 5. Tab Content */}
      {report && (
        <div>
          {/* Tab 1: Overview */}
          {activeTab === 'overview' && (
            <div className="space-y-6">
              {/* Operational Statuses Summary Table */}
              <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-xl">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-sm font-bold text-slate-100 flex items-center gap-2 font-sans">
                    <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                    <span>ملخص الحركات والقرارات التشغيلية للفترة</span>
                  </h3>
                  <span className="text-xs text-slate-500 font-mono">
                    القاعدة: Printed = تأكيد الأوردر
                  </span>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs font-sans">
                  <div className="p-4 rounded-xl bg-slate-950 border border-slate-800">
                    <div className="text-slate-400 mb-1">نسبة التأكيد الموثقة (Printed)</div>
                    <div className="text-2xl font-black text-emerald-400 font-mono">
                      {report.metrics.createdOrdersCount > 0
                        ? `${Math.round(
                            (report.metrics.confirmedOrdersCount / report.metrics.createdOrdersCount) * 100
                          )}%`
                        : '—'}
                    </div>
                    <p className="text-[11px] text-slate-500 mt-1">
                      محسوبة من وصول الأوردر لحالة Printed قياساً على المنشأ
                    </p>
                  </div>

                  <div className="p-4 rounded-xl bg-slate-950 border border-slate-800">
                    <div className="text-slate-400 mb-1">نسبة الإلغاء النهائي (Canceled)</div>
                    <div className="text-2xl font-black text-rose-400 font-mono">
                      {report.metrics.createdOrdersCount > 0
                        ? `${Math.round(
                            (report.metrics.canceledOrdersCount / report.metrics.createdOrdersCount) * 100
                          )}%`
                        : '—'}
                    </div>
                    <p className="text-[11px] text-slate-500 mt-1">
                      حركات Canceled المثبتة في اللوجز فقط
                    </p>
                  </div>

                  <div className="p-4 rounded-xl bg-slate-950 border border-slate-800">
                    <div className="text-slate-400 mb-1">معدل تكرار الحركات على الأوردر الواحد</div>
                    <div className="text-2xl font-black text-amber-400 font-mono">
                      {report.metrics.uniqueOrdersTouched > 0
                        ? (report.metrics.totalLogs / report.metrics.uniqueOrdersTouched).toFixed(1)
                        : '0'}
                    </div>
                    <p className="text-[11px] text-slate-500 mt-1">
                      متوسط عدد العمليات المسجلة لكل أوردر خضع للنشاط
                    </p>
                  </div>
                </div>
              </div>

              {/* Day-by-Day comparison table if multiple days */}
              {report.days.length > 1 && (
                <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-xl">
                  <div className="flex items-center justify-between mb-4">
                    <div>
                      <h3 className="text-sm font-bold text-slate-100 flex items-center gap-2 font-sans">
                        <Calendar className="w-4 h-4 text-amber-400" />
                        <span>جدول المقارنة اليومية للأسبوع</span>
                      </h3>
                      <p className="text-xs text-slate-400 mt-0.5">
                        إجمالي الأوردرات الفريدة للأسبوع ككل:{' '}
                        <strong className="text-amber-400 font-mono">
                          {report.metrics.uniqueOrdersTouched.toLocaleString()}
                        </strong>{' '}
                        (محسوب من الأكواد الفريدة في الأسبوع بالكامل وليس جمع الأيام)
                      </p>
                    </div>
                  </div>

                  <div className="overflow-x-auto rounded-xl border border-slate-800">
                    <table className="w-full text-right text-xs">
                      <thead>
                        <tr className="bg-slate-950 text-slate-400 border-b border-slate-800 font-sans">
                          <th className="py-3 px-4">اليوم والتاريخ</th>
                          <th className="py-3 px-4">إجمالي اللوجز</th>
                          <th className="py-3 px-4">طلبات منشأة</th>
                          <th className="py-3 px-4">مؤكدة (Printed)</th>
                          <th className="py-3 px-4">ملغاة (Canceled)</th>
                          <th className="py-3 px-4">هواتف إضافية</th>
                          <th className="py-3 px-4">كادر العمليات</th>
                          <th className="py-3 px-4">حالة التغطية</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800/60 font-mono">
                        {report.days.map((day) => (
                          <tr key={day.date} className="hover:bg-slate-800/30 transition">
                            <td className="py-3 px-4 font-bold text-slate-200 font-sans">
                              {day.dayNameAr} ({day.date})
                            </td>
                            <td className="py-3 px-4 text-slate-300">
                              {day.totalLogs.toLocaleString()}
                            </td>
                            <td className="py-3 px-4 font-bold text-sky-400">
                              {day.createdOrdersCount.toLocaleString()}
                            </td>
                            <td className="py-3 px-4 font-bold text-emerald-400">
                              {day.confirmedOrdersCount.toLocaleString()}
                            </td>
                            <td className="py-3 px-4 font-bold text-rose-400">
                              {day.canceledOrdersCount.toLocaleString()}
                            </td>
                            <td className="py-3 px-4 font-bold text-cyan-400">
                              {day.extraPhonesAddedCount.toLocaleString()}
                            </td>
                            <td className="py-3 px-4 text-slate-300">
                              {day.activeEmployeesCount} موظف
                            </td>
                            <td className="py-3 px-4 font-sans">
                              {day.coverageStatus === 'COMPLETE' ? (
                                <span className="px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 text-[11px]">
                                  مكتملة
                                </span>
                              ) : (
                                <span className="px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/20 text-[11px]">
                                  جزئية
                                </span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Recent Events Sample */}
              <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-xl">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-sm font-bold text-slate-100 flex items-center gap-2 font-sans">
                    <Clock className="w-4 h-4 text-amber-400" />
                    <span>آخر الحركات المصدرية المسجلة بالفترة (معاينة حية)</span>
                  </h3>
                  <button
                    onClick={() => setDrilldownPillar('all')}
                    className="text-xs text-amber-400 hover:text-amber-300 transition flex items-center gap-1 font-sans"
                  >
                    عرض الكل في النافذة التفصيلية
                    <ChevronLeft className="w-4 h-4" />
                  </button>
                </div>

                <div className="overflow-x-auto rounded-xl border border-slate-800">
                  <table className="w-full text-right text-xs">
                    <thead>
                      <tr className="bg-slate-950 text-slate-400 border-b border-slate-800 font-sans">
                        <th className="py-2.5 px-3">التوقيت</th>
                        <th className="py-2.5 px-3">كود الطلب</th>
                        <th className="py-2.5 px-3">المنفذ</th>
                        <th className="py-2.5 px-3">نوع الحركة</th>
                        <th className="py-2.5 px-3">نص الحركة الأصلي الكامل</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/60 font-mono">
                      {report.recentEvents.slice(0, 10).map((ev) => (
                        <tr key={ev.id} className="hover:bg-slate-800/30 transition">
                          <td className="py-2 px-3 text-slate-400 whitespace-nowrap text-[11px]">
                            {ev.event_timestamp ? ev.event_timestamp.replace('T', ' ').slice(0, 19) : '—'}
                          </td>
                          <td className="py-2 px-3 font-bold text-amber-400">
                            {ev.order_code || 'عام'}
                          </td>
                          <td className="py-2 px-3 font-sans text-slate-300">
                            {ev.actor_name}
                          </td>
                          <td className="py-2 px-3 font-sans">
                            <span className="px-2 py-0.5 rounded bg-slate-800 text-slate-200 text-[11px]">
                              {ev.action_type}
                            </span>
                          </td>
                          <td className="py-2 px-3 font-sans text-slate-400 text-xs max-w-md break-words">
                            {ev.raw_action_text}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* Tab 2: Daily Breakdown (when in week mode) */}
          {activeTab === 'daily_breakdown' && (
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-xl space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-base font-bold text-slate-100 font-sans">
                    المقارنة اليومية الشاملة للأسبوع
                  </h3>
                  <p className="text-xs text-slate-400 mt-0.5 font-sans">
                    مقارنة يوم بيوم لكافة حركات الإنشاء، التأكيد عبر Printed، الإلغاء، والأرقام الإضافية
                  </p>
                </div>
              </div>

              <div className="overflow-x-auto rounded-xl border border-slate-800">
                <table className="w-full text-right text-xs">
                  <thead>
                    <tr className="bg-slate-950 text-slate-400 border-b border-slate-800 font-sans">
                      <th className="py-3 px-4">اليوم والتاريخ</th>
                      <th className="py-3 px-4">إجمالي اللوجز</th>
                      <th className="py-3 px-4">أوردرات شهدت نشاطاً</th>
                      <th className="py-3 px-4">منشأة جديدة</th>
                      <th className="py-3 px-4">مؤكدة (Printed)</th>
                      <th className="py-3 px-4">ملغاة (Canceled)</th>
                      <th className="py-3 px-4">هواتف إضافية</th>
                      <th className="py-3 px-4">الموظفين الفاعلين</th>
                      <th className="py-3 px-4">التغطية</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60 font-mono">
                    {report.days.map((day) => (
                      <tr key={day.date} className="hover:bg-slate-800/30 transition">
                        <td className="py-3 px-4 font-bold text-slate-100 font-sans">
                          {day.dayNameAr} ({day.date})
                        </td>
                        <td className="py-3 px-4 text-slate-300 font-bold">
                          {day.totalLogs.toLocaleString()}
                        </td>
                        <td className="py-3 px-4 text-amber-400 font-bold">
                          {day.uniqueOrdersTouched.toLocaleString()}
                        </td>
                        <td className="py-3 px-4 text-sky-400 font-bold">
                          {day.createdOrdersCount.toLocaleString()}
                        </td>
                        <td className="py-3 px-4 text-emerald-400 font-bold">
                          {day.confirmedOrdersCount.toLocaleString()}
                        </td>
                        <td className="py-3 px-4 text-rose-400 font-bold">
                          {day.canceledOrdersCount.toLocaleString()}
                        </td>
                        <td className="py-3 px-4 text-cyan-400 font-bold">
                          {day.extraPhonesAddedCount.toLocaleString()}
                        </td>
                        <td className="py-3 px-4 text-slate-300 font-sans">
                          {day.activeEmployeesCount} موظف
                        </td>
                        <td className="py-3 px-4 font-sans">
                          {day.coverageStatus === 'COMPLETE' ? (
                            <span className="px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 text-[11px]">
                              مكتملة
                            </span>
                          ) : (
                            <span className="px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/20 text-[11px]">
                              جزئية
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Tab 3: Employees Activity */}
          {activeTab === 'employees' && (
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-xl space-y-4">
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
                <div>
                  <h3 className="text-base font-bold text-slate-100 font-sans">
                    سجل نشاط وإنتاجية الموظفين وكادر العمليات
                  </h3>
                  <p className="text-xs text-slate-400 mt-0.5 font-sans">
                    محسوب حصراً من اللوجز المصدرية • انقر على أي سطر لفتح الحركات الأصلية للموظف
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <div className="bg-slate-950 p-1 rounded-xl border border-slate-800 flex items-center gap-1 text-xs">
                    <button
                      onClick={() => setEmployeeTypeFilter('ALL')}
                      className={`px-3 py-1 rounded-lg transition ${
                        employeeTypeFilter === 'ALL'
                          ? 'bg-slate-800 text-amber-400 font-bold'
                          : 'text-slate-400'
                      }`}
                    >
                      الكل ({report.employees.length})
                    </button>
                    <button
                      onClick={() => setEmployeeTypeFilter('STAFF')}
                      className={`px-3 py-1 rounded-lg transition ${
                        employeeTypeFilter === 'STAFF'
                          ? 'bg-slate-800 text-amber-400 font-bold'
                          : 'text-slate-400'
                      }`}
                    >
                      فريق العمل ({report.employees.filter((e) => e.is_system === 0).length})
                    </button>
                    <button
                      onClick={() => setEmployeeTypeFilter('SYSTEM')}
                      className={`px-3 py-1 rounded-lg transition ${
                        employeeTypeFilter === 'SYSTEM'
                          ? 'bg-slate-800 text-amber-400 font-bold'
                          : 'text-slate-400'
                      }`}
                    >
                      النظام والتكاملات ({report.employees.filter((e) => e.is_system === 1).length})
                    </button>
                  </div>

                  <div className="relative">
                    <Search className="w-3.5 h-3.5 text-slate-500 absolute right-3 top-2.5" />
                    <input
                      type="text"
                      value={employeeSearch}
                      onChange={(e) => setEmployeeSearch(e.target.value)}
                      placeholder="بحث عن موظف..."
                      className="bg-slate-950 border border-slate-800 rounded-xl pr-8 pl-3 py-1.5 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-amber-500"
                    />
                  </div>
                </div>
              </div>

              <div className="overflow-x-auto rounded-xl border border-slate-800">
                <table className="w-full text-right text-xs">
                  <thead>
                    <tr className="bg-slate-950 text-slate-400 border-b border-slate-800 font-sans">
                      <th className="py-3 px-4">#</th>
                      <th className="py-3 px-4">اسم المنفذ</th>
                      <th className="py-3 px-4">طبيعة المنفذ</th>
                      <th className="py-3 px-4">الحركات الفعلية</th>
                      <th className="py-3 px-4">أوردرات فريدة</th>
                      <th className="py-3 px-4">مؤكدة (Printed)</th>
                      <th className="py-3 px-4">ملغاة (Canceled)</th>
                      <th className="py-3 px-4">أرقام إضافية</th>
                      <th className="py-3 px-4">تكرار مستبعد</th>
                      <th className="py-3 px-4">توزيع الإجراءات</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60 font-mono">
                    {filteredEmployees.map((emp, idx) => (
                      <tr
                        key={emp.actor_name}
                        onClick={() => {
                          setDrilldownActor(emp.actor_name);
                          setDrilldownPillar('employee');
                        }}
                        className="hover:bg-slate-800/40 cursor-pointer transition group"
                        title="انقر لفتح سجل حركات هذا الموظف"
                      >
                        <td className="py-3 px-4 text-slate-500">{idx + 1}</td>
                        <td className="py-3 px-4 font-bold text-slate-100 font-sans group-hover:text-amber-400 transition">
                          {emp.actor_name}
                        </td>
                        <td className="py-3 px-4 font-sans">
                          {emp.is_system === 1 ? (
                            <span className="px-2 py-0.5 rounded-full bg-slate-800 text-slate-400 text-[11px]">
                              نظام / تلقائي
                            </span>
                          ) : (
                            <span className="px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-300 border border-amber-500/20 text-[11px] font-medium">
                              موظف بشري
                            </span>
                          )}
                        </td>
                        <td className="py-3 px-4 font-bold text-slate-200">
                          {emp.action_count.toLocaleString()}
                        </td>
                        <td className="py-3 px-4 font-bold text-amber-400">
                          {emp.unique_orders.toLocaleString()}
                        </td>
                        <td className="py-3 px-4 font-bold text-emerald-400">
                          {emp.confirmed_orders_count.toLocaleString()}
                        </td>
                        <td className="py-3 px-4 font-bold text-rose-400">
                          {emp.canceled_orders_count.toLocaleString()}
                        </td>
                        <td className="py-3 px-4 font-bold text-cyan-400">
                          {emp.extra_phones_added_count.toLocaleString()}
                        </td>
                        <td className="py-3 px-4 text-slate-400">
                          {emp.duplicate_events_count ? (
                            <span className="text-amber-500/90 font-mono text-[11px]">
                              {emp.duplicate_events_count} مستبعد
                            </span>
                          ) : (
                            <span className="text-slate-600 font-mono text-[11px]">0</span>
                          )}
                        </td>
                        <td className="py-3 px-4 font-sans">
                          <div className="flex flex-wrap gap-1">
                            {Object.entries(emp.actions_breakdown)
                              .slice(0, 3)
                              .map(([actionType, count]) => (
                                <span
                                  key={actionType}
                                  className="px-1.5 py-0.5 rounded bg-slate-950 text-slate-400 text-[10px] font-mono border border-slate-800"
                                >
                                  {actionType}: {count}
                                </span>
                              ))}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Tab 4: Status Transitions */}
          {activeTab === 'transitions' && (
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-xl space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-base font-bold text-slate-100 font-sans">
                    مصفوفة انتقالات وتغييرات الحالات
                  </h3>
                  <p className="text-xs text-slate-400 mt-0.5 font-sans">
                    جميع الحركات التي غيرت حالة الأوردر من حالة إلى أخرى مسجلة في اللوجز
                  </p>
                </div>
                <button
                  onClick={() => setDrilldownPillar('transitions')}
                  className="text-xs text-amber-400 hover:text-amber-300 font-sans flex items-center gap-1"
                >
                  فتح السجلات الكاملة
                  <ChevronLeft className="w-4 h-4" />
                </button>
              </div>

              <div className="overflow-x-auto rounded-xl border border-slate-800">
                <table className="w-full text-right text-xs">
                  <thead>
                    <tr className="bg-slate-950 text-slate-400 border-b border-slate-800 font-sans">
                      <th className="py-3 px-4">#</th>
                      <th className="py-3 px-4">من الحالة</th>
                      <th className="py-3 px-4">إلى الحالة</th>
                      <th className="py-3 px-4">عدد الحركات</th>
                      <th className="py-3 px-4">الطلبات الفريدة</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60 font-mono">
                    {report.transitions.map((t, idx) => (
                      <tr key={idx} className="hover:bg-slate-800/30 transition">
                        <td className="py-3 px-4 text-slate-500">{idx + 1}</td>
                        <td className="py-3 px-4 font-bold text-slate-400">{t.from_status}</td>
                        <td className="py-3 px-4 font-bold text-emerald-400">
                          <span className="px-2 py-0.5 rounded bg-emerald-950/60 border border-emerald-800/60">
                            {t.to_status}
                          </span>
                        </td>
                        <td className="py-3 px-4 font-bold text-slate-100">
                          {t.events_count.toLocaleString()}
                        </td>
                        <td className="py-3 px-4 font-bold text-amber-400">
                          {t.unique_orders.toLocaleString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Tab 5: Administrative Edits */}
          {activeTab === 'admin_edits' && (
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-xl space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-base font-bold text-slate-100 font-sans">
                    سجل التعديلات الإدارية
                  </h3>
                  <p className="text-xs text-slate-400 mt-0.5 font-sans">
                    تعديلات العناوين وأرقام الهواتف والبيانات المالية والتعيينات والملاحظات
                  </p>
                </div>
                <button
                  onClick={() => setDrilldownPillar('admin_edits')}
                  className="text-xs text-amber-400 hover:text-amber-300 font-sans flex items-center gap-1"
                >
                  فتح السجلات الكاملة
                  <ChevronLeft className="w-4 h-4" />
                </button>
              </div>

              <div className="overflow-x-auto rounded-xl border border-slate-800">
                <table className="w-full text-right text-xs">
                  <thead>
                    <tr className="bg-slate-950 text-slate-400 border-b border-slate-800 font-sans">
                      <th className="py-3 px-4">#</th>
                      <th className="py-3 px-4">نوع التعديل</th>
                      <th className="py-3 px-4">الحقل المعدل</th>
                      <th className="py-3 px-4">عدد الحركات</th>
                      <th className="py-3 px-4">الطلبات الفريدة</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60 font-mono">
                    {report.administrativeEdits.map((a, idx) => (
                      <tr key={idx} className="hover:bg-slate-800/30 transition">
                        <td className="py-3 px-4 text-slate-500">{idx + 1}</td>
                        <td className="py-3 px-4 font-bold text-indigo-400 font-sans">
                          {a.action_label_ar}
                        </td>
                        <td className="py-3 px-4 font-sans text-slate-300">{a.field_name}</td>
                        <td className="py-3 px-4 font-bold text-slate-100">
                          {a.events_count.toLocaleString()}
                        </td>
                        <td className="py-3 px-4 font-bold text-amber-400">
                          {a.unique_orders.toLocaleString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Tab 6: Unresolved Actions */}
          {activeTab === 'unresolved' && (
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-xl space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-base font-bold text-slate-100 font-sans flex items-center gap-2">
                    <ShieldAlert className="w-4 h-4 text-purple-400" />
                    <span>حركات غير محسومة أو تحتاج إلى مراجعة</span>
                  </h3>
                  <p className="text-xs text-slate-400 mt-0.5 font-sans">
                    سجلات اللوجز التي لم يُحسم تصنيفها تلقائياً للحفاظ عليها وعدم إهمال أي حركة
                  </p>
                </div>
                <button
                  onClick={() => setDrilldownPillar('unresolved')}
                  className="text-xs text-purple-400 hover:text-purple-300 font-sans flex items-center gap-1"
                >
                  فتح السجلات الكاملة
                  <ChevronLeft className="w-4 h-4" />
                </button>
              </div>

              <div className="overflow-x-auto rounded-xl border border-slate-800">
                <table className="w-full text-right text-xs">
                  <thead>
                    <tr className="bg-slate-950 text-slate-400 border-b border-slate-800 font-sans">
                      <th className="py-3 px-4">#</th>
                      <th className="py-3 px-4">كود الطلب</th>
                      <th className="py-3 px-4">المنفذ</th>
                      <th className="py-3 px-4">التوقيت</th>
                      <th className="py-3 px-4">نص الحركة الأصلي الكامل</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60 font-mono">
                    {report.unresolvedActions.map((u, idx) => (
                      <tr key={u.id || idx} className="hover:bg-slate-800/30 transition">
                        <td className="py-3 px-4 text-slate-500">{idx + 1}</td>
                        <td className="py-3 px-4 font-bold text-purple-400">{u.order_code || 'عام'}</td>
                        <td className="py-3 px-4 font-sans text-slate-300">{u.actor_name}</td>
                        <td className="py-3 px-4 text-slate-400 whitespace-nowrap text-[11px]">
                          {u.event_timestamp ? u.event_timestamp.replace('T', ' ').slice(0, 19) : '—'}
                        </td>
                        <td className="py-3 px-4 font-sans text-slate-300 max-w-lg break-words">
                          {u.raw_action_text}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* 6. Drilldown Modal */}
      <ReportKpiDrilldownModal
        isOpen={drilldownPillar !== null}
        onClose={() => {
          setDrilldownPillar(null);
          setDrilldownActor(undefined);
        }}
        pillar={drilldownPillar}
        actorName={drilldownActor}
        startDate={effectiveStart}
        endDate={effectiveEnd}
        periodLabel={report?.periodLabel || `${effectiveStart} إلى ${effectiveEnd}`}
        reportData={report}
        onSelectOrder={onSelectOrder}
      />

      {/* 7. Batch Logs Import Modal (Multi-day Excel / CSV) */}
      <BatchLogsImportModal
        isOpen={showImportModal}
        onClose={() => setShowImportModal(false)}
        onImportSuccess={() => {
          fetchReport(effectiveStart, effectiveEnd);
          if (effectiveStart === effectiveEnd || calendarMode === 'single') {
            fetchDayStatus(effectiveStart);
          }
        }}
        onSelectDateForReport={(date) => {
          setCalendarMode('single');
          setSingleDate(date);
          setActivePreset('custom');
        }}
      />
    </div>
  );
};
