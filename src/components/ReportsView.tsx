import React, { useState, useEffect, useMemo } from 'react';
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
} from 'lucide-react';
import { DateCalendarPicker } from './common/DateCalendarPicker';
import { ReportKpiDrilldownModal, DrilldownPillar } from './ReportKpiDrilldownModal';

interface ReportsViewProps {
  onSelectOrder?: (orderCode: string) => void;
}

interface WarehouseMetric {
  warehouse_code: string;
  orders_count: number;
  items_quantity: number;
  associated_revenue?: number;
}

interface EmployeeMetric {
  actor_name: string;
  action_count: number;
  unique_orders: number;
  printed_count?: number;
  cancel_count?: number;
}

interface TransitionMetric {
  from_status: string;
  to_status: string;
  count: number;
}

interface TimelineItem {
  date: string;
  events_count: number;
  unique_orders: number;
}

interface DailyCreatedItem {
  date: string;
  created_count: number;
  daily_revenue: number;
}

interface GovernorateMetric {
  governorate: string;
  count: number;
  total_value?: number;
}

interface OrderStatusMetric {
  status: string;
  count: number;
  total_value: number;
}

interface ReportData {
  startDate: string;
  endDate: string;
  period: string;
  createdCount: number;
  totalOrderValue?: number;
  averageOrderValue?: number;
  multiWarehouseCount?: number;
  multiWarehouseStats?: {
    totalOrders: number;
    multiOrders: number;
    singleOrders: number;
    multiValue: number;
    singleValue: number;
  };
  touchedCount: number;
  totalEvents: number;
  statusCounts?: {
    printed: number;
    pending: number;
    processing: number;
    canceling: number;
  };
  ordersByStatus?: OrderStatusMetric[];
  dailyCreated?: DailyCreatedItem[];
  transitions: TransitionMetric[];
  cancellations: { to_status: string; count: number }[];
  employees: EmployeeMetric[];
  warehouses?: WarehouseMetric[];
  governorates?: GovernorateMetric[];
  timeline?: TimelineItem[];
  coverage?: {
    totalDays: number;
    completeDays: number;
    partialDays: number;
    isFullyComplete: boolean;
  };
}

