import React from 'react';
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
} from 'lucide-react';
import { DashboardStats } from '../types';

interface DashboardViewProps {
  stats: DashboardStats | null;
  selectedDate: string;
  onFilterStatus: (status: string) => void;
  onFilterConfirmationAge: (category: string) => void;
  onNavigateToPrintedTab: (subTab: 'all' | 'no_extra_phone' | 'multi_merchant' | 'low_delivery') => void;
  onNavigateToPending: () => void;
  onNavigateToProcessing: () => void;
  onNavigateToAlerts: () => void;
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

  const { currentCounts, confirmationAges, riskIndicators, todayActivity, pendingAge, processingAge } = stats;

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      {/* Page Title & Subtitle with Business Date */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-800 pb-4">
        <div>
          <h2 className="text-xl font-bold text-slate-100 flex items-center gap-2">
            <span>لوحة المؤشرات والعمليات</span>
            <span className="text-xs font-normal text-slate-500 font-mono">(Africa/Cairo)</span>
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            تاريخ التشغيل المعتمد: <span className="font-mono text-amber-400 font-bold">{selectedDate}</span> {stats.isToday ? '· (بيانات حية)' : '· (بيانات تاريخية محفوظة)'}
          </p>
        </div>
      </div>

      {/* 1. Primary Status Cards (Five Essential Business Groups + Canceled) */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
            <Layers className="w-3.5 h-3.5 text-amber-500" />
            <span>حالات الطلبات الأساسية {stats.isToday ? '(الطلبات الحالية في النظام)' : `(نهاية يوم ${selectedDate})`}</span>
          </h3>
          <span className="text-[11px] text-slate-500">اضغط على أي بطاقة لعرض الطلبات المطابقة</span>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          {/* 1. New */}
          <button
            onClick={() => onFilterStatus('New')}
            className="text-right p-4 rounded-xl bg-slate-900 border border-slate-800 hover:border-slate-700 hover:bg-slate-800/60 transition-all cursor-pointer group"
          >
            <div className="flex items-center justify-between text-xs text-slate-400 mb-2">
              <span className="font-medium text-slate-300">أوردر جديد</span>
              <span className="text-[11px] font-mono text-slate-500">New</span>
            </div>
            <div className="text-2xl font-bold font-mono text-slate-100 group-hover:text-amber-400 transition-colors">
              {currentCounts.New}
            </div>
            <div className="mt-2 text-[11px] text-slate-500 flex items-center gap-1">
              <span>طلب جديد</span>
              <ChevronLeft className="w-3 h-3 group-hover:-translate-x-0.5 transition-transform" />
            </div>
          </button>

          {/* 2. Pending */}
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
            <div className="mt-2 text-[11px] text-slate-500 flex items-center gap-1">
              <span>يحتاج متابعة</span>
              <ChevronLeft className="w-3 h-3 group-hover:-translate-x-0.5 transition-transform" />
            </div>
          </button>

          {/* 3. Processing */}
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
            <div className="mt-2 text-[11px] text-slate-500 flex items-center gap-1">
              <span>قيد التجهيز</span>
              <ChevronLeft className="w-3 h-3 group-hover:-translate-x-0.5 transition-transform" />
            </div>
          </button>

          {/* 4. Canceling */}
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
            <div className="mt-2 text-[11px] text-slate-500 flex items-center gap-1">
              <span>تحت المراجعة</span>
              <ChevronLeft className="w-3 h-3 group-hover:-translate-x-0.5 transition-transform" />
            </div>
          </button>

          {/* 5. Printed */}
          <button
            onClick={() => onFilterStatus('Printed')}
            className="text-right p-4 rounded-xl bg-slate-900 border border-slate-800 hover:border-emerald-500/30 hover:bg-slate-800/60 transition-all cursor-pointer group"
          >
            <div className="flex items-center justify-between text-xs text-emerald-400 mb-2">
              <span className="font-medium">مطبوع / مؤكد</span>
              <span className="text-[11px] font-mono text-slate-500">Printed</span>
            </div>
            <div className="text-2xl font-bold font-mono text-emerald-400">
              {currentCounts.Printed}
            </div>
            <div className="mt-2 text-[11px] text-slate-500 flex items-center gap-1">
              <span>جاهز للشحن</span>
              <ChevronLeft className="w-3 h-3 group-hover:-translate-x-0.5 transition-transform" />
            </div>
          </button>

          {/* 6. Canceled */}
          <button
            onClick={() => onFilterStatus('Canceled')}
            className="text-right p-4 rounded-xl bg-slate-900 border border-slate-800 hover:border-rose-500/30 hover:bg-slate-800/60 transition-all cursor-pointer group"
          >
            <div className="flex items-center justify-between text-xs text-rose-400 mb-2">
              <span className="font-medium">ملغي نهائي</span>
              <span className="text-[11px] font-mono text-slate-500">Canceled</span>
            </div>
            <div className="text-2xl font-bold font-mono text-rose-400">
              {currentCounts.Canceled}
            </div>
            <div className="mt-2 text-[11px] text-slate-500 flex items-center gap-1">
              <span>طلبات ملغاة</span>
              <ChevronLeft className="w-3 h-3 group-hover:-translate-x-0.5 transition-transform" />
            </div>
          </button>
        </div>
      </section>

      {/* 2. Critical Risk Indicators Section */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-rose-400 flex items-center gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5 text-rose-400" />
            <span>مؤشرات المخاطر الحرجة (محرك التنبيهات المباشر)</span>
          </h3>
          <span className="text-[11px] text-slate-500">للطلبات المطبوعة في اليوم المختار ({selectedDate || 'اليوم'})</span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          {/* Multi-Merchant Codes Alert */}
          <div
            onClick={() => onNavigateToPrintedTab('multi_merchant')}
            className={`p-4 rounded-xl border transition-all cursor-pointer ${
              riskIndicators.multiMerchantPrinted > 0
                ? 'bg-rose-500/10 border-rose-500/40 hover:bg-rose-500/20 shadow-md shadow-rose-950/40'
                : 'bg-slate-900 border-slate-800 hover:border-slate-700'
            }`}
          >
            <div className="flex items-center justify-between text-xs text-rose-300 mb-2">
              <span className="font-bold flex items-center gap-1.5">
                <AlertTriangle className="w-4 h-4 text-rose-400" />
                <span>تعدد أكواد المخازن (Multi-Warehouse)</span>
              </span>
              <span className="text-[10px] text-rose-400 uppercase tracking-widest font-mono">حرج</span>
            </div>
            <div className="text-2xl font-bold font-mono text-rose-400">
              {riskIndicators.multiMerchantPrinted}
            </div>
            <p className="mt-1.5 text-[11px] text-slate-400 leading-relaxed">
              طلبات مطبوعة لليوم المختار تحتوي منتجات من أكثر من كود مخزن مستقل.
            </p>
          </div>

          {/* Missing Extra Phone */}
          <div
            onClick={() => onNavigateToPrintedTab('no_extra_phone')}
            className="p-4 rounded-xl bg-slate-900 border border-slate-800 hover:border-amber-500/30 hover:bg-slate-800/60 transition-all cursor-pointer"
          >
            <div className="flex items-center justify-between text-xs text-amber-400 mb-2">
              <span className="font-semibold">دون هاتف إضافي صالح</span>
              <span className="text-[10px] text-slate-500 font-mono">تأكيد</span>
            </div>
            <div className="text-2xl font-bold font-mono text-amber-400">
              {riskIndicators.missingExtraPhonePrinted}
            </div>
            <p className="mt-1.5 text-[11px] text-slate-400 leading-relaxed">
              طلبات مطبوعة لليوم المختار لم يسجل بها هاتف إضافي أو بصيغة غير صالحة.
            </p>
          </div>

          {/* Delivery Rate < 70% */}
          <div
            onClick={() => onNavigateToPrintedTab('low_delivery')}
            className="p-4 rounded-xl bg-slate-900 border border-slate-800 hover:border-rose-500/30 hover:bg-slate-800/60 transition-all cursor-pointer"
          >
            <div className="flex items-center justify-between text-xs text-rose-400 mb-2">
              <span className="font-semibold">نسبة تسليم أقل من 70%</span>
              <span className="text-[10px] text-slate-500 font-mono">&lt; 70%</span>
            </div>
            <div className="text-2xl font-bold font-mono text-rose-400">
              {riskIndicators.lowDeliveryRatePrinted}
            </div>
            <p className="mt-1.5 text-[11px] text-slate-400 leading-relaxed">
              عملاء لديهم سجل تاريخي بنسبة استلام منخفضة (&lt; 70%) لطلبات اليوم المختار.
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
            <div className="text-2xl font-bold font-mono text-slate-100">
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
            </div>

            <div className="p-3 rounded-lg bg-slate-950/60 border border-slate-800/80">
              <div className="text-xs text-slate-400">دخلت Printed اليوم</div>
              <div className="text-xl font-bold font-mono text-emerald-400 mt-1">
                {todayActivity.Printed}
              </div>
            </div>

            <div className="p-3 rounded-lg bg-slate-950/60 border border-slate-800/80">
              <div className="text-xs text-slate-400">دخلت Pending اليوم</div>
              <div className="text-xl font-bold font-mono text-amber-400 mt-1">
                {todayActivity.Pending}
              </div>
            </div>

            <div className="p-3 rounded-lg bg-slate-950/60 border border-slate-800/80">
              <div className="text-xs text-slate-400">دخلت Processing اليوم</div>
              <div className="text-xl font-bold font-mono text-sky-400 mt-1">
                {todayActivity.Processing}
              </div>
            </div>

            <div className="p-3 rounded-lg bg-slate-950/60 border border-slate-800/80">
              <div className="text-xs text-slate-400">أُلغيت اليوم</div>
              <div className="text-xl font-bold font-mono text-rose-400 mt-1">
                {todayActivity.Canceled}
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
    </div>
  );
};
