import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  X,
  AlertTriangle,
  Copy,
  Download,
  Search,
  RefreshCw,
  ExternalLink,
  ChevronLeft,
  ChevronRight,
  Building2,
  PhoneCall,
  Percent,
  Check,
  Package,
  Layers,
  MapPin,
  Clock,
  ShieldAlert,
  Filter,
} from 'lucide-react';
import { OrderDetailsModal } from './OrderDetailsModal';

export type RiskType = 'multi_merchant' | 'no_extra_phone' | 'low_delivery';

interface EnrichedRiskItem {
  id: number;
  product_name: string;
  warehouse_name: string | null;
  warehouse_code: string | null;
  merchant_code: string | null;
  merchant_name: string | null;
  quantity: number;
  unit_price: number;
  sku: string | null;
}

interface EnrichedRiskOrder {
  id: number;
  vendoor_id: number;
  random_number: string;
  order_no: string | null;
  current_status: string;
  customer_name: string | null;
  customer_phone: string;
  customer_phone_extra: string | null;
  extra_phone_valid: number;
  extra_phone_status: string | null;
  governorate: string | null;
  address: string | null;
  total_order: number;
  total_price: number;
  shipping_cost: number;
  created_at_source: string | null;
  printed_date: string | null;
  multi_merchant_flag: number;
  distinct_merchant_count: number;
  delivery_rate: number | null;
  delivery_rate_num: number | null;
  delivery_rate_denom: number | null;
  cancel_rate: number | null;
  cancel_rate_num: number | null;
  cancel_rate_denom: number | null;
  total_customer_orders: number | null;
  customer_last_order_status: string | null;
  is_printed_today: boolean;
  items: EnrichedRiskItem[];
  warehouses: Array<{ name: string; code: string }>;
  merchantCodes: string[];
}

interface RiskOrdersApiResponse {
  success: boolean;
  riskType: RiskType;
  targetDate: string;
  totalSystemMatching: number;
  todayPrintedMatching: number;
  filteredCount: number;
  tabCounts: {
    all: number;
    today_printed: number;
    Pending: number;
    Processing: number;
    Printed: number;
    Canceling: number;
    Canceled: number;
    New: number;
  };
  orders: EnrichedRiskOrder[];
  page: number;
  limit: number;
  totalPages: number;
}

interface RiskDetailsModalProps {
  isOpen: boolean;
  riskType: RiskType | null;
  selectedDate?: string;
  initialTab?: string;
  onClose: () => void;
}

const STATUS_ARABIC: Record<string, { label: string; color: string; bg: string }> = {
  New: { label: 'أوردر جديد', color: 'text-sky-400', bg: 'bg-sky-500/15 border-sky-500/30' },
  Pending: { label: 'معلق', color: 'text-amber-400', bg: 'bg-amber-500/15 border-amber-500/30' },
  Processing: { label: 'قيد التنفيذ', color: 'text-blue-400', bg: 'bg-blue-500/15 border-blue-500/30' },
  Printed: { label: 'مطبوع / مؤكد', color: 'text-emerald-400', bg: 'bg-emerald-500/15 border-emerald-500/30' },
  Canceling: { label: 'قيد الإلغاء', color: 'text-orange-400', bg: 'bg-orange-500/15 border-orange-500/30' },
  Canceled: { label: 'ملغي نهائي', color: 'text-rose-400', bg: 'bg-rose-500/15 border-rose-500/30' },
};