export const ReportsView: React.FC<ReportsViewProps> = ({ onSelectOrder }) => {
  const [period, setPeriod] = useState<'today' | 'yesterday' | 'last_7_days' | 'last_30_days' | 'custom'>('today');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [data, setData] = useState<ReportData | null>(null);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<'overview' | 'warehouses' | 'team' | 'regions'>('overview');
  const [copiedSummary, setCopiedSummary] = useState(false);

  // Filters and sorts
  const [warehouseSearch, setWarehouseSearch] = useState('');
  const [warehouseSort, setWarehouseSort] = useState<'items' | 'orders' | 'revenue'>('items');
  const [employeeSearch, setEmployeeSearch] = useState('');
  const [transitionSearch, setTransitionSearch] = useState('');
  const [drilldownPillar, setDrilldownPillar] = useState<DrilldownPillar | null>(null);

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
      console.error('Error fetching operational report:', err);
    } finally {
      setLoading(false);
    }
  }

  // Copy Executive Summary in Arabic
  function handleCopySummary() {
    if (!data) return;
    const periodLabel =
      period === 'today'
        ? 'اليوم'
        : period === 'yesterday'
        ? 'أمس'
        : period === 'last_7_days'
        ? 'آخر 7 أيام'
        : period === 'last_30_days'
        ? 'آخر 30 يوماً'
        : `من ${data.startDate} إلى ${data.endDate}`;

    const printedCount = data.ordersByStatus?.find((s) => s.status === 'Printed')?.count || data.statusCounts?.printed || 0;
    const printedVal = data.ordersByStatus?.find((s) => s.status === 'Printed')?.total_value || 0;
    const confRate = data.createdCount > 0 ? Math.round((printedCount / data.createdCount) * 100) : 0;
    const totalCancels = data.cancellations?.reduce((acc, c) => acc + c.count, 0) || 0;
    const cancelRate = data.createdCount > 0 ? Math.round((totalCancels / data.createdCount) * 100) : 0;

    const summary = `📊 *تقرير عمليات Vendoor والمخازن التنفيذي*
الفترة: ${periodLabel} (${data.startDate} إلى ${data.endDate})
-----------------------------------------
📦 *مؤشرات حجم الإنشاء والمبيعات:*
• إجمالي الطلبات المنشأة: ${data.createdCount.toLocaleString()} طلب
• القيمة الإجمالية للطلبات: ${(data.totalOrderValue || 0).toLocaleString()} ج.م
• متوسط قيمة الطلب (AOV): ${(data.averageOrderValue || 0).toLocaleString()} ج.م

✅ *مؤشرات التأكيد ومسار الحالات:*
• طلبات مؤكدة (Printed): ${printedCount.toLocaleString()} طلب (${confRate}% من المنشأ)
• قيمة الطلبات المؤكدة: ${printedVal.toLocaleString()} ج.م
• طلبات قيد المعالجة والتجهيز: ${((data.statusCounts?.pending || 0) + (data.statusCounts?.processing || 0)).toLocaleString()} طلب
• حركات الإلغاء المسجلة: ${totalCancels.toLocaleString()} حركة (${cancelRate}%)

🏢 *ذكاء تشغيل المخازن (Warehouses):*
• عدد المخازن النشطة: ${data.warehouses?.length || 0} مخزن
• طلبات تعدد المخازن (Multi-Warehouse): ${(data.multiWarehouseCount || 0).toLocaleString()} طلب
• طلبات المخزن الواحد: ${(data.multiWarehouseStats?.singleOrders || (data.createdCount - (data.multiWarehouseCount || 0))).toLocaleString()} طلب

👥 *إنتاجية الفريق والعمليات:*
• إجمالي العمليات الموثقة: ${data.totalEvents.toLocaleString()} حركة
• عدد الطلبات التي خضعت للنشاط: ${data.touchedCount.toLocaleString()} طلب
• كادر العمليات الفعّال: ${data.employees?.length || 0} موظف
-----------------------------------------
صدر آلياً من منظومة مراقبة عمليات فيندور (Vendoor Operations Intelligence)`;

    navigator.clipboard.writeText(summary).then(() => {
      setCopiedSummary(true);
      setTimeout(() => setCopiedSummary(false), 2500);
    });
  }

  // Export to CSV
  function handleExportCSV() {
    if (!data) return;

    let csvContent = '\uFEFF'; // UTF-8 BOM for Arabic support in Excel

    // Section 1: Executive Overview
    csvContent += 'التقرير التشغيلي الشامل والمخازن - Vendoor Operations Intelligence\n';
    csvContent += `النطاق الزمني,من ${data.startDate} إلى ${data.endDate},الفترة,${period}\n\n`;

    csvContent += 'المؤشر,القيمة,ملاحظات\n';
    csvContent += `إجمالي الطلبات المنشأة,${data.createdCount},طلب\n`;
    csvContent += `القيمة الإجمالية للمبيعات,${data.totalOrderValue || 0},جنيه مصري\n`;
    csvContent += `متوسط قيمة الطلب,${data.averageOrderValue || 0},جنيه مصري\n`;
    csvContent += `الطلبات المؤكدة (Printed),${data.statusCounts?.printed || 0},طلب\n`;
    csvContent += `طلبات تعدد المخازن,${data.multiWarehouseCount || 0},طلب\n`;
    csvContent += `إجمالي الحركات والعمليات,${data.totalEvents},حركة موثقة\n\n`;

    // Section 2: Orders by Status
    if (data.ordersByStatus && data.ordersByStatus.length > 0) {
      csvContent += '--- توزيع حالات الطلبات ---\n';
      csvContent += 'الحالة,عدد الطلبات,النسبة المئوية,القيمة الإجمالية (ج.م)\n';
      data.ordersByStatus.forEach((s) => {
        const pct = data.createdCount > 0 ? ((s.count / data.createdCount) * 100).toFixed(1) : '0';
        csvContent += `"${s.status}",${s.count},${pct}%,${s.total_value}\n`;
      });
      csvContent += '\n';
    }

    // Section 3: Warehouses Breakdown
    if (data.warehouses && data.warehouses.length > 0) {
      csvContent += '--- تحليل حركة المخازن والأصناف ---\n';
      csvContent += 'م,كود المخزن,عدد الطلبات,إجمالي القطع,القيمة التقديرية (ج.م)\n';
      data.warehouses.forEach((w, idx) => {
        csvContent += `${idx + 1},"${w.warehouse_code}",${w.orders_count},${w.items_quantity},${w.associated_revenue || 0}\n`;
      });
      csvContent += '\n';
    }

    // Section 4: Employees
    if (data.employees && data.employees.length > 0) {
      csvContent += '--- إنتاجية فريق العمليات ---\n';
      csvContent += 'م,اسم الموظف,إجمالي الحركات,الطلبات الفريدة,تأكيدات الطباعة,الإلغاءات\n';
      data.employees.forEach((e, idx) => {
        csvContent += `${idx + 1},"${e.actor_name}",${e.action_count},${e.unique_orders},${e.printed_count || 0},${e.cancel_count || 0}\n`;
      });
    }

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const filename = `vendoor_report_${data.startDate}_to_${data.endDate}.csv`;
    link.href = URL.createObjectURL(blob);
    link.setAttribute('download', filename);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  function handlePrint() {
    window.print();
  }

  // Filtered and Sorted Warehouses
  const processedWarehouses = useMemo(() => {
    if (!data?.warehouses) return [];
    let list = [...data.warehouses];
    if (warehouseSearch.trim()) {
      const q = warehouseSearch.toLowerCase();
      list = list.filter((w) => w.warehouse_code.toLowerCase().includes(q));
    }
    list.sort((a, b) => {
      if (warehouseSort === 'items') return b.items_quantity - a.items_quantity;
      if (warehouseSort === 'orders') return b.orders_count - a.orders_count;
      if (warehouseSort === 'revenue') return (b.associated_revenue || 0) - (a.associated_revenue || 0);
      return 0;
    });
    return list;
  }, [data?.warehouses, warehouseSearch, warehouseSort]);

  const filteredEmployees = useMemo(() => {
    if (!data?.employees) return [];
    if (!employeeSearch.trim()) return data.employees;
    const q = employeeSearch.toLowerCase();
    return data.employees.filter((e) => e.actor_name.toLowerCase().includes(q));
  }, [data?.employees, employeeSearch]);

  const filteredTransitions = useMemo(() => {
    if (!data?.transitions) return [];
    if (!transitionSearch.trim()) return data.transitions;
    const q = transitionSearch.toLowerCase();
    return data.transitions.filter(
      (t) => (t.from_status || '').toLowerCase().includes(q) || (t.to_status || '').toLowerCase().includes(q)
    );
  }, [data?.transitions, transitionSearch]);

  // Derived calculations for executive KPIs
  const totalCancellations = useMemo(() => {
    return data?.cancellations?.reduce((acc, curr) => acc + curr.count, 0) || 0;
  }, [data?.cancellations]);

  const printedOrdersCount = useMemo(() => {
    return data?.ordersByStatus?.find((s) => s.status === 'Printed')?.count || data?.statusCounts?.printed || 0;
  }, [data?.ordersByStatus, data?.statusCounts]);

  const printedOrdersRevenue = useMemo(() => {
    return data?.ordersByStatus?.find((s) => s.status === 'Printed')?.total_value || 0;
  }, [data?.ordersByStatus]);

  const confirmationRate = useMemo(() => {
    if (!data || data.createdCount === 0) return 0;
    return Math.round((printedOrdersCount / data.createdCount) * 100);
  }, [data, printedOrdersCount]);

  const cancellationRate = useMemo(() => {
    if (!data || data.createdCount === 0) return 0;
    return Math.round((totalCancellations / data.createdCount) * 100);
  }, [data, totalCancellations]);

  const totalWarehouseItems = useMemo(() => {
    if (!data?.warehouses) return 0;
    return data.warehouses.reduce((acc, w) => acc + (w.items_quantity || 0), 0);
  }, [data?.warehouses]);

  const top3WarehouseConcentration = useMemo(() => {
    if (!data?.warehouses || data.warehouses.length === 0 || totalWarehouseItems === 0) return 0;
    const top3Items = data.warehouses.slice(0, 3).reduce((acc, w) => acc + w.items_quantity, 0);
    return Math.round((top3Items / totalWarehouseItems) * 100);
  }, [data?.warehouses, totalWarehouseItems]);

  const maxTimelineEvents = useMemo(() => {
    if (!data?.timeline || data.timeline.length === 0) return 1;
    return Math.max(...data.timeline.map((t) => t.events_count), 1);
  }, [data?.timeline]);

  return (
    <div className="p-4 md:p-6 space-y-6 max-w-7xl mx-auto print:p-0 print:max-w-none text-slate-100">
      {/* Top Executive Header */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-b border-slate-800 pb-5">
        <div>
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-gradient-to-br from-amber-500/20 to-amber-600/10 border border-amber-500/30 text-amber-400 shadow-sm">
              <BarChart3 className="w-6 h-6" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-xl font-bold text-slate-100 tracking-tight">
                  التقرير التشغيلي الشامل وحركة المخازن
                </h2>
                <span className="text-[11px] font-mono font-bold px-2 py-0.5 rounded bg-amber-500/10 border border-amber-500/20 text-amber-400">
                  دقة متناهية
                </span>
              </div>
              <div className="flex items-center gap-2 text-xs text-slate-400 mt-1">
                <span>تحليل تدفق الحالات والمبيعات</span>
                <span aria-hidden="true" className="text-slate-600">·</span>
                <span className="text-amber-300 font-medium">حركة أكواد المخازن</span>
                <span aria-hidden="true" className="text-slate-600">·</span>
                <span>إنتاجية الكادر وتوزيع المحافظات</span>
              </div>
            </div>
          </div>
        </div>

        {/* Action Controls & Date Switcher */}
        <div className="flex flex-wrap items-center gap-2.5">
          {/* Period Selector Tabs */}
          <div className="flex items-center gap-1 p-1 bg-slate-900/90 border border-slate-800 rounded-xl text-xs font-medium shadow-inner">
            <button
              onClick={() => setPeriod('today')}
              className={`px-3 py-1.5 rounded-lg transition-all cursor-pointer ${
                period === 'today'
                  ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30 font-bold shadow-sm'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              اليوم
            </button>
            <button
              onClick={() => setPeriod('yesterday')}
              className={`px-3 py-1.5 rounded-lg transition-all cursor-pointer ${
                period === 'yesterday'
                  ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30 font-bold shadow-sm'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              أمس
            </button>
            <button
              onClick={() => setPeriod('last_7_days')}
              className={`px-3 py-1.5 rounded-lg transition-all cursor-pointer ${
                period === 'last_7_days'
                  ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30 font-bold shadow-sm'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              آخر 7 أيام
            </button>
            <button
              onClick={() => setPeriod('last_30_days')}
              className={`px-3 py-1.5 rounded-lg transition-all cursor-pointer ${
                period === 'last_30_days'
                  ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30 font-bold shadow-sm'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              آخر 30 يوماً
            </button>
            <button
              onClick={() => setPeriod('custom')}
              className={`px-3 py-1.5 rounded-lg transition-all cursor-pointer ${
                period === 'custom'
                  ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30 font-bold shadow-sm'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              مخصص
            </button>
          </div>

          {/* Quick Utility Actions */}
          <div className="flex items-center gap-1.5">
            <button
              onClick={handleCopySummary}
              className="px-3 py-1.5 rounded-xl bg-slate-900 border border-slate-800 hover:border-slate-700 text-xs text-slate-300 hover:text-slate-100 flex items-center gap-1.5 transition-colors cursor-pointer shadow-sm"
              title="نسخ ملخص تنفيذي جاهز للمشاركة"
            >
              {copiedSummary ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5 text-amber-400" />}
              <span>{copiedSummary ? 'تم النسخ!' : 'نسخ الملخص'}</span>
            </button>

            <button
              onClick={handleExportCSV}
              className="px-3 py-1.5 rounded-xl bg-slate-900 border border-slate-800 hover:border-slate-700 text-xs text-slate-300 hover:text-slate-100 flex items-center gap-1.5 transition-colors cursor-pointer shadow-sm print:hidden"
              title="تصدير جدول البيانات CSV كامل"
            >
              <Download className="w-3.5 h-3.5 text-sky-400" />
              <span>تصدير CSV</span>
            </button>

            <button
              onClick={handlePrint}
              className="px-3 py-1.5 rounded-xl bg-slate-900 border border-slate-800 hover:border-slate-700 text-xs text-slate-300 hover:text-slate-100 flex items-center gap-1.5 transition-colors cursor-pointer shadow-sm print:hidden"
              title="طباعة التقرير أو حفظه بصيغة PDF"
            >
              <Printer className="w-3.5 h-3.5 text-slate-400" />
              <span>طباعة</span>
            </button>

            <button
              onClick={fetchReport}
              disabled={loading}
              className="p-2 rounded-xl bg-slate-900 border border-slate-800 hover:border-slate-700 text-slate-400 hover:text-amber-400 transition-colors cursor-pointer shadow-sm print:hidden"
              title="تحديث البيانات فورياً"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin text-amber-400' : ''}`} />
            </button>
          </div>
        </div>
      </div>

      {/* Custom Date Range Picker */}
      {period === 'custom' && (
        <div className="p-4 bg-slate-900/90 border border-slate-800 rounded-2xl flex flex-wrap items-center gap-4 text-xs shadow-lg">
          <div className="flex items-center gap-2 text-slate-200 font-semibold">
            <Calendar className="w-4 h-4 text-amber-400" />
            <span>تحديد النطاق الزمني بالتقويم:</span>
          </div>
          <DateCalendarPicker
            mode="range"
            startDate={startDate}
            endDate={endDate}
            onRangeChange={(s, e) => {
              setStartDate(s);
              setEndDate(e);
            }}
            placeholder="اختر فترة التقرير"
            showPresets={true}
          />
          <button
            onClick={fetchReport}
            className="px-4 py-1.5 bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold rounded-lg transition-colors cursor-pointer mr-auto shadow"
          >
            تحديث التقرير
          </button>
        </div>
      )}

      {/* Coverage Status Banner (Subtle & informative) */}
      {data?.coverage && !data.coverage.isFullyComplete && (
        <div className="p-3.5 rounded-xl bg-amber-500/10 border border-amber-500/20 text-xs text-amber-300 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
            <span>
              <strong>تغطية البيانات:</strong> يتضمن هذا النطاق أياماً قيد الاستكمال ({data.coverage.completeDays} من أصل {data.coverage.totalDays} يوماً مؤكدة). الأرقام المعروضة مستخرجة من السجلات الفعلية دون أي افتراضات تخمينية.
            </span>
          </div>
          <span className="text-[11px] font-mono font-bold text-amber-400 px-2 py-0.5 rounded bg-amber-500/20 border border-amber-500/30 shrink-0">
            تغطية جزئية
          </span>
        </div>
      )}

      {loading && !data ? (
        <div className="py-24 text-center space-y-4">
          <div className="relative inline-flex">
            <div className="w-12 h-12 rounded-full border-2 border-amber-500/20 border-t-amber-400 animate-spin" />
            <BarChart3 className="w-5 h-5 text-amber-400 absolute inset-0 m-auto" />
          </div>
          <div className="text-sm font-semibold text-slate-200">جاري تجميع التقرير التشغيلي الموثق...</div>
          <div className="text-xs text-slate-500">استخراج حركات المخازن، مصفوفة الحالات، وتدفق الإنتاجية</div>
        </div>
      ) : data ? (
        <div className="space-y-6">
          {/* 1. PRIMARY EXECUTIVE KPI HERO CARDS (4 Main Pillars) */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {/* Pillar 1: Total Created Orders */}
            <div
              onClick={() => setDrilldownPillar('created')}
              className="p-5 rounded-2xl bg-gradient-to-b from-slate-900/90 to-slate-950/80 border border-slate-800/80 relative overflow-hidden shadow-lg group hover:border-blue-500/50 hover:shadow-blue-500/10 transition-all cursor-pointer"
            >
              <div className="absolute top-0 right-0 w-24 h-24 bg-blue-500/5 rounded-full blur-2xl pointer-events-none group-hover:bg-blue-500/10 transition-colors" />
              <div className="flex items-center justify-between text-slate-400 text-xs font-medium">
                <span className="flex items-center gap-1.5 text-slate-300">
                  <PackageCheck className="w-4 h-4 text-blue-400" />
                  <span>الطلبات المنشأة (Created)</span>
                </span>
                <span className="text-[11px] font-mono text-slate-500">حجم الإنشاء</span>
              </div>
              <div className="mt-3 flex items-baseline gap-2">
                <div className="text-3xl font-extrabold font-mono text-slate-100 group-hover:text-blue-400 transition-colors tracking-tight">
                  {data.createdCount.toLocaleString()}
                </div>
                <span className="text-xs text-slate-400 font-normal">طلب</span>
              </div>
              <div className="mt-2.5 pt-2.5 border-t border-slate-800/60 flex items-center justify-between text-xs">
                <span className="text-slate-400">إجمالي المبيعات:</span>
                <span className="font-mono font-bold text-slate-200">
                  {(data.totalOrderValue || 0).toLocaleString()} <span className="text-[10px] text-slate-400">ج.م</span>
                </span>
              </div>
              <div className="mt-1 flex items-center justify-between text-[11px] text-slate-500 font-mono">
                <span>متوسط الطلب (AOV):</span>
                <span>{(data.averageOrderValue || 0).toLocaleString()} ج.م</span>
              </div>
              <div className="mt-3 pt-2.5 border-t border-slate-800/80 flex items-center justify-between text-xs text-blue-400 font-medium group-hover:text-blue-300">
                <span>عرض الطلبات والتفاصيل</span>
                <ChevronLeft className="w-3.5 h-3.5 group-hover:-translate-x-1 transition-transform" />
              </div>
            </div>

            {/* Pillar 2: Confirmed / Printed */}
            <div
              onClick={() => setDrilldownPillar('printed')}
              className="p-5 rounded-2xl bg-gradient-to-b from-slate-900/90 to-slate-950/80 border border-slate-800/80 relative overflow-hidden shadow-lg group hover:border-emerald-500/50 hover:shadow-emerald-500/10 transition-all cursor-pointer"
            >
              <div className="absolute top-0 right-0 w-24 h-24 bg-emerald-500/5 rounded-full blur-2xl pointer-events-none group-hover:bg-emerald-500/10 transition-colors" />
              <div className="flex items-center justify-between text-slate-400 text-xs font-medium">
                <span className="flex items-center gap-1.5 text-emerald-400 font-semibold">
                  <TrendingUp className="w-4 h-4 text-emerald-400" />
                  <span>مؤكدة ومطبوعة (Printed)</span>
                </span>
                <span className="text-[11px] font-mono font-bold px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                  {confirmationRate}% تأكيد
                </span>
              </div>
              <div className="mt-3 flex items-baseline gap-2">
                <div className="text-3xl font-extrabold font-mono text-emerald-400 group-hover:text-emerald-300 transition-colors tracking-tight">
                  {printedOrdersCount.toLocaleString()}
                </div>
                <span className="text-xs text-emerald-400/70 font-normal">طلب جاهز</span>
              </div>
              <div className="mt-2.5 pt-2.5 border-t border-slate-800/60 flex items-center justify-between text-xs">
                <span className="text-slate-400">قيمة المؤكد:</span>
                <span className="font-mono font-bold text-emerald-300">
                  {printedOrdersRevenue.toLocaleString()} <span className="text-[10px] text-slate-400">ج.م</span>
                </span>
              </div>
              <div className="mt-1 flex items-center justify-between text-[11px] text-slate-500 font-mono">
                <span>نسبة الإنجاز:</span>
                <span>{printedOrdersCount} من {data.createdCount}</span>
              </div>
              <div className="mt-3 pt-2.5 border-t border-slate-800/80 flex items-center justify-between text-xs text-emerald-400 font-medium group-hover:text-emerald-300">
                <span>عرض الطلبات والتفاصيل</span>
                <ChevronLeft className="w-3.5 h-3.5 group-hover:-translate-x-1 transition-transform" />
              </div>
            </div>

            {/* Pillar 3: Active Pipeline (Pending + Processing) */}
            <div
              onClick={() => setDrilldownPillar('pipeline')}
              className="p-5 rounded-2xl bg-gradient-to-b from-slate-900/90 to-slate-950/80 border border-slate-800/80 relative overflow-hidden shadow-lg group hover:border-sky-500/50 hover:shadow-sky-500/10 transition-all cursor-pointer"
            >
              <div className="absolute top-0 right-0 w-24 h-24 bg-sky-500/5 rounded-full blur-2xl pointer-events-none group-hover:bg-sky-500/10 transition-colors" />
              <div className="flex items-center justify-between text-slate-400 text-xs font-medium">
                <span className="flex items-center gap-1.5 text-sky-400 font-semibold">
                  <Clock className="w-4 h-4 text-sky-400" />
                  <span>قيد التجهيز والمعالجة</span>
                </span>
                <span className="text-[11px] font-mono text-slate-400">الطلبات الحية</span>
              </div>
              <div className="mt-3 flex items-baseline gap-2">
                <div className="text-3xl font-extrabold font-mono text-sky-400 group-hover:text-sky-300 transition-colors tracking-tight">
                  {((data.statusCounts?.pending || 0) + (data.statusCounts?.processing || 0)).toLocaleString()}
                </div>
                <span className="text-xs text-sky-400/70 font-normal">طلب</span>
              </div>
              <div className="mt-2.5 pt-2.5 border-t border-slate-800/60 flex items-center justify-between text-xs">
                <span className="text-slate-400">معلق (Pending):</span>
                <span className="font-mono font-semibold text-amber-300">
                  {data.statusCounts?.pending || 0} طلب
                </span>
              </div>
              <div className="mt-1 flex items-center justify-between text-xs text-slate-400">
                <span>قيد التنفيذ (Processing):</span>
                <span className="font-mono font-semibold text-sky-300">
                  {data.statusCounts?.processing || 0} طلب
                </span>
              </div>
              <div className="mt-3 pt-2.5 border-t border-slate-800/80 flex items-center justify-between text-xs text-sky-400 font-medium group-hover:text-sky-300">
                <span>عرض الطلبات والتفاصيل</span>
                <ChevronLeft className="w-3.5 h-3.5 group-hover:-translate-x-1 transition-transform" />
              </div>
            </div>

            {/* Pillar 4: Multi-Warehouse (المخازن) */}
            <div
              onClick={() => setDrilldownPillar('multi_warehouse')}
              className="p-5 rounded-2xl bg-gradient-to-b from-slate-900/90 to-slate-950/80 border border-slate-800/80 relative overflow-hidden shadow-lg group hover:border-rose-500/50 hover:shadow-rose-500/10 transition-all cursor-pointer"
            >
              <div className="absolute top-0 right-0 w-24 h-24 bg-rose-500/5 rounded-full blur-2xl pointer-events-none group-hover:bg-rose-500/10 transition-colors" />
              <div className="flex items-center justify-between text-slate-400 text-xs font-medium">
                <span className="flex items-center gap-1.5 text-rose-400 font-semibold">
                  <ShieldAlert className="w-4 h-4 text-rose-400" />
                  <span>تعدد المخازن (Multi-Store)</span>
                </span>
                <span className="text-[11px] font-mono font-bold px-1.5 py-0.5 rounded bg-rose-500/10 text-rose-400 border border-rose-500/20">
                  {data.createdCount > 0 ? ((data.multiWarehouseCount || 0) / data.createdCount * 100).toFixed(1) : 0}%
                </span>
              </div>
              <div className="mt-3 flex items-baseline gap-2">
                <div className="text-3xl font-extrabold font-mono text-rose-400 group-hover:text-rose-300 transition-colors tracking-tight">
                  {(data.multiWarehouseCount || 0).toLocaleString()}
                </div>
                <span className="text-xs text-rose-400/70 font-normal">طلب متعدد</span>
              </div>
              <div className="mt-2.5 pt-2.5 border-t border-slate-800/60 flex items-center justify-between text-xs">
                <span className="text-slate-400">مخزن واحد:</span>
                <span className="font-mono font-bold text-slate-200">
                  {(data.multiWarehouseStats?.singleOrders || (data.createdCount - (data.multiWarehouseCount || 0))).toLocaleString()} طلب
                </span>
              </div>
              <div className="mt-1 flex items-center justify-between text-[11px] text-rose-400/80">
                <span>تتطلب تنسيق وتجزئة بوالص</span>
                <span className="font-mono">{(data.multiWarehouseStats?.multiValue || 0).toLocaleString()} ج.م</span>
              </div>
              <div className="mt-3 pt-2.5 border-t border-slate-800/80 flex items-center justify-between text-xs text-rose-400 font-medium group-hover:text-rose-300">
                <span>عرض الطلبات والتفاصيل</span>
                <ChevronLeft className="w-3.5 h-3.5 group-hover:-translate-x-1 transition-transform" />
              </div>
            </div>
          </div>

          {/* 2. SECONDARY OPERATIONAL PRECISION METRICS */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="p-3.5 rounded-xl bg-slate-900/60 border border-slate-800/80 flex items-center justify-between">
              <div>
                <div className="text-[11px] text-slate-400">حركات الإلغاء المسجلة</div>
                <div className="text-lg font-bold font-mono text-rose-300 mt-0.5">
                  {totalCancellations.toLocaleString()} <span className="text-[10px] text-slate-500">حركة</span>
                </div>
              </div>
              <div className="p-2 rounded-lg bg-rose-500/10 border border-rose-500/20 text-rose-400">
                <XCircle className="w-4 h-4" />
              </div>
            </div>

            <div className="p-3.5 rounded-xl bg-slate-900/60 border border-slate-800/80 flex items-center justify-between">
              <div>
                <div className="text-[11px] text-slate-400">إجمالي الحركات الموثقة</div>
                <div className="text-lg font-bold font-mono text-amber-400 mt-0.5">
                  {data.totalEvents.toLocaleString()} <span className="text-[10px] text-slate-500">حركة</span>
                </div>
              </div>
              <div className="p-2 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-400">
                <Layers className="w-4 h-4" />
              </div>
            </div>

            <div className="p-3.5 rounded-xl bg-slate-900/60 border border-slate-800/80 flex items-center justify-between">
              <div>
                <div className="text-[11px] text-slate-400">المخازن النشطة المسجلة</div>
                <div className="text-lg font-bold font-mono text-emerald-400 mt-0.5">
                  {data.warehouses?.length || 0} <span className="text-[10px] text-slate-500">مخزن</span>
                </div>
              </div>
              <div className="p-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400">
                <Building2 className="w-4 h-4" />
              </div>
            </div>

            <div className="p-3.5 rounded-xl bg-slate-900/60 border border-slate-800/80 flex items-center justify-between">
              <div>
                <div className="text-[11px] text-slate-400">فريق العمليات الفعّال</div>
                <div className="text-lg font-bold font-mono text-sky-400 mt-0.5">
                  {data.employees?.length || 0} <span className="text-[10px] text-slate-500">موظف</span>
                </div>
              </div>
              <div className="p-2 rounded-lg bg-sky-500/10 border border-sky-500/20 text-sky-400">
                <Users className="w-4 h-4" />
              </div>
            </div>
          </div>

          {/* 3. VISUAL STATUS FUNNEL & PIPELINE (مسار تدفق الحالات التشغيلي) */}
          <div className="p-5 rounded-2xl bg-slate-900/80 border border-slate-800 space-y-4 shadow-sm">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-800/70 pb-3">
              <div>
                <h3 className="text-sm font-bold text-slate-200 flex items-center gap-2">
                  <TrendingUp className="w-4 h-4 text-amber-400" />
                  <span>مسار تدفق الحالات والمبيعات (Status Pipeline & Financial Distribution)</span>
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  تفصيل دقيق لكافة الحالات مع عدد الطلبات، نسب التحويل، والقيمة المالية الإجمالية بالجنيه
                </p>
              </div>
              <div className="text-xs font-mono text-slate-400 bg-slate-950 px-3 py-1 rounded-lg border border-slate-800">
                إجمالي القيمة: {(data.totalOrderValue || 0).toLocaleString()} ج.م
              </div>
            </div>

            {/* Pipeline Visual Bar */}
            {data.ordersByStatus && data.ordersByStatus.length > 0 && (
              <div className="space-y-2">
                <div className="h-4 w-full bg-slate-950 rounded-lg overflow-hidden flex shadow-inner border border-slate-800/60">
                  {data.ordersByStatus.map((s, idx) => {
                    const total = data.createdCount || 1;
                    const pct = Math.max(1, (s.count / total) * 100);
                    const color =
                      s.status === 'Printed'
                        ? 'bg-emerald-500'
                        : s.status === 'Pending'
                        ? 'bg-amber-500'
                        : s.status === 'Processing'
                        ? 'bg-sky-500'
                        : s.status === 'New'
                        ? 'bg-blue-500'
                        : 'bg-rose-500';
                    return (
                      <div
                        key={idx}
                        style={{ width: `${pct}%` }}
                        className={`${color} h-full transition-all duration-300 relative group`}
                        title={`${s.status}: ${s.count} طلب (${pct.toFixed(1)}%)`}
                      />
                    );
                  })}
                </div>

                {/* Status Table with exact breakdown */}
                <div className="border border-slate-800/80 rounded-xl overflow-hidden bg-slate-950/50">
                  <table className="w-full text-right text-xs">
                    <thead>
                      <tr className="border-b border-slate-800 bg-slate-950/80 text-slate-400">
                        <th className="py-2.5 px-4 font-semibold">حالة الطلب</th>
                        <th className="py-2.5 px-4 font-semibold font-mono">عدد الطلبات</th>
                        <th className="py-2.5 px-4 font-semibold">نسبة الحجم (%)</th>
                        <th className="py-2.5 px-4 font-semibold font-mono">إجمالي القيمة (ج.م)</th>
                        <th className="py-2.5 px-4 font-semibold font-mono">متوسط الطلب</th>
                        <th className="py-2.5 px-4 font-semibold">الوصف التشغيلي</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/60 font-mono">
                      {data.ordersByStatus.map((s, idx) => {
                        const totalOrders = data.createdCount || 1;
                        const pct = ((s.count / totalOrders) * 100).toFixed(1);
                        const aov = s.count > 0 ? Math.round(s.total_value / s.count) : 0;
                        const isPrinted = s.status === 'Printed';
                        const isPending = s.status === 'Pending';
                        const isProcessing = s.status === 'Processing';
                        const isCanceled = s.status === 'Canceled';
                        const isNew = s.status === 'New';

                        return (
                          <tr key={idx} className="hover:bg-slate-800/30 transition-colors">
                            <td className="py-3 px-4 font-sans font-bold flex items-center gap-2">
                              <span
                                className={`w-2 h-2 rounded-full ${
                                  isPrinted
                                    ? 'bg-emerald-400'
                                    : isPending
                                    ? 'bg-amber-400'
                                    : isProcessing
                                    ? 'bg-sky-400'
                                    : isCanceled
                                    ? 'bg-rose-400'
                                    : 'bg-blue-400'
                                }`}
                              />
                              <span
                                className={`${
                                  isPrinted
                                    ? 'text-emerald-400'
                                    : isPending
                                    ? 'text-amber-400'
                                    : isProcessing
                                    ? 'text-sky-400'
                                    : isCanceled
                                    ? 'text-rose-400'
                                    : 'text-blue-400'
                                }`}
                              >
                                {isPrinted
                                  ? 'مؤكدة ومطبوعة (Printed)'
                                  : isPending
                                  ? 'قيد الانتظار (Pending)'
                                  : isProcessing
                                  ? 'قيد التجهيز (Processing)'
                                  : isCanceled
                                  ? 'ملغاة (Canceled)'
                                  : isNew
                                  ? 'جديدة واردة (New)'
                                  : s.status}
                              </span>
                            </td>
                            <td className="py-3 px-4 font-bold text-slate-100">
                              {s.count.toLocaleString()}
                            </td>
                            <td className="py-3 px-4 font-sans">
                              <div className="flex items-center gap-2">
                                <div className="w-16 bg-slate-800 h-1.5 rounded-full overflow-hidden">
                                  <div
                                    style={{ width: `${Math.max(4, Number(pct))}%` }}
                                    className={`h-full rounded-full ${
                                      isPrinted
                                        ? 'bg-emerald-400'
                                        : isPending
                                        ? 'bg-amber-400'
                                        : isProcessing
                                        ? 'bg-sky-400'
                                        : isCanceled
                                        ? 'bg-rose-400'
                                        : 'bg-blue-400'
                                    }`}
                                  />
                                </div>
                                <span className="font-mono text-xs text-slate-300">{pct}%</span>
                              </div>
                            </td>
                            <td className="py-3 px-4 font-bold text-slate-200">
                              {s.total_value.toLocaleString()} <span className="text-[10px] text-slate-500 font-sans">ج.م</span>
                            </td>
                            <td className="py-3 px-4 text-slate-400">
                              {aov.toLocaleString()} <span className="text-[10px] text-slate-500 font-sans">ج.م</span>
                            </td>
                            <td className="py-3 px-4 font-sans text-slate-400 text-[11px]">
                              {isPrinted && 'تم تأكيد الطلب وطباعة البوليصة وجاهز للشحن'}
                              {isPending && 'في انتظار مراجعة وتأكيد خدمة العملاء'}
                              {isProcessing && 'قيد الجمع والتجهيز داخل المخزن'}
                              {isNew && 'طلب جديد ورد من المتجر الإلكتروني'}
                              {isCanceled && 'تم إلغاء الطلب بناءً على طلب العميل أو المتجر'}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>

          {/* 4. DEEP-DIVE TABS NAVIGATION */}
          <div className="flex items-center gap-2 border-b border-slate-800 pb-1 text-xs font-semibold overflow-x-auto print:hidden">
            <button
              onClick={() => setActiveTab('overview')}
              className={`px-4 py-2.5 border-b-2 transition-all cursor-pointer flex items-center gap-2 shrink-0 ${
                activeTab === 'overview'
                  ? 'border-amber-400 text-amber-300 font-bold bg-amber-500/5 rounded-t-lg'
                  : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              <ArrowRightLeft className="w-4 h-4" />
              <span>مصفوفة التحويلات والنشاط اليومي</span>
            </button>

            <button
              onClick={() => setActiveTab('warehouses')}
              className={`px-4 py-2.5 border-b-2 transition-all cursor-pointer flex items-center gap-2 shrink-0 ${
                activeTab === 'warehouses'
                  ? 'border-amber-400 text-amber-300 font-bold bg-amber-500/5 rounded-t-lg'
                  : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              <Building2 className="w-4 h-4 text-amber-400" />
              <span>تقرير المخازن والأصناف ({data.warehouses?.length || 0})</span>
            </button>

            <button
              onClick={() => setActiveTab('team')}
              className={`px-4 py-2.5 border-b-2 transition-all cursor-pointer flex items-center gap-2 shrink-0 ${
                activeTab === 'team'
                  ? 'border-amber-400 text-amber-300 font-bold bg-amber-500/5 rounded-t-lg'
                  : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              <Users className="w-4 h-4 text-sky-400" />
              <span>إنتاجية الفريق والعمليات ({data.employees?.length || 0})</span>
            </button>

            <button
              onClick={() => setActiveTab('regions')}
              className={`px-4 py-2.5 border-b-2 transition-all cursor-pointer flex items-center gap-2 shrink-0 ${
                activeTab === 'regions'
                  ? 'border-amber-400 text-amber-300 font-bold bg-amber-500/5 rounded-t-lg'
                  : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              <MapPin className="w-4 h-4 text-emerald-400" />
              <span>التوزيع الجغرافي والمحافظات</span>
            </button>
          </div>

          {/* TAB 1: OVERVIEW & TRANSITIONS */}
          {(activeTab === 'overview' || typeof window !== 'undefined') && (
            <div className={`space-y-6 ${activeTab !== 'overview' ? 'hidden print:block' : ''}`}>
              {/* Daily / Timeline Activity Distribution */}
              {data.timeline && data.timeline.length > 1 && (
                <div className="p-5 rounded-2xl bg-slate-900/60 border border-slate-800 space-y-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <h3 className="text-sm font-bold text-slate-200 flex items-center gap-2">
                        <BarChart3 className="w-4 h-4 text-amber-400" />
                        <span>التوزيع الزمني للنشاط والعمليات عبر الأيام</span>
                      </h3>
                      <p className="text-xs text-slate-400 mt-0.5">
                        حجم العمليات والطلبات التي خضعت للتحديث يومياً في هذا النطاق
                      </p>
                    </div>
                    <span className="text-xs font-mono text-slate-400 bg-slate-950 px-2.5 py-1 rounded border border-slate-800">
                      {data.timeline.length} يوم مسجل
                    </span>
                  </div>

                  <div className="grid grid-cols-7 md:grid-cols-14 lg:grid-cols-30 gap-1.5 items-end h-32 pt-4 border-b border-slate-800/80">
                    {data.timeline.map((item, idx) => {
                      const heightPercent = Math.max(12, Math.round((item.events_count / maxTimelineEvents) * 100));
                      return (
                        <div
                          key={idx}
                          className="flex flex-col items-center gap-1 h-full justify-end group relative"
                        >
                          {/* Tooltip on Hover */}
                          <div className="opacity-0 group-hover:opacity-100 transition-opacity absolute bottom-full mb-1 z-20 pointer-events-none bg-slate-950 border border-slate-700 text-[10px] text-slate-200 p-2 rounded-lg shadow-xl whitespace-nowrap">
                            <div className="font-bold text-amber-400 font-mono">{item.date}</div>
                            <div>العمليات: {item.events_count}</div>
                            <div>الطلبات: {item.unique_orders}</div>
                          </div>
                          {/* Bar */}
                          <div
                            style={{ height: `${heightPercent}%` }}
                            className="w-full rounded-t bg-gradient-to-t from-amber-600/70 to-amber-400/80 hover:to-amber-300 transition-all cursor-pointer"
                          />
                          <span className="text-[9px] font-mono text-slate-500 truncate w-full text-center">
                            {item.date.slice(5)}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Status Transitions Matrix & Cancellations Breakdown */}
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                {/* Transitions Table (8 Cols) */}
                <div className="lg:col-span-8 p-5 rounded-2xl bg-slate-900/60 border border-slate-800 space-y-4 shadow-sm">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-bold text-slate-200 flex items-center gap-2">
                        <ArrowRightLeft className="w-4 h-4 text-emerald-400" />
                        <span>مصفوفة انتقالات الحالات الموثقة (Status Transitions)</span>
                      </h3>
                      <p className="text-xs text-slate-400 mt-0.5">
                        حركات الانتقال من حالة إلى أخرى بناءً على سجلات النشاط التشغيلية
                      </p>
                    </div>

                    <div className="relative w-full sm:w-56">
                      <Search className="w-3.5 h-3.5 absolute right-3 top-2.5 text-slate-500" />
                      <input
                        type="text"
                        value={transitionSearch}
                        onChange={(e) => setTransitionSearch(e.target.value)}
                        placeholder="بحث بالحالة..."
                        className="w-full bg-slate-950 border border-slate-800 rounded-lg pr-9 pl-3 py-1.5 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-amber-500/50"
                      />
                    </div>
                  </div>

                  <div className="border border-slate-800/80 rounded-xl overflow-hidden bg-slate-950/40">
                    <table className="w-full text-right text-xs">
                      <thead>
                        <tr className="border-b border-slate-800 bg-slate-950/80 text-slate-400">
                          <th className="py-3 px-3 font-semibold">مسار الانتقال</th>
                          <th className="py-3 px-3 font-semibold">الحالة السابقة</th>
                          <th className="py-3 px-3 font-semibold">الحالة الجديدة</th>
                          <th className="py-3 px-3 font-semibold font-mono">المرات</th>
                          <th className="py-3 px-3 font-semibold font-mono">النسبة</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800/60">
                        {filteredTransitions.length === 0 ? (
                          <tr>
                            <td colSpan={5} className="py-8 text-center text-slate-500">
                              لا توجد انتقالات مسجلة مطابقة لمعايير البحث
                            </td>
                          </tr>
                        ) : (
                          filteredTransitions.map((t, idx) => {
                            const totalT = data.transitions.reduce((acc, curr) => acc + curr.count, 0) || 1;
                            const share = Math.round((t.count / totalT) * 100);
                            return (
                              <tr key={idx} className="hover:bg-slate-800/30 transition-colors">
                                <td className="py-2.5 px-3 font-mono text-slate-300 flex items-center gap-1.5">
                                  <span>{t.from_status || 'بداية'}</span>
                                  <span className="text-slate-500">←</span>
                                  <span
                                    className={`font-bold ${
                                      t.to_status === 'Printed'
                                        ? 'text-emerald-400'
                                        : t.to_status === 'Pending'
                                        ? 'text-amber-400'
                                        : t.to_status === 'Processing'
                                        ? 'text-sky-400'
                                        : t.to_status === 'Canceled'
                                        ? 'text-rose-400'
                                        : 'text-slate-200'
                                    }`}
                                  >
                                    {t.to_status}
                                  </span>
                                </td>
                                <td className="py-2.5 px-3 text-slate-400">
                                  {t.from_status || 'طلب جديد'}
                                </td>
                                <td className="py-2.5 px-3 font-medium text-slate-200">
                                  {t.to_status}
                                </td>
                                <td className="py-2.5 px-3 font-mono font-bold text-slate-100">
                                  {t.count.toLocaleString()}
                                </td>
                                <td className="py-2.5 px-3">
                                  <div className="flex items-center gap-2">
                                    <div className="w-16 bg-slate-800 h-1.5 rounded-full overflow-hidden">
                                      <div
                                        style={{ width: `${Math.min(100, Math.max(5, share))}%` }}
                                        className="bg-amber-400 h-full rounded-full"
                                      />
                                    </div>
                                    <span className="font-mono text-[11px] text-slate-400">{share}%</span>
                                  </div>
                                </td>
                              </tr>
                            );
                          })
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Cancellations Breakdown Card (4 Cols) */}
                <div className="lg:col-span-4 p-5 rounded-2xl bg-slate-900/60 border border-slate-800 space-y-4 shadow-sm">
                  <div>
                    <h3 className="text-sm font-bold text-slate-200 flex items-center gap-2">
                      <XCircle className="w-4 h-4 text-rose-400" />
                      <span>تحليل حركات الإلغاء (Cancellations)</span>
                    </h3>
                    <p className="text-xs text-slate-400 mt-0.5">
                      تفصيل الطلبات التي تحولت إلى قيد الإلغاء أو ملغية
                    </p>
                  </div>

                  {data.cancellations.length === 0 ? (
                    <div className="py-12 text-center text-slate-500 text-xs">
                      لا توجد أي حركات إلغاء مسجلة في هذا النطاق الزمني
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {data.cancellations.map((c, idx) => {
                        const pct = totalCancellations > 0 ? Math.round((c.count / totalCancellations) * 100) : 0;
                        return (
                          <div
                            key={idx}
                            className="p-3.5 rounded-xl bg-slate-950/60 border border-slate-800/80 space-y-2"
                          >
                            <div className="flex items-center justify-between text-xs">
                              <span className="font-bold text-rose-300">{c.to_status}</span>
                              <span className="font-mono font-bold text-rose-400">
                                {c.count.toLocaleString()} عملية ({pct}%)
                              </span>
                            </div>
                            <div className="w-full bg-slate-800 h-2 rounded-full overflow-hidden">
                              <div
                                style={{ width: `${Math.max(5, pct)}%` }}
                                className="bg-rose-500 h-full rounded-full"
                              />
                            </div>
                          </div>
                        );
                      })}

                      <div className="p-3 bg-rose-500/10 border border-rose-500/20 rounded-xl text-xs text-rose-300">
                        <span className="font-bold">إجمالي الإلغاءات:</span> {totalCancellations.toLocaleString()} طلب
                        {data.createdCount > 0 && (
                          <span className="text-slate-400 mr-2 font-mono">
                            (تمثل {Math.round((totalCancellations / data.createdCount) * 100)}% من حجم الإنشاء)
                          </span>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* TAB 2: WAREHOUSES REPORT (المخازن) */}
          {(activeTab === 'warehouses' || typeof window !== 'undefined') && (
            <div className={`space-y-6 ${activeTab !== 'warehouses' ? 'hidden print:block' : ''}`}>
              {/* Warehouses Summary Cards */}
              <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
                <div className="p-4 rounded-xl bg-slate-900/80 border border-slate-800">
                  <div className="text-xs text-slate-400">إجمالي المخازن النشطة</div>
                  <div className="text-2xl font-bold font-mono text-amber-400 mt-1">
                    {data.warehouses?.length || 0} <span className="text-xs text-slate-500">مخزن</span>
                  </div>
                  <div className="text-[11px] text-slate-500 mt-0.5">
                    مخازن سُجلت لها أصناف أو بضائع
                  </div>
                </div>

                <div className="p-4 rounded-xl bg-slate-900/80 border border-slate-800">
                  <div className="text-xs text-slate-400">إجمالي كمية الأصناف والقطع</div>
                  <div className="text-2xl font-bold font-mono text-emerald-400 mt-1">
                    {totalWarehouseItems.toLocaleString()} <span className="text-xs text-slate-500">قطعة</span>
                  </div>
                  <div className="text-[11px] text-slate-500 mt-0.5">
                    إجمالي المنتجات المسحوبة من المخازن
                  </div>
                </div>

                <div className="p-4 rounded-xl bg-slate-900/80 border border-slate-800">
                  <div className="text-xs text-slate-400">تركز أعلى 3 مخازن</div>
                  <div className="text-2xl font-bold font-mono text-sky-400 mt-1">
                    {top3WarehouseConcentration}% <span className="text-xs text-slate-500">من القطع</span>
                  </div>
                  <div className="text-[11px] text-slate-500 mt-0.5">
                    نسبة الاستحواذ لأول 3 مخازن
                  </div>
                </div>

                <div className="p-4 rounded-xl bg-slate-900/80 border border-slate-800">
                  <div className="text-xs text-slate-400">طلبات شحن متعددة المخازن</div>
                  <div className="text-2xl font-bold font-mono text-rose-400 mt-1">
                    {(data.multiWarehouseCount || 0).toLocaleString()} <span className="text-xs text-slate-500">طلب</span>
                  </div>
                  <div className="text-[11px] text-slate-500 mt-0.5">
                    تتطلب تجزئة وتنسيق بوالص
                  </div>
                </div>
              </div>

              {/* Warehouses Table */}
              <div className="p-5 rounded-2xl bg-slate-900/60 border border-slate-800 space-y-4 shadow-sm">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-bold text-slate-200 flex items-center gap-2">
                      <Building2 className="w-4 h-4 text-amber-400" />
                      <span>جدول أداء وكثافة تشغيل المخازن (Warehouses Breakdown)</span>
                    </h3>
                    <p className="text-xs text-slate-400 mt-0.5">
                      تفصيل عدد الطلبات والكميات المسحوبة لكل مخزن مع القيمة التقديرية والحصة النسبية
                    </p>
                  </div>

                  {/* Filters & Sorting */}
                  <div className="flex items-center gap-2 w-full sm:w-auto">
                    <div className="flex items-center gap-1 bg-slate-950 p-1 rounded-lg border border-slate-800 text-xs">
                      <span className="text-slate-500 text-[11px] px-1.5">ترتيب:</span>
                      <button
                        onClick={() => setWarehouseSort('items')}
                        className={`px-2 py-1 rounded cursor-pointer ${warehouseSort === 'items' ? 'bg-amber-500/20 text-amber-300 font-bold' : 'text-slate-400'}`}
                      >
                        القطع
                      </button>
                      <button
                        onClick={() => setWarehouseSort('orders')}
                        className={`px-2 py-1 rounded cursor-pointer ${warehouseSort === 'orders' ? 'bg-amber-500/20 text-amber-300 font-bold' : 'text-slate-400'}`}
                      >
                        الطلبات
                      </button>
                      <button
                        onClick={() => setWarehouseSort('revenue')}
                        className={`px-2 py-1 rounded cursor-pointer ${warehouseSort === 'revenue' ? 'bg-amber-500/20 text-amber-300 font-bold' : 'text-slate-400'}`}
                      >
                        القيمة
                      </button>
                    </div>

                    <div className="relative w-full sm:w-56">
                      <Search className="w-3.5 h-3.5 absolute right-3 top-2.5 text-slate-500" />
                      <input
                        type="text"
                        value={warehouseSearch}
                        onChange={(e) => setWarehouseSearch(e.target.value)}
                        placeholder="بحث بكود المخزن..."
                        className="w-full bg-slate-950 border border-slate-800 rounded-lg pr-9 pl-3 py-1.5 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-amber-500/50"
                      />
                    </div>
                  </div>
                </div>

                <div className="border border-slate-800/80 rounded-xl overflow-hidden bg-slate-950/40">
                  <table className="w-full text-right text-xs">
                    <thead>
                      <tr className="border-b border-slate-800 bg-slate-950/80 text-slate-400">
                        <th className="py-3 px-4 font-semibold">م</th>
                        <th className="py-3 px-4 font-semibold">كود المخزن</th>
                        <th className="py-3 px-4 font-semibold font-mono">عدد الطلبات</th>
                        <th className="py-3 px-4 font-semibold font-mono">إجمالي القطع</th>
                        <th className="py-3 px-4 font-semibold">حصة المخزن من القطع</th>
                        <th className="py-3 px-4 font-semibold font-mono">القيمة التقديرية (ج.م)</th>
                        <th className="py-3 px-4 font-semibold">التصنيف التشغيلي</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/60 font-mono">
                      {processedWarehouses.length === 0 ? (
                        <tr>
                          <td colSpan={7} className="py-8 text-center text-slate-500 font-sans">
                            لا توجد بيانات مخازن مطابقة لمعايير البحث
                          </td>
                        </tr>
                      ) : (
                        processedWarehouses.map((w, idx) => {
                          const share = totalWarehouseItems > 0 ? Math.round((w.items_quantity / totalWarehouseItems) * 100) : 0;
                          return (
                            <tr key={idx} className="hover:bg-slate-800/30 transition-colors">
                              <td className="py-3 px-4 text-slate-500 font-mono">{idx + 1}</td>
                              <td className="py-3 px-4 font-bold text-amber-300 font-mono text-sm">
                                {w.warehouse_code}
                              </td>
                              <td className="py-3 px-4 font-bold text-slate-100">
                                {w.orders_count.toLocaleString()}
                              </td>
                              <td className="py-3 px-4 font-bold text-emerald-400">
                                {w.items_quantity.toLocaleString()}
                              </td>
                              <td className="py-3 px-4 font-sans">
                                <div className="flex items-center gap-2">
                                  <div className="w-24 bg-slate-800 h-2 rounded-full overflow-hidden">
                                    <div
                                      style={{ width: `${Math.min(100, Math.max(4, share))}%` }}
                                      className="bg-amber-400 h-full rounded-full"
                                    />
                                  </div>
                                  <span className="font-mono text-xs text-slate-300">{share}%</span>
                                </div>
                              </td>
                              <td className="py-3 px-4 font-bold text-slate-200">
                                {(w.associated_revenue || 0).toLocaleString()} <span className="text-[10px] text-slate-500 font-sans">ج.م</span>
                              </td>
                              <td className="py-3 px-4 font-sans">
                                {share >= 20 ? (
                                  <span className="text-[11px] font-semibold text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 rounded">
                                    مخزن رئيسي استراتيجي
                                  </span>
                                ) : share >= 5 ? (
                                  <span className="text-[11px] font-semibold text-sky-400 bg-sky-500/10 border border-sky-500/20 px-2 py-0.5 rounded">
                                    مخزن نشط
                                  </span>
                                ) : (
                                  <span className="text-[11px] text-slate-400 bg-slate-800/50 px-2 py-0.5 rounded">
                                    مخزن اعتيادي
                                  </span>
                                )}
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* TAB 3: TEAM & EMPLOYEES PERFORMANCE */}
          {(activeTab === 'team' || typeof window !== 'undefined') && (
            <div className={`space-y-6 ${activeTab !== 'team' ? 'hidden print:block' : ''}`}>
              <div className="p-5 rounded-2xl bg-slate-900/60 border border-slate-800 space-y-4 shadow-sm">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-bold text-slate-200 flex items-center gap-2">
                      <Users className="w-4 h-4 text-sky-400" />
                      <span>تقرير إنتاجية الفريق والعمليات (Staff Productivity)</span>
                    </h3>
                    <p className="text-xs text-slate-400 mt-0.5">
                      تتبع الإجراءات البشرية المنفذة على الطلبات والموثقة في سجلات النشاط التشغيلية
                    </p>
                  </div>

                  <div className="relative w-full sm:w-64">
                    <Search className="w-3.5 h-3.5 absolute right-3 top-2.5 text-slate-500" />
                    <input
                      type="text"
                      value={employeeSearch}
                      onChange={(e) => setEmployeeSearch(e.target.value)}
                      placeholder="بحث باسم الموظف..."
                      className="w-full bg-slate-950 border border-slate-800 rounded-lg pr-9 pl-3 py-1.5 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-amber-500/50"
                    />
                  </div>
                </div>

                <div className="border border-slate-800/80 rounded-xl overflow-hidden bg-slate-950/40">
                  <table className="w-full text-right text-xs">
                    <thead>
                      <tr className="border-b border-slate-800 bg-slate-950/80 text-slate-400">
                        <th className="py-3 px-4 font-semibold">م</th>
                        <th className="py-3 px-4 font-semibold">اسم الموظف / المسؤول</th>
                        <th className="py-3 px-4 font-semibold font-mono">إجمالي الحركات</th>
                        <th className="py-3 px-4 font-semibold font-mono">الطلبات المنجزة</th>
                        <th className="py-3 px-4 font-semibold font-mono">تأكيدات الطباعة</th>
                        <th className="py-3 px-4 font-semibold font-mono">الإلغاءات</th>
                        <th className="py-3 px-4 font-semibold">معدل الحركات/طلب</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/60 font-mono">
                      {filteredEmployees.length === 0 ? (
                        <tr>
                          <td colSpan={7} className="py-8 text-center text-slate-500 font-sans">
                            لا توجد بيانات موظفين مسجلة مطابقة لمعايير البحث
                          </td>
                        </tr>
                      ) : (
                        filteredEmployees.map((emp, idx) => (
                          <tr key={idx} className="hover:bg-slate-800/30 transition-colors">
                            <td className="py-3 px-4 text-slate-500 font-mono">{idx + 1}</td>
                            <td className="py-3 px-4 font-sans font-bold text-slate-200">
                              {emp.actor_name}
                            </td>
                            <td className="py-3 px-4 font-bold text-amber-400">
                              {emp.action_count.toLocaleString()}
                            </td>
                            <td className="py-3 px-4 font-bold text-sky-400">
                              {emp.unique_orders.toLocaleString()}
                            </td>
                            <td className="py-3 px-4 font-bold text-emerald-400">
                              {(emp.printed_count || 0).toLocaleString()}
                            </td>
                            <td className="py-3 px-4 font-bold text-rose-400">
                              {(emp.cancel_count || 0).toLocaleString()}
                            </td>
                            <td className="py-3 px-4 font-sans">
                              <span className="text-[11px] font-mono text-slate-300 bg-slate-800 px-2.5 py-1 rounded">
                                {emp.unique_orders > 0 ? `${(emp.action_count / emp.unique_orders).toFixed(1)} حركة/طلب` : '—'}
                              </span>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* TAB 4: GOVERNORATES & REGIONS */}
          {(activeTab === 'regions' || typeof window !== 'undefined') && (
            <div className={`space-y-6 ${activeTab !== 'regions' ? 'hidden print:block' : ''}`}>
              <div className="p-5 rounded-2xl bg-slate-900/60 border border-slate-800 space-y-4 shadow-sm">
                <div>
                  <h3 className="text-sm font-bold text-slate-200 flex items-center gap-2">
                    <MapPin className="w-4 h-4 text-amber-400" />
                    <span>التوزيع الجغرافي وحجم الطلبات بالمحافظات (Governorates)</span>
                  </h3>
                  <p className="text-xs text-slate-400 mt-0.5">
                    كثافة الطلبات ومناطق التسليم المستهدفة مع القيمة المالية
                  </p>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                  {data.governorates && data.governorates.length > 0 ? (
                    data.governorates.map((gov, idx) => {
                      const totalGov = data.governorates!.reduce((acc, curr) => acc + curr.count, 0) || 1;
                      const pct = Math.round((gov.count / totalGov) * 100);
                      return (
                        <div
                          key={idx}
                          className="p-4 rounded-xl bg-slate-950/60 border border-slate-800 space-y-2 hover:border-slate-700 transition-colors"
                        >
                          <div className="flex items-center justify-between text-xs">
                            <span className="font-bold text-slate-200">{gov.governorate}</span>
                            <span className="font-mono font-bold text-amber-400">
                              {gov.count.toLocaleString()} طلب
                            </span>
                          </div>
                          <div className="w-full bg-slate-800 h-1.5 rounded-full overflow-hidden">
                            <div
                              style={{ width: `${Math.max(5, pct)}%` }}
                              className="bg-amber-400 h-full rounded-full"
                            />
                          </div>
                          <div className="flex items-center justify-between text-[10px] text-slate-500 font-mono">
                            <span>{pct}% من الطلبات</span>
                            {gov.total_value ? <span>{(gov.total_value).toLocaleString()} ج.م</span> : null}
                          </div>
                        </div>
                      );
                    })
                  ) : (
                    <div className="col-span-full py-8 text-center text-slate-500 text-xs">
                      لا توجد بيانات محافظات مسجلة
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      ) : null}

      {/* KPI Drilldown Modal for Detailed Orders and Data */}
      <ReportKpiDrilldownModal
        isOpen={Boolean(drilldownPillar)}
        onClose={() => setDrilldownPillar(null)}
        pillar={drilldownPillar}
        startDate={data?.startDate || ''}
        endDate={data?.endDate || ''}
        periodLabel={
          period === 'today'
            ? 'اليوم'
            : period === 'yesterday'
            ? 'أمس'
            : period === 'last_7_days'
            ? 'آخر 7 أيام'
            : period === 'last_30_days'
            ? 'آخر 30 يوماً'
            : 'مخصص'
        }
        reportData={data}
        onSelectOrder={onSelectOrder}
      />
    </div>
  );
};
