import React, { useState } from 'react';
import {
  AlertTriangle,
  Clock,
  Printer,
  RotateCw,
  ShoppingBag,
  XCircle,
  FileSpreadsheet,
  CheckCircle2,
  Calendar,
  Layers,
  ChevronLeft,
  ChevronDown,
  Check,
  Play,
} from 'lucide-react';
import { DashboardStats } from '../types';
import { RiskDetailsModal, RiskType } from './RiskDetailsModal';

interface DashboardViewProps {
  stats: DashboardStats | null;
  selectedDate: string;
  onFilterStatus: (status: string) => void;
  onFilterConfirmationAge: (category: string) => void;
  onNavigateToPrintedTab: (subTab: 'all' | 'no_extra_phone' | 'multi_merchant' | 'low_delivery') => void;
  onNavigateToPending: () => void;
  onNavigateToProcessing: () => void;
  onNavigateToAlerts: () => void;
  onRefreshStats?: () => void;
}

export const DashboardView: React.FC<DashboardViewProps> = ({
  stats,
  selectedDate,
  onFilterStatus,
  onFilterConfirmationAge,
  onNavigateToPrintedTab,
  onNavigateToPending,
  onNavigateToProcessing,
  onNavigateToAlerts,
  onRefreshStats,
}) => {
  if (!stats) {
    return (
      <div className="p-8 flex items-center justify-center text-slate-500">
        <div className="flex items-center gap-2">
          <RotateCw className="w-5 h-5 animate-spin text-amber-500" />
          <span>جاري تحميل المؤشرات الحية...</span>
        </div>
      </div>
    );
  }

  const {
    currentCounts,
    confirmationAges,
    riskIndicators,
    todayActivity,
    pendingAge,
    processingAge,
    dayCumulative,
    todayLogsCoverage,
  } = stats;

  const [selectedRiskType, setSelectedRiskType] = useState<RiskType | null>(null);
  const [riskScope, setRiskScope] = useState<'today' | 'all'>('today');
  const [isRiskScopeOpen, setIsRiskScopeOpen] = useState(false);
  const [isResumingLogs, setIsResumingLogs] = useState(false);

  const handleResumeLogs = async () => {
    setIsResumingLogs(true);
    try {
      const res = await fetch('/api/sync/logs-resume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: selectedDate }),
      });
      if (res.ok) {
        onRefreshStats?.();
      }
    } catch (e) {
      console.error('Failed to resume logs:', e);
    } finally {
      setIsResumingLogs(false);
    }
  };

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      {/* Page Title & Subtitle with Business Date & Today Log Coverage */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-800 pb-4">
        <div>
          <h2 className="text-xl font-bold text-slate-100 flex items-center gap-2">
            <span>لوحة المؤشرات والعمليات</span>
            <span className="text-xs font-normal text-slate-500 font-mono">(Africa/Cairo)</span>
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            تاريخ التشغيل المعتمد: <span className="font-mono text-amber-400 font-bold">{selectedDate}</span> {stats.isToday ? '· (بيانات يومية كاملة من 00:00)' : '· (بيانات تاريخية محفوظة)'}
          </p>
        </div>

        {/* Today's Logs Retrieval & Parity Indicator */}
        {stats.isToday && todayLogsCoverage && (
          <div className="flex items-center gap-2 text-xs">
            {todayLogsCoverage.isSyncing || todayLogsCoverage.completionStatus === 'RUNNING' || isResumingLogs ? (
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-sky-500/10 border border-sky-500/20 text-sky-400">
                <RotateCw className="w-3.5 h-3.5 animate-spin" />
                <span>جاري استرداد سجلات اليوم من 00:00 (صفحة {todayLogsCoverage.pagesRead} من {todayLogsCoverage.pagesDiscovered || '...'})</span>
              </div>
            ) : todayLogsCoverage.completionStatus === 'COMPLETE' ? (
              <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 font-medium">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                <span>سجلات اليوم مكتملة ومطابقة من 00:00 · ({todayLogsCoverage.recordsSaved} حركة مسجلة)</span>
              </div>
            ) : todayLogsCoverage.completionStatus === 'PARTIAL' ? (
              <div className="flex flex-wrap items-center gap-2 px-3 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-400">
                <div className="flex items-center gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                  <span>تغطية جزئية لسجلات اليوم ({todayLogsCoverage.pagesRead} من {todayLogsCoverage.pagesDiscovered} صفحة)</span>
                </div>
                <button
                  onClick={handleResumeLogs}
                  disabled={isResumingLogs}
                  className="px-2.5 py-0.5 rounded bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 font-bold text-[11px] border border-amber-500/40 transition-colors flex items-center gap-1 cursor-pointer disabled:opacity-50"
                  title="استكمال جلب الصفحات المتبقية حتى اكتمال اليوم"
                >
                  <Play className="w-3 h-3 fill-current" />
                  <span>استكمال السحب الآن (صفحة {todayLogsCoverage.pagesRead + 1} إلى {todayLogsCoverage.pagesDiscovered})</span>
                </button>
              </div>
            ) : null}
          </div>
        )}
      </div>

      {/* 1. Primary Status Cards (Five Essential Business Groups + Canceled) */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
            <Layers className="w-3.5 h-3.5 text-amber-500" />
            <span>حالات الطلبات الأساسية {stats.isToday ? '(الرصيد المباشر الآن وحركات اليوم التراكمية من 00:00)' : `(نهاية يوم ${selectedDate})`}</span>
          </h3>
          <span className="text-[11px] text-slate-500">اضغط على أي بطاقة لعرض الطلبات المطابقة</span>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          {/* 1. New - Strictly Live snapshot */}
          <button
            onClick={() => onFilterStatus('New')}
            className="text-right p-4 rounded-xl bg-slate-900 border border-slate-800 hover:border-slate-700 hover:bg-slate-800/60 transition-all cursor-pointer group"
          >
            <div className="flex items-center justify-between text-xs text-slate-400 mb-2">
              <span className="font-medium text-slate-300">أوردر جديد</span>
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400 font-medium">Live مباشر</span>
            </div>
            <div className="text-2xl font-bold font-mono text-slate-100 group-hover:text-amber-400 transition-colors">
              {currentCounts.New}
            </div>
            <div className="mt-2 text-[11px] text-slate-500 flex items-center justify-between">
              <span>رصيد حالي بالنظام</span>
              <ChevronLeft className="w-3 h-3 group-hover:-translate-x-0.5 transition-transform" />
            </div>
          </button>

          {/* 2. Pending - Live balance + Day transitions */}
          <button
            onClick={() => onFilterStatus('Pending')}
            className="text-right p-4 rounded-xl bg-slate-900 border border-slate-800 hover:border-amber-500/30 hover:bg-slate-800/60 transition-all cursor-pointer group"
          >
            <div className="flex items-center justify-between text-xs text-amber-400 mb-2">
              <span className="font-medium">معلق</span>
              <span className="text-[11px] font-mono text-slate-500">Pending</span>
            </div>
            <div className="text-2xl font-bold font-mono text-amber-400">
              {currentCounts.Pending}
            </div>
            <div className="mt-1 text-[10px] text-amber-400/80 font-medium truncate">
              اليوم: {dayCumulative?.Pending?.uniqueOrders ?? todayActivity.Pending} طلب دخل الحالة
            </div>
            <div className="mt-1 text-[11px] text-slate-500 flex items-center justify-between">
              <span>رصيد حالي</span>
              <ChevronLeft className="w-3 h-3 group-hover:-translate-x-0.5 transition-transform" />
            </div>
          </button>

          {/* 3. Processing - Live balance + Day transitions */}
          <button
            onClick={() => onFilterStatus('Processing')}
            className="text-right p-4 rounded-xl bg-slate-900 border border-slate-800 hover:border-sky-500/30 hover:bg-slate-800/60 transition-all cursor-pointer group"
          >
            <div className="flex items-center justify-between text-xs text-sky-400 mb-2">
              <span className="font-medium">قيد التنفيذ</span>
              <span className="text-[11px] font-mono text-slate-500">Processing</span>
            </div>
            <div className="text-2xl font-bold font-mono text-sky-400">
              {currentCounts.Processing}
            </div>
            <div className="mt-1 text-[10px] text-sky-400/80 font-medium truncate">
              اليوم: {dayCumulative?.Processing?.uniqueOrders ?? todayActivity.Processing} طلب دخل الحالة
            </div>
            <div className="mt-1 text-[11px] text-slate-500 flex items-center justify-between">
              <span>رصيد حالي</span>
              <ChevronLeft className="w-3 h-3 group-hover:-translate-x-0.5 transition-transform" />
            </div>
          </button>

          {/* 4. Canceling - Live balance + Day transitions */}
          <button
            onClick={() => onFilterStatus('Canceling')}
            className="text-right p-4 rounded-xl bg-slate-900 border border-slate-800 hover:border-orange-500/30 hover:bg-slate-800/60 transition-all cursor-pointer group"
          >
            <div className="flex items-center justify-between text-xs text-orange-400 mb-2">
              <span className="font-medium">قيد الإلغاء</span>
              <span className="text-[11px] font-mono text-slate-500">Canceling</span>
            </div>
            <div className="text-2xl font-bold font-mono text-orange-400">
              {currentCounts.Canceling || 0}
            </div>
            <div className="mt-1 text-[10px] text-orange-400/80 font-medium truncate">
              اليوم: {dayCumulative?.Canceling?.uniqueOrders ?? todayActivity.Canceling} طلب قيد المراجعة
            </div>
            <div className="mt-1 text-[11px] text-slate-500 flex items-center justify-between">
              <span>رصيد حالي</span>
              <ChevronLeft className="w-3 h-3 group-hover:-translate-x-0.5 transition-transform" />
            </div>
          </button>

          {/* 5. Printed - Cumulative unique orders confirmed today */}
          <button
            onClick={() => onFilterStatus('Printed')}
            className={`text-right p-4 rounded-xl bg-slate-900 border transition-all cursor-pointer group ${
              stats.isToday && todayLogsCoverage?.completionStatus === 'PARTIAL'
                ? 'border-amber-500/40 hover:border-amber-500/60'
                : 'border-slate-800 hover:border-emerald-500/30'
            } hover:bg-slate-800/60`}
          >
            <div className="flex items-center justify-between text-xs text-emerald-400 mb-2">
              <span className="font-medium">مطبوع / مؤكد</span>
              {stats.isToday && todayLogsCoverage?.completionStatus === 'PARTIAL' ? (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30 font-mono font-medium">
                  ⚠️ جزئي ({todayLogsCoverage.pagesRead}/{todayLogsCoverage.pagesDiscovered} ص)
                </span>
              ) : stats.isToday && todayLogsCoverage?.completionStatus === 'FAILED' ? (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-rose-500/20 text-rose-300 border border-rose-500/30 font-mono font-medium">
                  ❌ توقف الاتصال
                </span>
              ) : (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400 font-mono">
                  تراكمي اليوم
                </span>
              )}
            </div>
            <div className={`text-2xl font-bold font-mono ${
              stats.isToday && todayLogsCoverage?.completionStatus === 'PARTIAL' ? 'text-amber-300' : 'text-emerald-400'
            }`}>
              {currentCounts.Printed}
            </div>
            <div className="mt-1 text-[10px] text-slate-400 font-medium truncate">
              {stats.isToday && todayLogsCoverage?.completionStatus === 'PARTIAL' ? (
                <span className="text-amber-400/90 font-medium">
                  تراكمي جزئي حتى ص {todayLogsCoverage.pagesRead} · قيد الاستكمال
                </span>
              ) : (
                <span className="text-emerald-400/80">
                  {dayCumulative?.Printed?.totalEvents ?? todayActivity.printedEvents ?? currentCounts.Printed} حركة تأكيد مسجلة
                </span>
              )}
            </div>
            <div className="mt-1 text-[11px] text-slate-500 flex items-center justify-between">
              <span>أوردرات مؤكدة اليوم</span>
              <ChevronLeft className="w-3 h-3 group-hover:-translate-x-0.5 transition-transform" />
            </div>
          </button>

          {/* 6. Canceled - Cumulative unique orders canceled today */}
          <button
            onClick={() => onFilterStatus('Canceled')}
            className={`text-right p-4 rounded-xl bg-slate-900 border transition-all cursor-pointer group ${
              stats.isToday && todayLogsCoverage?.completionStatus === 'PARTIAL'
                ? 'border-amber-500/40 hover:border-amber-500/60'
                : 'border-slate-800 hover:border-rose-500/30'
            } hover:bg-slate-800/60`}
          >
            <div className="flex items-center justify-between text-xs text-rose-400 mb-2">
              <span className="font-medium">ملغي نهائي</span>
              {stats.isToday && todayLogsCoverage?.completionStatus === 'PARTIAL' ? (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30 font-mono font-medium">
                  ⚠️ جزئي ({todayLogsCoverage.pagesRead}/{todayLogsCoverage.pagesDiscovered} ص)
                </span>
              ) : stats.isToday && todayLogsCoverage?.completionStatus === 'FAILED' ? (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-rose-500/20 text-rose-300 border border-rose-500/30 font-mono font-medium">
                  ❌ توقف الاتصال
                </span>
              ) : (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-rose-500/15 text-rose-400 font-mono">
                  تراكمي اليوم
                </span>
              )}
            </div>
            <div className={`text-2xl font-bold font-mono ${
              stats.isToday && todayLogsCoverage?.completionStatus === 'PARTIAL' ? 'text-amber-300' : 'text-rose-400'
            }`}>
              {currentCounts.Canceled}
            </div>
            <div className="mt-1 text-[10px] text-slate-400 font-medium truncate">
              {stats.isToday && todayLogsCoverage?.completionStatus === 'PARTIAL' ? (
                <span className="text-amber-400/90 font-medium">
                  تراكمي جزئي حتى ص {todayLogsCoverage.pagesRead} · قيد الاستكمال
                </span>
              ) : (
                <span className="text-rose-400/80">
                  {dayCumulative?.Canceled?.totalEvents ?? todayActivity.cancelEvents ?? currentCounts.Canceled} حركة إلغاء مسجلة
                </span>
              )}
            </div>
            <div className="mt-1 text-[11px] text-slate-500 flex items-center justify-between">
              <span>أوردرات أُلغيت اليوم</span>
              <ChevronLeft className="w-3 h-3 group-hover:-translate-x-0.5 transition-transform" />
            </div>
          </button>
        </div>
      </section>

      {/* 2. Critical Risk Indicators Section */}
      <section className="space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-rose-400 flex items-center gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 text-rose-400" />
              <span>مؤشرات المخاطر التشغيلية</span>
            </h3>
            <span className="text-[11px] text-slate-400">
              {riskScope === 'today'
                ? `عرض طلبات ${selectedDate || 'اليوم'} المؤكدة (Printed) فقط من منتصف الليل 00:00`
                : 'فحص شامل لكامل رصيد طلبات النظام المتراكمة في قاعدة البيانات'}
            </span>
          </div>

          {/* Quick Scope Dropdown List */}
          <div className="flex items-center gap-2 self-start sm:self-auto relative">
            <span className="text-xs text-slate-400 font-medium">نطاق المؤشرات:</span>
            <div className="relative">
              <button
                type="button"
                onClick={() => setIsRiskScopeOpen(!isRiskScopeOpen)}
                className={`flex items-center justify-between gap-3 px-3 py-1.5 rounded-lg bg-slate-900 border text-xs font-semibold shadow-sm transition-all cursor-pointer min-w-[210px] ${
                  isRiskScopeOpen
                    ? 'border-amber-500/70 ring-1 ring-amber-500/30 text-amber-300'
                    : 'border-slate-700 hover:border-slate-600 text-slate-200'
                }`}
              >
                <div className="flex items-center gap-2">
                  {riskScope === 'today' ? (
                    <Clock className="w-3.5 h-3.5 text-amber-400" />
                  ) : (
                    <Layers className="w-3.5 h-3.5 text-slate-400" />
                  )}
                  <span>{riskScope === 'today' ? `طلبات اليوم (${selectedDate || 'اليوم'})` : 'إجمالي النظام الشامل'}</span>
                </div>
                <ChevronDown className={`w-3.5 h-3.5 transition-transform duration-200 ${isRiskScopeOpen ? 'rotate-180 text-amber-400' : 'text-slate-400'}`} />
              </button>

              {/* Dropdown Menu Popup */}
              {isRiskScopeOpen && (
                <>
                  <div
                    className="fixed inset-0 z-40"
                    onClick={() => setIsRiskScopeOpen(false)}
                  />
                  <div className="absolute left-0 sm:right-auto sm:left-0 top-full mt-1.5 z-50 w-72 bg-slate-900 border border-slate-700 rounded-xl shadow-2xl overflow-hidden py-1 divide-y divide-slate-800/80 animate-in fade-in-0 zoom-in-95 duration-150">
                    <button
                      type="button"
                      onClick={() => {
                        setRiskScope('today');
                        setIsRiskScopeOpen(false);
                      }}
                      className={`w-full text-right p-2.5 flex items-start justify-between gap-3 transition-colors cursor-pointer ${
                        riskScope === 'today'
                          ? 'bg-amber-500/10 text-amber-300'
                          : 'hover:bg-slate-800/80 text-slate-300'
                      }`}
                    >
                      <div className="flex items-start gap-2.5">
                        <div className="mt-0.5 p-1 rounded bg-amber-500/20 text-amber-400 flex-shrink-0">
                          <Clock className="w-3.5 h-3.5" />
                        </div>
                        <div>
                          <div className="text-xs font-bold text-slate-100">
                            طلبات اليوم ({selectedDate || 'اليوم'})
                          </div>
                          <div className="text-[11px] text-slate-400 mt-0.5">
                            حصر الطلبات المؤكدة (Printed) اليوم من 00:00
                          </div>
                        </div>
                      </div>
                      {riskScope === 'today' && <Check className="w-4 h-4 text-amber-400 flex-shrink-0 mt-1" />}
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        setRiskScope('all');
                        setIsRiskScopeOpen(false);
                      }}
                      className={`w-full text-right p-2.5 flex items-start justify-between gap-3 transition-colors cursor-pointer ${
                        riskScope === 'all'
                          ? 'bg-slate-800 text-slate-100'
                          : 'hover:bg-slate-800/80 text-slate-300'
                      }`}
                    >
                      <div className="flex items-start gap-2.5">
                        <div className="mt-0.5 p-1 rounded bg-slate-800 text-slate-300 border border-slate-700 flex-shrink-0">
                          <Layers className="w-3.5 h-3.5" />
                        </div>
                        <div>
                          <div className="text-xs font-bold text-slate-100">
                            إجمالي النظام الشامل
                          </div>
                          <div className="text-[11px] text-slate-400 mt-0.5">
                            كافة طلبات النظام المتراكمة في قاعدة البيانات
                          </div>
                        </div>
                      </div>
                      {riskScope === 'all' && <Check className="w-4 h-4 text-slate-300 flex-shrink-0 mt-1" />}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          {/* Multi-Merchant Codes Alert */}
          <div
            onClick={() => setSelectedRiskType('multi_merchant')}
            className={`p-4 rounded-xl border transition-all cursor-pointer group ${
              (riskScope === 'today' ? riskIndicators.multiMerchantPrinted : (riskIndicators.multiMerchantTotal ?? 0)) > 0
                ? 'bg-rose-500/10 border-rose-500/40 hover:bg-rose-500/20 shadow-md shadow-rose-950/40'
                : 'bg-slate-900 border-slate-800 hover:border-slate-700'
            }`}
          >
            <div className="flex items-center justify-between text-xs text-rose-300 mb-2">
              <span className="font-bold flex items-center gap-1.5">
                <AlertTriangle className="w-4 h-4 text-rose-400" />
                <span>تعدد أكواد المخازن (Multi-Warehouse)</span>
              </span>
              <span className="text-[10px] text-rose-400 uppercase tracking-widest font-mono group-hover:underline">تفاصيل ↗</span>
            </div>
            <div className="text-2xl font-bold font-mono text-rose-400 tabular-nums">
              {riskScope === 'today'
                ? (riskIndicators.multiMerchantPrinted ?? 0)
                : (riskIndicators.multiMerchantTotal ?? riskIndicators.multiMerchantCount ?? 0)}
            </div>
            <div className="mt-1 text-[11px] font-mono text-slate-400 font-medium">
              {riskScope === 'today'
                ? `إجمالي النظام: ${riskIndicators.multiMerchantTotal ?? 0} طلب`
                : `اليوم: ${riskIndicators.multiMerchantPrinted ?? 0} مؤكد (Printed)`}
            </div>
            <p className="mt-1 text-[11px] text-slate-400 leading-relaxed">
              طلبات تحوي سلعًا من عدة مخازن وتتطلب تقسيم شحن • اضغط للتفاصيل
            </p>
          </div>

          {/* Missing Extra Phone */}
          <div
            onClick={() => setSelectedRiskType('no_extra_phone')}
            className="p-4 rounded-xl bg-slate-900 border border-slate-800 hover:border-amber-500/30 hover:bg-slate-800/60 transition-all cursor-pointer group"
          >
            <div className="flex items-center justify-between text-xs text-amber-400 mb-2">
              <span className="font-semibold">دون هاتف إضافي صالح</span>
              <span className="text-[10px] text-amber-400/80 font-mono group-hover:underline">تفاصيل ↗</span>
            </div>
            <div className="text-2xl font-bold font-mono text-amber-400 tabular-nums">
              {riskScope === 'today'
                ? (riskIndicators.missingExtraPhonePrinted ?? 0)
                : (riskIndicators.missingExtraPhoneTotal ?? riskIndicators.missingPhoneCount ?? 0)}
            </div>
            <div className="mt-1 text-[11px] font-mono text-slate-400 font-medium">
              {riskScope === 'today'
                ? `إجمالي النظام: ${riskIndicators.missingExtraPhoneTotal ?? 0} طلب`
                : `اليوم: ${riskIndicators.missingExtraPhonePrinted ?? 0} مؤكد (Printed)`}
            </div>
            <p className="mt-1 text-[11px] text-slate-400 leading-relaxed">
              {riskScope === 'today'
                ? 'طلبات تم تأكيدها اليوم دون تدوين هاتف بديل صالح'
                : 'إجمالي طلبات النظام المتراكمة دون هاتف إضافي صالح'} • اضغط للتفاصيل
            </p>
          </div>

          {/* Delivery Rate < 70% */}
          <div
            onClick={() => setSelectedRiskType('low_delivery')}
            className="p-4 rounded-xl bg-slate-900 border border-slate-800 hover:border-rose-500/30 hover:bg-slate-800/60 transition-all cursor-pointer group"
          >
            <div className="flex items-center justify-between text-xs text-rose-400 mb-2">
              <span className="font-semibold">نسبة تسليم أقل من 70%</span>
              <span className="text-[10px] text-rose-400/80 font-mono group-hover:underline">تفاصيل ↗</span>
            </div>
            <div className="text-2xl font-bold font-mono text-rose-400 tabular-nums">
              {riskScope === 'today'
                ? (riskIndicators.lowDeliveryRatePrinted ?? 0)
                : (riskIndicators.lowDeliveryRateTotal ?? riskIndicators.lowDeliveryCount ?? 0)}
            </div>
            <div className="mt-1 text-[11px] font-mono text-slate-400 font-medium">
              {riskScope === 'today'
                ? `إجمالي النظام: ${riskIndicators.lowDeliveryRateTotal ?? 0} طلب`
                : `اليوم: ${riskIndicators.lowDeliveryRatePrinted ?? 0} مؤكد (Printed)`}
            </div>
            <p className="mt-1 text-[11px] text-slate-400 leading-relaxed">
              عملاء لديهم سجل تاريخي بنسبة استلام &lt; 70% • اضغط للتفاصيل
            </p>
          </div>

          {/* Open Critical Alerts */}
          <div
            onClick={onNavigateToAlerts}
            className="p-4 rounded-xl bg-slate-900 border border-slate-800 hover:border-slate-700 hover:bg-slate-800/60 transition-all cursor-pointer"
          >
            <div className="flex items-center justify-between text-xs text-slate-300 mb-2">
              <span className="font-semibold">إجمالي التنبيهات المفتوحة</span>
              <span className="text-[10px] text-slate-500 font-mono">Alerts</span>
            </div>
            <div className="text-2xl font-bold font-mono text-slate-100 tabular-nums">
              {riskIndicators.openAlertsCount}
            </div>
            <p className="mt-1.5 text-[11px] text-slate-400 leading-relaxed">
              تنبيهات تنتظر المراجعة واتخاذ الإجراء من مشرف العمليات.
            </p>
          </div>
        </div>
      </section>

      {/* 3. Confirmation Age Pages & Today's Activity */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Confirmation Age Categories */}
        <section className="p-5 rounded-xl bg-slate-900 border border-slate-800 space-y-3">
          <div className="flex items-center justify-between border-b border-slate-800/60 pb-3">
            <h3 className="text-sm font-bold text-slate-200 flex items-center gap-2">
              <Calendar className="w-4 h-4 text-emerald-400" />
              <span>فئات عمر الطلبات المؤكدة (قوائم Vendoor الأصلية)</span>
            </h3>
            {confirmationAges.state === 'NOT_AVAILABLE' ? (
              <span className="text-[11px] font-medium text-amber-400 bg-amber-500/10 border border-amber-500/20 px-2 py-0.5 rounded">
                غير متوفر حالياً (انتهت المهلة)
              </span>
            ) : confirmationAges.state === 'STALE' ? (
              <span className="text-[11px] font-medium text-slate-400 bg-slate-800 px-2 py-0.5 rounded">
                قيمة سابقة محفوظة
              </span>
            ) : (
              <span className="text-xs text-slate-500">محدث من صفحات التأكيد</span>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3 pt-1">
            <button
              onClick={() => onFilterConfirmationAge('1_day')}
              disabled={confirmationAges.state === 'NOT_AVAILABLE'}
              className="p-3 text-right rounded-lg bg-slate-950/60 border border-slate-800/80 hover:border-slate-700 hover:bg-slate-800/40 transition-all cursor-pointer group disabled:cursor-not-allowed"
            >
              <div className="text-xs text-slate-400">مؤكدة منذ يوم</div>
              <div className="text-xl font-bold font-mono text-emerald-400 mt-1">
                {confirmationAges.state === 'NOT_AVAILABLE' ? '—' : confirmationAges['1_day']}
              </div>
            </button>

            <button
              onClick={() => onFilterConfirmationAge('2_days')}
              disabled={confirmationAges.state === 'NOT_AVAILABLE'}
              className="p-3 text-right rounded-lg bg-slate-950/60 border border-slate-800/80 hover:border-slate-700 hover:bg-slate-800/40 transition-all cursor-pointer group disabled:cursor-not-allowed"
            >
              <div className="text-xs text-slate-400">مؤكدة منذ يومين</div>
              <div className="text-xl font-bold font-mono text-emerald-400 mt-1">
                {confirmationAges.state === 'NOT_AVAILABLE' ? '—' : confirmationAges['2_days']}
              </div>
            </button>

            <button
              onClick={() => onFilterConfirmationAge('3_days')}
              disabled={confirmationAges.state === 'NOT_AVAILABLE'}
              className="p-3 text-right rounded-lg bg-slate-950/60 border border-slate-800/80 hover:border-slate-700 hover:bg-slate-800/40 transition-all cursor-pointer group disabled:cursor-not-allowed"
            >
              <div className="text-xs text-slate-400">مؤكدة منذ ثلاثة أيام</div>
              <div className="text-xl font-bold font-mono text-amber-400 mt-1">
                {confirmationAges.state === 'NOT_AVAILABLE' ? '—' : confirmationAges['3_days']}
              </div>
            </button>

            <button
              onClick={() => onFilterConfirmationAge('over_3_days')}
              disabled={confirmationAges.state === 'NOT_AVAILABLE'}
              className="p-3 text-right rounded-lg bg-slate-950/60 border border-slate-800/80 hover:border-slate-700 hover:bg-slate-800/40 transition-all cursor-pointer group disabled:cursor-not-allowed"
            >
              <div className="text-xs text-slate-400">مؤكدة منذ أكثر من 3 أيام</div>
              <div className="text-xl font-bold font-mono text-rose-400 mt-1">
                {confirmationAges.state === 'NOT_AVAILABLE' ? '—' : confirmationAges['over_3_days']}
              </div>
            </button>
          </div>
        </section>

        {/* Today's Activity Transitions */}
        <section className="p-5 rounded-xl bg-slate-900 border border-slate-800 space-y-3">
          <div className="flex items-center justify-between border-b border-slate-800/60 pb-3">
            <h3 className="text-sm font-bold text-slate-200 flex items-center gap-2">
              <Clock className="w-4 h-4 text-sky-400" />
              <span>مؤشرات النشاط اليومي (أحداث اليوم بتوقيت القاهرة)</span>
            </h3>
            <span className="text-xs text-slate-500">حسب وقت الحدث الأصلي</span>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 pt-1">
            <div className="p-3 rounded-lg bg-slate-950/60 border border-slate-800/80">
              <div className="text-xs text-slate-400">أُنشئت اليوم</div>
              <div className="text-xl font-bold font-mono text-slate-100 mt-1">
                {todayActivity.Created}
              </div>
              <div className="text-[11px] text-slate-500 mt-0.5">طلب فريد</div>
            </div>

            <div className="p-3 rounded-lg bg-slate-950/60 border border-slate-800/80">
              <div className="text-xs text-slate-400">دخلت Printed اليوم</div>
              <div className="text-xl font-bold font-mono text-emerald-400 mt-1">
                {todayActivity.Printed}
              </div>
              <div className="text-[11px] text-emerald-400/70 mt-0.5">
                طلب فريد {Boolean(todayActivity.printedEvents) && `· (${todayActivity.printedEvents} حركة)`}
              </div>
            </div>

            <div className="p-3 rounded-lg bg-slate-950/60 border border-slate-800/80">
              <div className="text-xs text-slate-400">دخلت Pending اليوم</div>
              <div className="text-xl font-bold font-mono text-amber-400 mt-1">
                {todayActivity.Pending}
              </div>
              <div className="text-[11px] text-amber-400/70 mt-0.5">
                طلب فريد {Boolean(todayActivity.pendingEvents) && `· (${todayActivity.pendingEvents} حركة)`}
              </div>
            </div>

            <div className="p-3 rounded-lg bg-slate-950/60 border border-slate-800/80">
              <div className="text-xs text-slate-400">دخلت Processing اليوم</div>
              <div className="text-xl font-bold font-mono text-sky-400 mt-1">
                {todayActivity.Processing}
              </div>
              <div className="text-[11px] text-sky-400/70 mt-0.5">
                طلب فريد {Boolean(todayActivity.processingEvents) && `· (${todayActivity.processingEvents} حركة)`}
              </div>
            </div>

            <div className="p-3 rounded-lg bg-slate-950/60 border border-slate-800/80">
              <div className="text-xs text-slate-400">أُلغيت اليوم</div>
              <div className="text-xl font-bold font-mono text-rose-400 mt-1">
                {todayActivity.Canceled}
              </div>
              <div className="text-[11px] text-rose-400/70 mt-0.5">
                طلب فريد {Boolean(todayActivity.cancelEvents) && `· (${todayActivity.cancelEvents} حركة)`}
              </div>
            </div>

            <div className="p-3 rounded-lg bg-slate-950/60 border border-slate-800/80">
              <div className="text-xs text-slate-400">دخلت Canceling اليوم</div>
              <div className="text-xl font-bold font-mono text-orange-400 mt-1">
                {todayActivity.Canceling || 0}
              </div>
              <div className="text-[11px] text-orange-400/70 mt-0.5">
                طلب فريد {Boolean(todayActivity.cancelingEvents) && `· (${todayActivity.cancelingEvents} حركة)`}
              </div>
            </div>
          </div>
        </section>
      </div>

      {/* 4. Delays & Age in Pending / Processing */}
      <section className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Pending Age Breakdown */}
        <div
          onClick={onNavigateToPending}
          className="p-5 rounded-xl bg-slate-900 border border-slate-800 hover:border-slate-700 transition-all cursor-pointer group space-y-3"
        >
          <div className="flex items-center justify-between border-b border-slate-800/60 pb-3">
            <h4 className="text-sm font-bold text-amber-400 flex items-center gap-2">
              <Clock className="w-4 h-4 text-amber-400" />
              <span>أعمار طلبات Pending (المعلقة)</span>
            </h4>
            <span className="text-xs text-slate-500">إجمالي {pendingAge.total} طلب</span>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 pt-1 text-center">
            <div className="p-2.5 rounded-lg bg-slate-950/60 border border-slate-800">
              <div className="text-[11px] text-slate-400">&lt; يومين</div>
              <div className="text-lg font-bold font-mono text-emerald-400 mt-0.5">
                {pendingAge.lessThanTwoDays || 0}
              </div>
            </div>
            <div className="p-2.5 rounded-lg bg-slate-950/60 border border-slate-800">
              <div className="text-[11px] text-slate-400">2 إلى 4 أيام</div>
              <div className="text-lg font-bold font-mono text-amber-300 mt-0.5">
                {pendingAge.twoToFourDays || 0}
              </div>
            </div>
            <div className="p-2.5 rounded-lg bg-slate-950/60 border border-slate-800">
              <div className="text-[11px] text-slate-400">4 إلى 5 أيام</div>
              <div className="text-lg font-bold font-mono text-amber-400 mt-0.5">
                {pendingAge.fourToFiveDays || 0}
              </div>
            </div>
            <div className="p-2.5 rounded-lg bg-slate-950/60 border border-slate-800">
              <div className="text-[11px] text-slate-400">&gt; 5 أيام (حرج)</div>
              <div className="text-lg font-bold font-mono text-rose-400 mt-0.5">
                {pendingAge.overFiveDays || 0}
              </div>
            </div>
          </div>
          {Boolean(pendingAge.unknown) && (
            <div className="text-[11px] text-slate-500 text-left pt-1">
              غير محدد / غير مكتمل: {pendingAge.unknown}
            </div>
          )}
        </div>

        {/* Processing Age Breakdown */}
        <div
          onClick={onNavigateToProcessing}
          className="p-5 rounded-xl bg-slate-900 border border-slate-800 hover:border-slate-700 transition-all cursor-pointer group space-y-3"
        >
          <div className="flex items-center justify-between border-b border-slate-800/60 pb-3">
            <h4 className="text-sm font-bold text-sky-400 flex items-center gap-2">
              <RotateCw className="w-4 h-4 text-sky-400" />
              <span>أعمار طلبات Processing (من واقع السجلات)</span>
            </h4>
            <span className="text-xs text-slate-500">إجمالي {processingAge.total} طلب</span>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 pt-1 text-center">
            <div className="p-2.5 rounded-lg bg-slate-950/60 border border-slate-800">
              <div className="text-[11px] text-slate-400">&lt; يومين</div>
              <div className="text-lg font-bold font-mono text-emerald-400 mt-0.5">
                {processingAge.lessThanTwoDays || 0}
              </div>
            </div>
            <div className="p-2.5 rounded-lg bg-slate-950/60 border border-slate-800">
              <div className="text-[11px] text-slate-400">2 إلى 4 أيام</div>
              <div className="text-lg font-bold font-mono text-sky-300 mt-0.5">
                {processingAge.twoToFourDays || 0}
              </div>
            </div>
            <div className="p-2.5 rounded-lg bg-slate-950/60 border border-slate-800">
              <div className="text-[11px] text-slate-400">4 إلى 5 أيام</div>
              <div className="text-lg font-bold font-mono text-amber-400 mt-0.5">
                {processingAge.fourToFiveDays || 0}
              </div>
            </div>
            <div className="p-2.5 rounded-lg bg-slate-950/60 border border-slate-800">
              <div className="text-[11px] text-slate-400">&gt; 5 أيام (تأخير)</div>
              <div className="text-lg font-bold font-mono text-rose-400 mt-0.5">
                {processingAge.overFiveDays || 0}
              </div>
            </div>
          </div>
          {Boolean(processingAge.unknown) && (
            <div className="text-[11px] text-slate-500 text-left pt-1">
              غير محدد / غير مكتمل السجل: {processingAge.unknown}
            </div>
          )}
        </div>
      </section>

      {/* Unified Risk Drilldown Modal */}
      {selectedRiskType && (
        <RiskDetailsModal
          isOpen={!!selectedRiskType}
          riskType={selectedRiskType}
          selectedDate={selectedDate}
          initialTab={riskScope === 'today' ? 'today_printed' : 'all'}
          onClose={() => setSelectedRiskType(null)}
        />
      )}
    </div>
  );
};