export const RiskDetailsModal: React.FC<RiskDetailsModalProps> = ({
  isOpen,
  riskType,
  selectedDate,
  initialTab = 'all',
  onClose,
}) => {
  const [activeTab, setActiveTab] = useState<string>(initialTab);
  const [searchInput, setSearchInput] = useState<string>('');
  const [debouncedSearch, setDebouncedSearch] = useState<string>('');
  const [page, setPage] = useState<number>(0);
  const [limit] = useState<number>(50);

  const [loading, setLoading] = useState<boolean>(false);
  const [data, setData] = useState<RiskOrdersApiResponse | null>(null);
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);

  // Selected order for detailed child modal view
  const [viewingOrderCode, setViewingOrderCode] = useState<string | null>(null);

  // Debounce search input
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchInput.trim());
      setPage(0);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const autoSwitchedRef = React.useRef(false);

  // Reset tab and page when modal opens or riskType changes
  useEffect(() => {
    if (isOpen) {
      setActiveTab(initialTab || 'all');
      setSearchInput('');
      setDebouncedSearch('');
      setPage(0);
      autoSwitchedRef.current = false;
    }
  }, [isOpen, riskType, initialTab]);

  const fetchData = useCallback(async () => {
    if (!riskType) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({
        riskType,
        tab: activeTab,
        search: debouncedSearch,
        page: String(page),
        limit: String(limit),
      });
      if (selectedDate) {
        params.set('date', selectedDate);
      }

      const res = await fetch(`/api/dashboard/risk-orders?${params.toString()}`);
      if (!res.ok) {
        throw new Error(`HTTP error: ${res.status}`);
      }
      const json: RiskOrdersApiResponse = await res.json();
      setData(json);

      // If user opened on today_printed but today has 0 and all has items, auto-switch to 'all' so orders appear immediately
      if (activeTab === 'today_printed' && json.tabCounts?.today_printed === 0 && (json.tabCounts?.all || 0) > 0 && !autoSwitchedRef.current) {
        autoSwitchedRef.current = true;
        setActiveTab('all');
      }
    } catch (err) {
      console.error('Failed to fetch risk orders drilldown:', err);
    } finally {
      setLoading(false);
    }
  }, [riskType, activeTab, debouncedSearch, page, limit, selectedDate]);

  useEffect(() => {
    if (isOpen && riskType) {
      fetchData();
      const interval = setInterval(() => {
        fetchData();
      }, 10000);
      return () => clearInterval(interval);
    }
  }, [isOpen, riskType, fetchData]);

  if (!isOpen || !riskType) return null;

  // Metadata per risk type
  const meta = {
    multi_merchant: {
      title: 'تعدد أكواد المخازن والتجار (Multi-Warehouse / Multi-Merchant)',
      description: 'طلبات تحتوي على سلع مشحونة من أكثر من كود مخزن أو مورد مستقل في نفس الشحنة.',
      badgeColor: 'text-rose-400 bg-rose-500/10 border-rose-500/30',
      icon: <Building2 className="w-5 h-5 text-rose-400" />,
    },
    no_extra_phone: {
      title: 'طلبات دون هاتف إضافي صالح (Missing Extra Phone)',
      description: 'طلبات لم يُسجل بها هاتف بديل، أو الهاتف الإضافي مطابق للهاتف الأساسي أو صيغته غير صحيحة.',
      badgeColor: 'text-amber-400 bg-amber-500/10 border-amber-500/30',
      icon: <PhoneCall className="w-5 h-5 text-amber-400" />,
    },
    low_delivery: {
      title: 'نسبة تسليم العملاء أقل من 70% (Low Delivery Rate)',
      description: 'عملاء لديهم سجل تاريخي لطلبات سابقة بنسبة استلام منخفضة تستوجب تدقيق المتابعة قبل الشحن.',
      badgeColor: 'text-rose-400 bg-rose-500/10 border-rose-500/30',
      icon: <Percent className="w-5 h-5 text-rose-400" />,
    },
  }[riskType];

  const tabCounts = data?.tabCounts || {
    all: 0,
    today_printed: 0,
    Pending: 0,
    Processing: 0,
    Printed: 0,
    Canceling: 0,
    Canceled: 0,
    New: 0,
  };

  const tabs = [
    { key: 'all', label: 'الكل في النظام', count: tabCounts.all, accent: 'border-slate-700' },
    { key: 'today_printed', label: 'مؤكد اليوم Printed', count: tabCounts.today_printed, accent: 'text-emerald-400 border-emerald-500/40 bg-emerald-500/10' },
    { key: 'Pending', label: 'معلق (Pending)', count: tabCounts.Pending, accent: 'text-amber-400' },
    { key: 'Processing', label: 'قيد التنفيذ (Processing)', count: tabCounts.Processing, accent: 'text-blue-400' },
    { key: 'Printed', label: 'مطبوع (Printed)', count: tabCounts.Printed, accent: 'text-emerald-400' },
    { key: 'Canceling', label: 'قيد الإلغاء (Canceling)', count: tabCounts.Canceling, accent: 'text-orange-400' },
    { key: 'Canceled', label: 'ملغي (Canceled)', count: tabCounts.Canceled, accent: 'text-rose-400' },
    { key: 'New', label: 'أوردر جديد', count: tabCounts.New, accent: 'text-sky-400' },
  ];

  // Quick Action: Copy order codes
  const handleCopyCodes = () => {
    if (!data || !data.orders || data.orders.length === 0) return;
    const codes = Array.from(new Set(data.orders.map(o => o.random_number || o.order_no).filter(Boolean)));
    const text = codes.join('\n');
    navigator.clipboard.writeText(text).then(() => {
      setCopyFeedback(`تم نسخ ${codes.length} كود بنجاح`);
      setTimeout(() => setCopyFeedback(null), 2500);
    }).catch(err => {
      console.error('Failed to copy to clipboard:', err);
    });
  };

  // Quick Action: Export CSV with UTF-8 BOM
  const handleExportCSV = () => {
    if (!data || !data.orders || data.orders.length === 0) return;

    let headers: string[] = [];
    let rows: string[][] = [];

    if (riskType === 'multi_merchant') {
      headers = [
        'كود الطلب',
        'رقم الطلب Vendoor',
        'الحالة الحالية',
        'اسم العميل',
        'الهاتف الأساسي',
        'المحافظة',
        'إجمالي الطلب',
        'عدد المخازن',
        'أسماء وأكواد المخازن',
        'أكواد التجار',
        'تفاصيل المنتجات',
        'مؤكد اليوم (Printed)',
      ];
      rows = data.orders.map(o => [
        o.random_number,
        o.order_no || String(o.vendoor_id),
        STATUS_ARABIC[o.current_status]?.label || o.current_status,
        o.customer_name || '',
        o.customer_phone || '',
        o.governorate || '',
        String(o.total_order || o.total_price || 0),
        String(o.warehouses?.length || 0),
        o.warehouses?.map(w => `${w.name} (${w.code})`).join(' | ') || '',
        o.merchantCodes?.join(' | ') || '',
        o.items?.map(i => `${i.product_name} [${i.warehouse_code || 'N/A'}] x${i.quantity}`).join(' ; ') || '',
        o.is_printed_today ? 'نعم' : 'لا',
      ]);
    } else if (riskType === 'no_extra_phone') {
      headers = [
        'كود الطلب',
        'رقم الطلب Vendoor',
        'الحالة الحالية',
        'اسم العميل',
        'الهاتف الأساسي',
        'الهاتف الإضافي',
        'حالة الهاتف الإضافي',
        'المحافظة',
        'العنوان',
        'إجمالي الطلب',
        'نسبة التسليم السابقة',
        'مؤكد اليوم (Printed)',
      ];
      rows = data.orders.map(o => [
        o.random_number,
        o.order_no || String(o.vendoor_id),
        STATUS_ARABIC[o.current_status]?.label || o.current_status,
        o.customer_name || '',
        o.customer_phone || '',
        o.customer_phone_extra || 'غير متوفر',
        o.extra_phone_status || (o.extra_phone_valid ? 'صالح' : 'غير صالح'),
        o.governorate || '',
        (o.address || '').replace(/[\r\n]+/g, ' '),
        String(o.total_order || o.total_price || 0),
        o.delivery_rate !== null ? `${o.delivery_rate}%` : 'لا يوجد سجل',
        o.is_printed_today ? 'نعم' : 'لا',
      ]);
    } else {
      headers = [
        'كود الطلب',
        'رقم الطلب Vendoor',
        'الحالة الحالية',
        'اسم العميل',
        'الهاتف الأساسي',
        'المحافظة',
        'نسبة التسليم',
        'كسر التسليم (مستلم/إجمالي)',
        'نسبة الإلغاء',
        'كسر الإلغاء (ملغي/إجمالي)',
        'إجمالي طلبات العميل',
        'حالة آخر طلب للعميل',
        'إجمالي الطلب',
        'مؤكد اليوم (Printed)',
      ];
      rows = data.orders.map(o => [
        o.random_number,
        o.order_no || String(o.vendoor_id),
        STATUS_ARABIC[o.current_status]?.label || o.current_status,
        o.customer_name || '',
        o.customer_phone || '',
        o.governorate || '',
        o.delivery_rate !== null ? `${o.delivery_rate}%` : 'N/A',
        (o.delivery_rate_num !== null && o.delivery_rate_denom !== null) ? `${o.delivery_rate_num}/${o.delivery_rate_denom}` : '',
        o.cancel_rate !== null ? `${o.cancel_rate}%` : '0%',
        (o.cancel_rate_num !== null && o.cancel_rate_denom !== null) ? `${o.cancel_rate_num}/${o.cancel_rate_denom}` : '',
        String(o.total_customer_orders || 0),
        o.customer_last_order_status || 'غير محدد',
        String(o.total_order || o.total_price || 0),
        o.is_printed_today ? 'نعم' : 'لا',
      ]);
    }

    const escapeCsv = (str: string) => `"${str.replace(/"/g, '""')}"`;
    const csvContent = '\uFEFF' + [
      headers.map(escapeCsv).join(','),
      ...rows.map(row => row.map(escapeCsv).join(',')),
    ].join('\r\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `risk_${riskType}_${activeTab}_${selectedDate || 'all'}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-3 sm:p-5 overflow-y-auto">
        <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-7xl max-h-[92vh] flex flex-col shadow-2xl overflow-hidden font-['Cairo',sans-serif]">
          {/* Header */}
          <div className="p-5 border-b border-slate-800 flex flex-col md:flex-row md:items-center justify-between gap-4 bg-slate-900/90">
            <div className="flex items-start gap-3">
              <div className="p-2.5 rounded-xl bg-slate-800 border border-slate-700/80 flex-shrink-0 mt-0.5">
                {meta.icon}
              </div>
              <div>
                <div className="flex items-center gap-2.5 flex-wrap">
                  <h2 className="text-lg font-bold text-slate-100">{meta.title}</h2>
                  <span className={`text-[11px] px-2.5 py-0.5 rounded-md font-mono font-semibold border ${meta.badgeColor}`}>
                    تحذير تشغيلي
                  </span>
                </div>
                <p className="text-xs text-slate-400 mt-1 leading-relaxed">
                  {meta.description}
                </p>
              </div>
            </div>

            {/* Quick Metrics & Close */}
            <div className="flex items-center gap-3 self-end md:self-center">
              <div className="flex items-center gap-2 bg-slate-950 px-3 py-1.5 rounded-xl border border-slate-800 text-xs">
                <span className="text-slate-400">إجمالي النظام المطابق:</span>
                <span className="font-mono font-bold text-slate-100 tabular-nums">
                  {data?.totalSystemMatching ?? '...'}
                </span>
                <span className="text-slate-600">|</span>
                <span className="text-emerald-400">مؤكد اليوم (Printed):</span>
                <span className="font-mono font-bold text-emerald-400 tabular-nums">
                  {data?.todayPrintedMatching ?? '...'}
                </span>
              </div>

              <button
                onClick={onClose}
                className="p-2 rounded-xl text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors cursor-pointer"
                title="إغلاق النافذة"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
          </div>

          {/* Segmented Filter Tabs */}
          <div className="px-5 py-3 border-b border-slate-800 bg-slate-950/80 backdrop-blur-md overflow-x-auto flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 flex-shrink-0">
              <div className="flex items-center gap-1.5 text-xs font-bold text-amber-400 bg-amber-500/10 px-2.5 py-1.5 rounded-lg border border-amber-500/25">
                <Filter className="w-3.5 h-3.5 text-amber-400" />
                <span>تصفية الحالات:</span>
              </div>

              <div className="flex items-center gap-1.5 p-1 bg-slate-900 rounded-xl border border-slate-800 shadow-inner">
                {tabs.map((tab) => {
                  const isActive = activeTab === tab.key;
                  const isTodayPrinted = tab.key === 'today_printed';
                  return (
                    <button
                      key={tab.key}
                      onClick={() => {
                        setActiveTab(tab.key);
                        setPage(0);
                      }}
                      className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all flex items-center gap-2 cursor-pointer border ${
                        isActive
                          ? isTodayPrinted
                            ? 'bg-emerald-500 text-slate-950 border-emerald-400 shadow-md shadow-emerald-500/25 ring-1 ring-emerald-400'
                            : 'bg-amber-500 text-slate-950 border-amber-400 shadow-md shadow-amber-500/25 ring-1 ring-amber-400'
                          : isTodayPrinted
                            ? 'bg-slate-900 hover:bg-slate-800 text-emerald-400 hover:text-emerald-300 border-emerald-500/30 hover:border-emerald-500/50'
                            : 'bg-slate-900/90 hover:bg-slate-800 text-slate-300 hover:text-white border-slate-800 hover:border-slate-700 shadow-sm'
                      }`}
                    >
                      <span>{tab.label}</span>
                      <span
                        className={`text-[10px] font-mono font-bold px-1.5 py-0.5 rounded-md tabular-nums ${
                          isActive
                            ? 'bg-slate-950/80 text-white'
                            : isTodayPrinted
                              ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                              : 'bg-slate-800 text-slate-400 border border-slate-700/60'
                        }`}
                      >
                        {tab.count}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="hidden sm:flex items-center gap-2 flex-shrink-0">
              <div className="flex items-center gap-1.5 text-[11px] text-emerald-400 font-mono bg-emerald-500/10 px-2.5 py-1 rounded-lg border border-emerald-500/20">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
                <span className="font-semibold">تحديث لحظي Live</span>
              </div>
            </div>
          </div>

          {/* Search Bar & Action Controls */}
          <div className="p-4 border-b border-slate-800 bg-slate-950/40 flex flex-col sm:flex-row items-center justify-between gap-3">
            <div className="relative w-full sm:w-96">
              <Search className="w-4 h-4 absolute right-3 top-2.5 text-slate-500" />
              <input
                type="text"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder="بحث بكود الطلب (tc...)، الهاتف، اسم العميل، كود المخزن..."
                className="w-full bg-slate-900 border border-slate-800 rounded-lg pr-9 pl-3 py-1.5 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-amber-500/50"
              />
              {searchInput && (
                <button
                  onClick={() => setSearchInput('')}
                  className="absolute left-2.5 top-2 text-slate-500 hover:text-slate-300 text-xs"
                >
                  ✕
                </button>
              )}
            </div>

            <div className="flex items-center gap-2 w-full sm:w-auto justify-end">
              {copyFeedback && (
                <span className="text-xs text-emerald-400 flex items-center gap-1 font-medium bg-emerald-500/10 px-2.5 py-1 rounded-lg border border-emerald-500/20">
                  <Check className="w-3.5 h-3.5" />
                  <span>{copyFeedback}</span>
                </span>
              )}

              <button
                onClick={handleCopyCodes}
                disabled={!data || data.orders.length === 0}
                className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-750 border border-slate-700 text-xs font-medium text-slate-200 hover:text-white transition-colors flex items-center gap-1.5 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                title="نسخ أكواد الطلبات المعروضة دفعة واحدة"
              >
                <Copy className="w-3.5 h-3.5 text-slate-400" />
                <span>نسخ الأكواد</span>
              </button>

              <button
                onClick={handleExportCSV}
                disabled={!data || data.orders.length === 0}
                className="px-3 py-1.5 rounded-lg bg-emerald-950/40 hover:bg-emerald-900/50 border border-emerald-500/30 text-xs font-medium text-emerald-300 hover:text-emerald-200 transition-colors flex items-center gap-1.5 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                title="تصدير النتائج إلى ملف Excel / CSV"
              >
                <Download className="w-3.5 h-3.5 text-emerald-400" />
                <span>تصدير CSV</span>
              </button>

              <button
                onClick={fetchData}
                disabled={loading}
                className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-750 border border-slate-700 text-slate-300 hover:text-white transition-colors cursor-pointer"
                title="تحديث البيانات"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
              </button>
            </div>
          </div>

          {/* Table Container */}
          <div className="flex-1 overflow-auto bg-slate-950/20">
            {loading && !data ? (
              <div className="p-16 flex flex-col items-center justify-center gap-3 text-slate-400">
                <RefreshCw className="w-6 h-6 animate-spin text-amber-500" />
                <span className="text-xs">جاري تحميل بيانات الطلبات والتحقق من الحركات...</span>
              </div>
            ) : !data || data.orders.length === 0 ? (
              <div className="p-16 flex flex-col items-center justify-center gap-2 text-slate-500">
                <AlertTriangle className="w-8 h-8 text-slate-600 mb-1" />
                <span className="text-sm font-semibold text-slate-400">لا توجد طلبات مطابقة لهذا الفلتر</span>
                <span className="text-xs text-slate-500 text-center max-w-md">
                  {activeTab === 'today_printed' && (data?.tabCounts?.all || 0) > 0 ? (
                    <span>
                      لا توجد طلبات مؤكدة لهذا اليوم في هذا الفلتر، ولكن يوجد{' '}
                      <button
                        onClick={() => { setActiveTab('all'); setPage(0); }}
                        className="text-amber-400 font-bold underline hover:text-amber-300 cursor-pointer"
                      >
                        {data?.tabCounts?.all} طلب في إجمالي النظام (اضغط هنا للعرض)
                      </button>
                    </span>
                  ) : searchInput ? (
                    'جرّب البحث بمعيار مختلف أو مسح حقل البحث'
                  ) : (
                    'كل الطلبات تفي بالمعايير التشغيلية المحددة'
                  )}
                </span>
              </div>
            ) : (
              <table className="w-full text-right text-xs">
                <thead className="bg-slate-900/90 text-slate-400 border-b border-slate-800 sticky top-0 z-10 backdrop-blur-sm">
                  <tr>
                    <th className="p-3 font-semibold">كود الطلب</th>
                    <th className="p-3 font-semibold">الحالة الحالية</th>
                    <th className="p-3 font-semibold">العميل والمحافظة</th>
                    <th className="p-3 font-semibold">الهاتف الأساسي</th>

                    {/* Specialized Columns per Risk Type */}
                    {riskType === 'multi_merchant' && (
                      <>
                        <th className="p-3 font-semibold">المخازن المعنية</th>
                        <th className="p-3 font-semibold">أكواد التجار</th>
                        <th className="p-3 font-semibold">تفاصيل المنتجات</th>
                      </>
                    )}

                    {riskType === 'no_extra_phone' && (
                      <>
                        <th className="p-3 font-semibold">الهاتف الإضافي المسجل</th>
                        <th className="p-3 font-semibold">حالة التحقق</th>
                        <th className="p-3 font-semibold">العنوان المسجل</th>
                      </>
                    )}

                    {riskType === 'low_delivery' && (
                      <>
                        <th className="p-3 font-semibold">نسبة التسليم (مستلم/إجمالي)</th>
                        <th className="p-3 font-semibold">نسبة الإلغاء</th>
                        <th className="p-3 font-semibold">سجل العميل</th>
                      </>
                    )}

                    <th className="p-3 font-semibold">الإجمالي</th>
                    <th className="p-3 font-semibold text-center">إجراءات</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60 font-sans">
                  {data.orders.map((o) => {
                    const statusInfo = STATUS_ARABIC[o.current_status] || {
                      label: o.current_status,
                      color: 'text-slate-300',
                      bg: 'bg-slate-800 border-slate-700',
                    };

                    return (
                      <tr
                        key={o.id}
                        className="hover:bg-slate-800/40 transition-colors group cursor-pointer"
                        onClick={() => setViewingOrderCode(o.random_number || o.order_no)}
                      >
                        {/* Order Code */}
                        <td className="p-3">
                          <div className="flex items-center gap-1.5">
                            <span className="font-mono font-bold text-amber-400 group-hover:text-amber-300 transition-colors">
                              {o.random_number}
                            </span>
                            {o.is_printed_today && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 font-medium">
                                مؤكد اليوم
                              </span>
                            )}
                          </div>
                          {o.order_no && o.order_no !== o.random_number && (
                            <span className="text-[10px] font-mono text-slate-500 block">
                              #{o.order_no}
                            </span>
                          )}
                        </td>

                        {/* Status */}
                        <td className="p-3">
                          <span className={`inline-block px-2 py-0.5 rounded text-[11px] font-medium border ${statusInfo.bg} ${statusInfo.color}`}>
                            {statusInfo.label}
                          </span>
                        </td>

                        {/* Customer & Governorate */}
                        <td className="p-3">
                          <div className="font-medium text-slate-200">
                            {o.customer_name || 'عميل غير مسجل'}
                          </div>
                          <div className="text-[11px] text-slate-400 flex items-center gap-1 mt-0.5">
                            <MapPin className="w-3 h-3 text-slate-500" />
                            <span>{o.governorate || 'المحافظة غير محددة'}</span>
                          </div>
                        </td>

                        {/* Phone */}
                        <td className="p-3 font-mono text-slate-300 tabular-nums" dir="ltr">
                          {o.customer_phone || '—'}
                        </td>

                        {/* --- Specialized Cells: Multi-Merchant --- */}
                        {riskType === 'multi_merchant' && (
                          <>
                            <td className="p-3">
                              <div className="flex flex-wrap gap-1 max-w-xs">
                                {o.warehouses && o.warehouses.length > 0 ? (
                                  o.warehouses.map((w, idx) => (
                                    <span
                                      key={idx}
                                      className="px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 border border-slate-700 text-[11px] font-mono"
                                      title={w.name}
                                    >
                                      {w.code || w.name}
                                    </span>
                                  ))
                                ) : (
                                  <span className="text-slate-500 text-[11px]">غير محدد</span>
                                )}
                              </div>
                            </td>

                            <td className="p-3">
                              <div className="flex flex-wrap gap-1 max-w-xs">
                                {o.merchantCodes && o.merchantCodes.length > 0 ? (
                                  o.merchantCodes.map((m, idx) => (
                                    <span
                                      key={idx}
                                      className="px-1.5 py-0.5 rounded bg-rose-500/15 text-rose-300 border border-rose-500/30 text-[11px] font-mono font-bold"
                                    >
                                      {m}
                                    </span>
                                  ))
                                ) : (
                                  <span className="text-slate-500 text-[11px]">تعدد غير مدون</span>
                                )}
                              </div>
                            </td>

                            <td className="p-3">
                              <div className="space-y-0.5 max-w-sm">
                                {o.items && o.items.length > 0 ? (
                                  o.items.slice(0, 3).map((item, idx) => (
                                    <div key={idx} className="text-[11px] text-slate-300 truncate flex items-center gap-1.5">
                                      <span className="font-mono text-slate-500">x{item.quantity}</span>
                                      <span className="truncate">{item.product_name}</span>
                                      {item.warehouse_code && (
                                        <span className="font-mono text-[10px] text-amber-400/80 bg-amber-500/10 px-1 rounded">
                                          {item.warehouse_code}
                                        </span>
                                      )}
                                    </div>
                                  ))
                                ) : (
                                  <span className="text-slate-500 text-[11px]">بدون بنود مسجلة</span>
                                )}
                                {o.items && o.items.length > 3 && (
                                  <span className="text-[10px] text-slate-500 font-mono">
                                    + {o.items.length - 3} منتجات أخرى...
                                  </span>
                                )}
                              </div>
                            </td>
                          </>
                        )}

                        {/* --- Specialized Cells: No Extra Phone --- */}
                        {riskType === 'no_extra_phone' && (
                          <>
                            <td className="p-3 font-mono tabular-nums" dir="ltr">
                              {o.customer_phone_extra ? (
                                <span className={o.customer_phone_extra === o.customer_phone ? 'text-amber-400' : 'text-slate-300'}>
                                  {o.customer_phone_extra}
                                </span>
                              ) : (
                                <span className="text-rose-400 font-sans text-[11px] font-medium">غير مدخل</span>
                              )}
                            </td>

                            <td className="p-3">
                              {o.customer_phone_extra === o.customer_phone ? (
                                <span className="text-amber-400 bg-amber-500/10 px-1.5 py-0.5 rounded border border-amber-500/30 text-[11px]">
                                  مطابق للهاتف الأساسي
                                </span>
                              ) : o.extra_phone_status === 'CONFIRMED_ABSENT' ? (
                                <span className="text-rose-400 bg-rose-500/10 px-1.5 py-0.5 rounded border border-rose-500/30 text-[11px]">
                                  مؤكد غيابه
                                </span>
                              ) : !o.customer_phone_extra ? (
                                <span className="text-rose-400 bg-rose-500/10 px-1.5 py-0.5 rounded border border-rose-500/30 text-[11px]">
                                  فارغ
                                </span>
                              ) : o.extra_phone_valid === 0 ? (
                                <span className="text-orange-400 bg-orange-500/10 px-1.5 py-0.5 rounded border border-orange-500/30 text-[11px]">
                                  صيغة هاتف غير صالحة
                                </span>
                              ) : (
                                <span className="text-slate-400 text-[11px]">بحاجة لمراجعة</span>
                              )}
                            </td>

                            <td className="p-3 max-w-xs truncate text-[11px] text-slate-400" title={o.address || ''}>
                              {o.address || '—'}
                            </td>
                          </>
                        )}

                        {/* --- Specialized Cells: Low Delivery Rate --- */}
                        {riskType === 'low_delivery' && (
                          <>
                            <td className="p-3">
                              <div className="flex items-center gap-1.5">
                                <span className="font-mono font-bold text-rose-400 tabular-nums text-sm">
                                  {o.delivery_rate !== null ? `${Math.round(o.delivery_rate)}%` : '0%'}
                                </span>
                                {(o.delivery_rate_num !== null && o.delivery_rate_denom !== null) && (
                                  <span className="font-mono text-[11px] text-slate-400 tabular-nums">
                                    ({o.delivery_rate_num}/{o.delivery_rate_denom})
                                  </span>
                                )}
                              </div>
                            </td>

                            <td className="p-3">
                              <div className="flex items-center gap-1.5 font-mono tabular-nums">
                                <span className="text-orange-400 font-semibold">
                                  {o.cancel_rate !== null ? `${Math.round(o.cancel_rate)}%` : '0%'}
                                </span>
                                {(o.cancel_rate_num !== null && o.cancel_rate_denom !== null) && (
                                  <span className="text-[11px] text-slate-500">
                                    ({o.cancel_rate_num}/{o.cancel_rate_denom})
                                  </span>
                                )}
                              </div>
                            </td>

                            <td className="p-3">
                              <div className="text-[11px] text-slate-300">
                                <span className="font-mono tabular-nums font-bold text-slate-200">
                                  {o.total_customer_orders ?? (o.delivery_rate_denom || 0)}
                                </span>{' '}
                                طلبات سابقة
                              </div>
                              <div className="text-[10px] text-slate-500">
                                آخر حالة:{' '}
                                <span className="font-medium text-slate-400">
                                  {STATUS_ARABIC[o.customer_last_order_status || '']?.label || o.customer_last_order_status || 'غير محدد'}
                                </span>
                              </div>
                            </td>
                          </>
                        )}

                        {/* Order Total Price */}
                        <td className="p-3 font-mono font-semibold text-slate-200 tabular-nums">
                          {(o.total_order || o.total_price || 0).toLocaleString('en-US')} ج.م
                        </td>

                        {/* Row Actions */}
                        <td className="p-3 text-center" onClick={(e) => e.stopPropagation()}>
                          <button
                            onClick={() => setViewingOrderCode(o.random_number || o.order_no)}
                            className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition-colors cursor-pointer"
                            title="عرض تفاصيل الطلب الكاملة"
                          >
                            <ExternalLink className="w-3.5 h-3.5" />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          {/* Footer with Pagination */}
          <div className="p-3 border-t border-slate-800 bg-slate-900/90 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-slate-400">
            <div className="flex items-center gap-2">
              <span>عرض النتائج:</span>
              <span className="font-mono font-semibold text-slate-200 tabular-nums">
                {data ? `${page * limit + 1} - ${Math.min((page + 1) * limit, data.filteredCount)}` : '0'}
              </span>
              <span>من أصل</span>
              <span className="font-mono font-semibold text-slate-200 tabular-nums">
                {data?.filteredCount ?? 0}
              </span>
              <span>طلب مطابق للفلتر</span>
            </div>

            {/* Pagination Controls */}
            {data && data.totalPages > 1 && (
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => setPage(p => Math.max(0, p - 1))}
                  disabled={page === 0 || loading}
                  className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1 cursor-pointer"
                >
                  <ChevronRight className="w-3.5 h-3.5" />
                  <span>السابق</span>
                </button>

                <div className="px-3 py-1 rounded-lg bg-slate-950 font-mono font-bold text-slate-200 tabular-nums border border-slate-800">
                  {page + 1} / {data.totalPages}
                </div>

                <button
                  onClick={() => setPage(p => Math.min(data.totalPages - 1, p + 1))}
                  disabled={page >= data.totalPages - 1 || loading}
                  className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1 cursor-pointer"
                >
                  <span>التالي</span>
                  <ChevronLeft className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Layered Order Details Modal */}
      {viewingOrderCode && (
        <OrderDetailsModal
          orderCode={viewingOrderCode}
          onClose={() => setViewingOrderCode(null)}
        />
      )}
    </>
  );
};
