import React, { useState, useEffect, useMemo } from 'react';
import {
  X,
  Search,
  Download,
  PackageCheck,
  TrendingUp,
  Clock,
  ShieldAlert,
  MapPin,
  Phone,
  User,
  RotateCw,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Copy,
  Check,
  Layers,
  Building2,
  DollarSign,
} from 'lucide-react';

export type DrilldownPillar = 'created' | 'printed' | 'pipeline' | 'multi_warehouse';

interface ReportKpiDrilldownModalProps {
  isOpen: boolean;
  onClose: () => void;
  pillar: DrilldownPillar | null;
  startDate: string;
  endDate: string;
  periodLabel: string;
  reportData: any;
  onSelectOrder?: (orderCode: string) => void;
}

export const ReportKpiDrilldownModal: React.FC<ReportKpiDrilldownModalProps> = ({
  isOpen,
  onClose,
  pillar,
  startDate,
  endDate,
  periodLabel,
  reportData,
  onSelectOrder,
}) => {
  const [orders, setOrders] = useState<any[]>([]);
  const [total, setTotal] = useState<number>(0);
  const [page, setPage] = useState<number>(1);
  const [totalPages, setTotalPages] = useState<number>(1);
  const [loading, setLoading] = useState<boolean>(false);
  const [searchTerm, setSearchTerm] = useState<string>('');
  const [activeSearch, setActiveSearch] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [copiedCode, setCopiedCode] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen && pillar) {
      setPage(1);
      setSearchTerm('');
      setActiveSearch('');
      setStatusFilter('all');
    }
  }, [isOpen, pillar]);

  useEffect(() => {
    if (isOpen && pillar) {
      fetchOrders();
    }
  }, [isOpen, pillar, page, activeSearch, statusFilter, startDate, endDate]);

  async function fetchOrders() {
    if (!pillar) return;
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (startDate) params.set('startDate', startDate);
      if (endDate) params.set('endDate', endDate);
      params.set('page', String(page));
      params.set('limit', '25');

      if (pillar === 'printed') {
        params.set('status', 'Printed');
      } else if (pillar === 'pipeline') {
        if (statusFilter === 'all') {
          params.set('status', 'Pending,Processing');
        } else {
          params.set('status', statusFilter);
        }
      } else if (pillar === 'multi_warehouse') {
        params.set('multiMerchant', '1');
        if (statusFilter !== 'all') {
          params.set('status', statusFilter);
        }
      } else if (pillar === 'created') {
        if (statusFilter !== 'all') {
          params.set('status', statusFilter);
        }
      }

      if (activeSearch.trim()) {
        params.set('search', activeSearch.trim());
      }

      const res = await fetch(`/api/orders?${params.toString()}`);
      if (res.ok) {
        const data = await res.json();
        setOrders(data.orders || []);
        setTotal(data.total || 0);
        setTotalPages(data.totalPages || 1);
      }
    } catch (err) {
      console.error('Error fetching drilldown orders:', err);
    } finally {
      setLoading(false);
    }
  }

  function handleSearchSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPage(1);
    setActiveSearch(searchTerm);
  }

  function handleCopy(code: string) {
    navigator.clipboard.writeText(code);
    setCopiedCode(code);
    setTimeout(() => setCopiedCode(null), 2000);
  }

  // Export the current filtered list
  function handleExportModalCSV() {
    if (!orders || orders.length === 0) return;
    let csv = '\uFEFF';
    csv += `كود الطلب,حالة الطلب,اسم العميل,رقم الهاتف,الهاتف الإضافي,المحافظة,العنوان,قيمة الطلب,أكواد المخازن,تاريخ الإنشاء\n`;
    for (const o of orders) {
      const wh = (o.warehouseCodes || []).join(' - ');
      csv += `"${o.random_number || o.vendoor_id}","${o.current_status || ''}","${o.customer_name || ''}","${o.customer_phone || ''}","${o.customer_phone_extra || ''}","${o.governorate || ''}","${(o.address || '').replace(/"/g, '""')}","${o.total_order || 0}","${wh}","${o.created_at_source || ''}"\n`;
    }
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.setAttribute('download', `kpi_orders_${pillar}_${startDate}_to_${endDate}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  if (!isOpen || !pillar) return null;

  // Metadata per pillar
  const pillarMeta = {
    created: {
      title: 'تفاصيل الطلبات المنشأة (Created Orders)',
      badge: 'إجمالي الإنشاء',
      icon: PackageCheck,
      color: 'blue',
      description: 'جميع الطلبات المسجلة في النظام التي تم إنشاؤها خلال هذه الفترة مع إجمالي قيمتها وحالاتها الحالية.',
      totalCount: reportData?.createdCount || 0,
      totalValue: reportData?.totalOrderValue || 0,
    },
    printed: {
      title: 'تفاصيل الطلبات المؤكدة والمطبوعة (Printed Orders)',
      badge: 'جاهزة للشحن',
      icon: TrendingUp,
      color: 'emerald',
      description: 'الطلبات المنشأة في الفترة وتم تأكيدها وطباعة بوليصتها لتسليمها لشركة الشحن.',
      totalCount: reportData?.ordersByStatus?.find((s: any) => s.status === 'Printed')?.count || reportData?.statusCounts?.printed || 0,
      totalValue: reportData?.ordersByStatus?.find((s: any) => s.status === 'Printed')?.total_value || 0,
    },
    pipeline: {
      title: 'تفاصيل الطلبات قيد التجهيز والمعالجة (Pending & Processing)',
      badge: 'طابور العمل النشط',
      icon: Clock,
      color: 'sky',
      description: 'الطلبات المعلقة التي تتطلب متابعة، والطلبات قيد تجهيز الأصناف في المستودعات.',
      totalCount: (reportData?.statusCounts?.pending || 0) + (reportData?.statusCounts?.processing || 0),
      totalValue: orders.reduce((sum, o) => sum + (o.total_order || 0), 0),
    },
    multi_warehouse: {
      title: 'تفاصيل طلبات تعدد المخازن (Multi-Warehouse)',
      badge: 'تنبيه تشغيلي حرج',
      icon: ShieldAlert,
      color: 'rose',
      description: 'طلبات تحتوي أصنافاً من أكثر من مخزن مستقل تتطلب تجزئة البوالص أو التنسيق بين المستودعات.',
      totalCount: reportData?.multiWarehouseCount || 0,
      totalValue: reportData?.multiWarehouseStats?.multiValue || 0,
    },
  }[pillar];

  const IconComponent = pillarMeta.icon;

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'Printed':
        return <span className="px-2 py-0.5 rounded text-[11px] font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">مطبوع / مؤكد</span>;
      case 'Pending':
        return <span className="px-2 py-0.5 rounded text-[11px] font-bold bg-amber-500/10 text-amber-400 border border-amber-500/20">معلق (Pending)</span>;
      case 'Processing':
        return <span className="px-2 py-0.5 rounded text-[11px] font-bold bg-sky-500/10 text-sky-400 border border-sky-500/20">قيد التنفيذ (Processing)</span>;
      case 'New':
        return <span className="px-2 py-0.5 rounded text-[11px] font-bold bg-blue-500/10 text-blue-400 border border-blue-500/20">أوردر جديد</span>;
      case 'Canceling':
        return <span className="px-2 py-0.5 rounded text-[11px] font-bold bg-orange-500/10 text-orange-400 border border-orange-500/20">قيد الإلغاء</span>;
      case 'Canceled':
        return <span className="px-2 py-0.5 rounded text-[11px] font-bold bg-rose-500/10 text-rose-400 border border-rose-500/20">ملغي</span>;
      default:
        return <span className="px-2 py-0.5 rounded text-[11px] font-bold bg-slate-800 text-slate-300">{status}</span>;
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6 bg-slate-950/80 backdrop-blur-md animate-fade-in" dir="rtl">
      <div className="relative w-full max-w-6xl max-h-[92vh] flex flex-col rounded-2xl bg-slate-900 border border-slate-800 shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="p-5 border-b border-slate-800 flex items-start justify-between gap-4 bg-slate-950/40">
          <div className="flex items-start gap-3.5">
            <div className={`p-3 rounded-xl bg-${pillarMeta.color}-500/10 border border-${pillarMeta.color}-500/30 text-${pillarMeta.color}-400 shrink-0`}>
              <IconComponent className="w-6 h-6" />
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-lg font-bold text-slate-100">{pillarMeta.title}</h3>
                <span className={`text-[11px] font-mono font-bold px-2 py-0.5 rounded bg-${pillarMeta.color}-500/15 text-${pillarMeta.color}-300 border border-${pillarMeta.color}-500/30`}>
                  {pillarMeta.badge}
                </span>
                <span className="text-xs font-mono text-slate-400 bg-slate-800/80 px-2.5 py-0.5 rounded-lg border border-slate-700">
                  الفترة: {startDate} إلى {endDate} ({periodLabel})
                </span>
              </div>
              <p className="mt-1 text-xs text-slate-400 leading-relaxed max-w-3xl">
                {pillarMeta.description}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-xl text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors cursor-pointer shrink-0"
            title="إغلاق النافذة"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Stats Strip */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 p-4 bg-slate-950/60 border-b border-slate-800 text-xs">
          <div className="p-3 rounded-xl bg-slate-900/80 border border-slate-800/80">
            <span className="text-slate-400 block mb-1">العدد المطابق في النطاق</span>
            <div className="text-xl font-bold font-mono text-slate-100">
              {total.toLocaleString()} <span className="text-xs text-slate-500 font-normal">طلب</span>
            </div>
          </div>

          <div className="p-3 rounded-xl bg-slate-900/80 border border-slate-800/80">
            <span className="text-slate-400 block mb-1">إجمالي القيمة المالية</span>
            <div className="text-xl font-bold font-mono text-amber-400">
              {(pillarMeta.totalValue || 0).toLocaleString()} <span className="text-xs text-slate-400 font-normal">ج.م</span>
            </div>
          </div>

          {pillar === 'pipeline' && (
            <>
              <div className="p-3 rounded-xl bg-slate-900/80 border border-slate-800/80">
                <span className="text-slate-400 block mb-1">معلق (Pending)</span>
                <div className="text-xl font-bold font-mono text-amber-300">
                  {(reportData?.statusCounts?.pending || 0).toLocaleString()} طلب
                </div>
              </div>
              <div className="p-3 rounded-xl bg-slate-900/80 border border-slate-800/80">
                <span className="text-slate-400 block mb-1">قيد التجهيز (Processing)</span>
                <div className="text-xl font-bold font-mono text-sky-300">
                  {(reportData?.statusCounts?.processing || 0).toLocaleString()} طلب
                </div>
              </div>
            </>
          )}

          {pillar === 'multi_warehouse' && (
            <>
              <div className="p-3 rounded-xl bg-slate-900/80 border border-slate-800/80">
                <span className="text-slate-400 block mb-1">نسبة التعدد من إجمالي المنشأ</span>
                <div className="text-xl font-bold font-mono text-rose-400">
                  {reportData?.createdCount > 0 ? (((reportData?.multiWarehouseCount || 0) / reportData.createdCount) * 100).toFixed(1) : 0}%
                </div>
              </div>
              <div className="p-3 rounded-xl bg-slate-900/80 border border-slate-800/80">
                <span className="text-slate-400 block mb-1">طلبات المخزن الواحد</span>
                <div className="text-xl font-bold font-mono text-emerald-400">
                  {((reportData?.createdCount || 0) - (reportData?.multiWarehouseCount || 0)).toLocaleString()} طلب
                </div>
              </div>
            </>
          )}

          {pillar === 'printed' && (
            <>
              <div className="p-3 rounded-xl bg-slate-900/80 border border-slate-800/80">
                <span className="text-slate-400 block mb-1">نسبة التأكيد العامة</span>
                <div className="text-xl font-bold font-mono text-emerald-400">
                  {reportData?.createdCount > 0 ? Math.round(((reportData?.ordersByStatus?.find((s: any) => s.status === 'Printed')?.count || 0) / reportData.createdCount) * 100) : 0}%
                </div>
              </div>
              <div className="p-3 rounded-xl bg-slate-900/80 border border-slate-800/80">
                <span className="text-slate-400 block mb-1">متوسط قيمة البوليصة</span>
                <div className="text-xl font-bold font-mono text-slate-200">
                  {pillarMeta.totalCount > 0 ? Math.round(pillarMeta.totalValue / pillarMeta.totalCount).toLocaleString() : 0} ج.م
                </div>
              </div>
            </>
          )}

          {pillar === 'created' && (
            <>
              <div className="p-3 rounded-xl bg-slate-900/80 border border-slate-800/80">
                <span className="text-slate-400 block mb-1">متوسط قيمة الطلب (AOV)</span>
                <div className="text-xl font-bold font-mono text-blue-300">
                  {(reportData?.averageOrderValue || 0).toLocaleString()} ج.م
                </div>
              </div>
              <div className="p-3 rounded-xl bg-slate-900/80 border border-slate-800/80">
                <span className="text-slate-400 block mb-1">المؤكد منها حتى الآن</span>
                <div className="text-xl font-bold font-mono text-emerald-400">
                  {(reportData?.ordersByStatus?.find((s: any) => s.status === 'Printed')?.count || 0).toLocaleString()} طلب
                </div>
              </div>
            </>
          )}
        </div>

        {/* Search, Status Sub-filters & Actions */}
        <div className="p-4 border-b border-slate-800 flex flex-wrap items-center justify-between gap-3 bg-slate-900">
          <form onSubmit={handleSearchSubmit} className="flex items-center gap-2 flex-1 max-w-md">
            <div className="relative flex-1">
              <Search className="w-4 h-4 text-slate-500 absolute right-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="ابحث برقم الطلب، اسم العميل، الهاتف، أو المحافظة..."
                className="w-full pl-3 pr-9 py-1.5 bg-slate-950 border border-slate-800 rounded-xl text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-amber-500 transition-colors"
              />
            </div>
            <button
              type="submit"
              className="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-200 transition-colors cursor-pointer"
            >
              بحث
            </button>
            {activeSearch && (
              <button
                type="button"
                onClick={() => {
                  setSearchTerm('');
                  setActiveSearch('');
                  setPage(1);
                }}
                className="text-xs text-slate-400 hover:text-rose-400"
              >
                إلغاء
              </button>
            )}
          </form>

          {/* Sub-status filter pills */}
          <div className="flex items-center gap-1.5 text-xs">
            {pillar === 'pipeline' && (
              <div className="flex items-center gap-1 p-0.5 rounded-lg bg-slate-950 border border-slate-800">
                <button
                  onClick={() => { setStatusFilter('all'); setPage(1); }}
                  className={`px-2.5 py-1 rounded-md transition-colors cursor-pointer ${statusFilter === 'all' ? 'bg-sky-500/20 text-sky-300 font-bold' : 'text-slate-400 hover:text-slate-200'}`}
                >
                  الكل
                </button>
                <button
                  onClick={() => { setStatusFilter('Pending'); setPage(1); }}
                  className={`px-2.5 py-1 rounded-md transition-colors cursor-pointer ${statusFilter === 'Pending' ? 'bg-amber-500/20 text-amber-300 font-bold' : 'text-slate-400 hover:text-slate-200'}`}
                >
                  Pending فقط
                </button>
                <button
                  onClick={() => { setStatusFilter('Processing'); setPage(1); }}
                  className={`px-2.5 py-1 rounded-md transition-colors cursor-pointer ${statusFilter === 'Processing' ? 'bg-sky-500/20 text-sky-300 font-bold' : 'text-slate-400 hover:text-slate-200'}`}
                >
                  Processing فقط
                </button>
              </div>
            )}

            <button
              onClick={handleExportModalCSV}
              disabled={orders.length === 0}
              className="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs text-slate-200 flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-50"
              title="تصدير قائمة هذه الطلبات بصيغة CSV"
            >
              <Download className="w-3.5 h-3.5 text-amber-400" />
              <span>تصدير CSV</span>
            </button>
          </div>
        </div>

        {/* Orders Table Container */}
        <div className="flex-1 overflow-y-auto min-h-[350px]">
          {loading ? (
            <div className="py-24 flex flex-col items-center justify-center text-slate-500 gap-3">
              <RotateCw className="w-6 h-6 animate-spin text-amber-500" />
              <span className="text-xs">جاري تحميل قائمة الطلبات وتفاصيلها...</span>
            </div>
          ) : orders.length === 0 ? (
            <div className="py-24 text-center text-slate-500 space-y-2">
              <PackageCheck className="w-10 h-10 mx-auto text-slate-600" />
              <p className="text-sm font-medium text-slate-400">لا توجد طلبات مطابقة لهذا المؤشر في هذه الفترة</p>
              <p className="text-xs text-slate-600">جرّب تغيير الفترة الزمنية أو مراجعة معايير البحث</p>
            </div>
          ) : (
            <table className="w-full text-right text-xs">
              <thead className="bg-slate-950/80 text-slate-400 border-b border-slate-800 sticky top-0 z-10 font-medium">
                <tr>
                  <th className="p-3">كود الطلب</th>
                  <th className="p-3">الحالة الحالية</th>
                  <th className="p-3">العميل والمحافظة</th>
                  <th className="p-3">أكواد المخازن (Warehouses)</th>
                  <th className="p-3">قيمة الطلب</th>
                  <th className="p-3">تاريخ الإنشاء</th>
                  <th className="p-3 text-center">الإجراء</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 font-normal">
                {orders.map((ord) => (
                  <tr
                    key={ord.id}
                    onClick={() => onSelectOrder?.(ord.random_number || String(ord.vendoor_id))}
                    className="hover:bg-slate-800/40 transition-colors cursor-pointer group"
                  >
                    {/* Order Code */}
                    <td className="p-3">
                      <div className="flex items-center gap-1.5 font-mono">
                        <span className="font-bold text-slate-100 group-hover:text-amber-400 transition-colors">
                          {ord.random_number || ord.vendoor_id}
                        </span>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleCopy(ord.random_number || String(ord.vendoor_id));
                          }}
                          className="p-1 rounded text-slate-500 hover:text-slate-300 hover:bg-slate-800 transition-colors"
                          title="نسخ كود الطلب"
                        >
                          {copiedCode === (ord.random_number || String(ord.vendoor_id)) ? (
                            <Check className="w-3 h-3 text-emerald-400" />
                          ) : (
                            <Copy className="w-3 h-3" />
                          )}
                        </button>
                      </div>
                      {ord.order_no && (
                        <div className="text-[10px] text-slate-500 font-mono mt-0.5">
                          #{ord.order_no}
                        </div>
                      )}
                    </td>

                    {/* Status */}
                    <td className="p-3">
                      {getStatusBadge(ord.current_status)}
                    </td>

                    {/* Customer */}
                    <td className="p-3">
                      <div className="font-medium text-slate-200">{ord.customer_name || 'عميل فيندور'}</div>
                      <div className="text-[11px] text-slate-400 font-mono flex items-center gap-1 mt-0.5" dir="ltr">
                        <span>{ord.customer_phone}</span>
                        {ord.customer_phone_extra && (
                          <span className="text-slate-500"> / {ord.customer_phone_extra}</span>
                        )}
                      </div>
                      <div className="text-[10px] text-slate-500 mt-0.5 flex items-center gap-1">
                        <MapPin className="w-3 h-3 text-slate-500" />
                        <span>{ord.governorate || 'غير محدد'}</span>
                      </div>
                    </td>

                    {/* Warehouses */}
                    <td className="p-3">
                      <div className="flex flex-wrap items-center gap-1">
                        {ord.warehouseCodes && ord.warehouseCodes.length > 0 ? (
                          ord.warehouseCodes.map((code: string, idx: number) => (
                            <span
                              key={idx}
                              className={`px-1.5 py-0.5 rounded text-[10px] font-mono font-medium ${
                                ord.multi_merchant_flag === 1
                                  ? 'bg-rose-500/10 text-rose-300 border border-rose-500/30'
                                  : 'bg-slate-800 text-slate-300 border border-slate-700'
                              }`}
                            >
                              {code}
                            </span>
                          ))
                        ) : (
                          <span className="text-[11px] text-slate-500">كود واحد</span>
                        )}
                        {ord.multi_merchant_flag === 1 && (
                          <span className="px-1.5 py-0.5 rounded text-[10px] bg-rose-500/20 text-rose-400 font-bold border border-rose-500/30">
                            متعدد ({ord.distinct_merchant_count || 2})
                          </span>
                        )}
                      </div>
                    </td>

                    {/* Price */}
                    <td className="p-3 font-mono font-bold text-slate-100">
                      {(ord.total_order || 0).toLocaleString()} <span className="text-[10px] text-slate-500 font-normal">ج.م</span>
                    </td>

                    {/* Date */}
                    <td className="p-3 text-[11px] font-mono text-slate-400">
                      <div>{(ord.created_at_source || '').slice(0, 10)}</div>
                      <div className="text-[10px] text-slate-500">{(ord.created_at_source || '').slice(11, 16)}</div>
                    </td>

                    {/* Actions */}
                    <td className="p-3 text-center">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelectOrder?.(ord.random_number || String(ord.vendoor_id));
                        }}
                        className="px-2.5 py-1 rounded-lg bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 text-amber-300 hover:text-amber-200 transition-colors cursor-pointer inline-flex items-center gap-1 font-medium text-[11px]"
                      >
                        <span>التفاصيل</span>
                        <ExternalLink className="w-3 h-3" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Footer with Pagination */}
        <div className="p-3.5 border-t border-slate-800 flex items-center justify-between text-xs bg-slate-950/40">
          <div className="text-slate-400">
            إجمالي المطابق: <span className="font-mono font-bold text-slate-200">{total.toLocaleString()}</span> طلب
            {total > 0 && (
              <span className="text-slate-500 mr-2">
                (صفحة {page} من {totalPages})
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1 || loading}
              className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1 transition-colors cursor-pointer"
            >
              <ChevronRight className="w-4 h-4" />
              <span>السابق</span>
            </button>
            <span className="font-mono text-slate-400 px-2">
              {page} / {totalPages}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages || loading}
              className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1 transition-colors cursor-pointer"
            >
              <span>التالي</span>
              <ChevronLeft className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
