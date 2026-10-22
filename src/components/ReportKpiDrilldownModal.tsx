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
  AlertCircle,
  CheckCircle2,
  XCircle,
  FileText,
} from 'lucide-react';

export type DrilldownPillar =
  | 'confirmed'
  | 'printed'
  | 'canceled'
  | 'canceling'
  | 'created'
  | 'extra_phone'
  | 'transitions'
  | 'admin_edits'
  | 'unresolved'
  | 'employee'
  | 'pipeline'
  | 'multi_warehouse'
  | 'all';

interface ReportKpiDrilldownModalProps {
  isOpen: boolean;
  onClose: () => void;
  pillar: DrilldownPillar | null;
  actorName?: string;
  startDate: string;
  endDate: string;
  periodLabel: string;
  reportData?: any;
  onSelectOrder?: (orderCode: string) => void;
}

export const ReportKpiDrilldownModal: React.FC<ReportKpiDrilldownModalProps> = ({
  isOpen,
  onClose,
  pillar,
  actorName,
  startDate,
  endDate,
  periodLabel,
  reportData,
  onSelectOrder,
}) => {
  const isOrderPillar = ['confirmed', 'printed', 'canceled', 'canceling', 'created'].includes(pillar || '');
  const [viewType, setViewType] = useState<'orders' | 'events'>('orders');
  const [logEvents, setLogEvents] = useState<any[]>([]);
  const [total, setTotal] = useState<number>(0);
  const [page, setPage] = useState<number>(1);
  const [totalPages, setTotalPages] = useState<number>(1);
  const [loading, setLoading] = useState<boolean>(false);
  const [searchTerm, setSearchTerm] = useState<string>('');
  const [activeSearch, setActiveSearch] = useState<string>('');
  const [copiedCode, setCopiedCode] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen && pillar) {
      setPage(1);
      setSearchTerm('');
      setActiveSearch('');
      setViewType(isOrderPillar ? 'orders' : 'events');
    }
  }, [isOpen, pillar, actorName]);

  useEffect(() => {
    if (isOpen && pillar) {
      fetchLogs();
    }
  }, [isOpen, pillar, actorName, page, activeSearch, startDate, endDate, viewType]);

  async function fetchLogs() {
    if (!pillar) return;
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (startDate) params.set('startDate', startDate);
      if (endDate) params.set('endDate', endDate);
      params.set('pillar', pillar);
      params.set('viewType', viewType);
      params.set('page', String(page));
      params.set('limit', '25');

      if (actorName) {
        params.set('actor', actorName);
      }

      if (activeSearch.trim()) {
        params.set('search', activeSearch.trim());
      }

      const res = await fetch(`/api/reports/logs-drilldown?${params.toString()}`);
      if (res.ok) {
        const data = await res.json();
        setLogEvents(data.events || []);
        setTotal(data.total || 0);
        setTotalPages(data.totalPages || 1);
      }
    } catch (err) {
      console.error('Error fetching drilldown logs:', err);
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

  function handleExportModalCSV() {
    const params = new URLSearchParams();
    if (startDate) params.set('startDate', startDate);
    if (endDate) params.set('endDate', endDate);
    if (pillar) params.set('pillar', pillar);
    params.set('viewType', viewType);
    window.location.href = `/api/reports/logs-export?${params.toString()}`;
  }

  if (!isOpen || !pillar) return null;

  const pillarMeta: Record<string, { title: string; subtitle: string; color: string; icon: any }> = {
    confirmed: {
      title: 'الأوردرات المؤكدة (Printed)',
      subtitle: 'جميع حركات الوصول إلى حالة Printed الموثقة باللوجز (Printed = تأكيد الأوردر)',
      color: 'emerald',
      icon: CheckCircle2,
    },
    printed: {
      title: 'الأوردرات المؤكدة (Printed)',
      subtitle: 'جميع حركات الوصول إلى حالة Printed الموثقة باللوجز (Printed = تأكيد الأوردر)',
      color: 'emerald',
      icon: CheckCircle2,
    },
    canceled: {
      title: 'الأوردرات الملغاة (Canceled)',
      subtitle: 'جميع حركات الانتقال إلى حالة Canceled الموثقة باللوجز المصدرية',
      color: 'rose',
      icon: XCircle,
    },
    canceling: {
      title: 'أوردرات قيد الإلغاء (Canceling)',
      subtitle: 'طلبات في مرحلة Canceling (معزولة بدقة عن الملغاة نهائياً)',
      color: 'amber',
      icon: AlertCircle,
    },
    created: {
      title: 'الأوردرات المنشأة (Created)',
      subtitle: 'أحداث إنشاء الأوردرات الجديدة المسجلة في اللوجز',
      color: 'sky',
      icon: TrendingUp,
    },
    extra_phone: {
      title: 'حركات الهاتف الإضافي',
      subtitle: 'سجلات إضافة واستبدال أرقام الهواتف الإضافية الموثقة باللوجز',
      color: 'cyan',
      icon: Phone,
    },
    transitions: {
      title: 'انتقالات الحالات التشغيلية',
      subtitle: 'حركات تغيير حالات الطلبات المسجلة في اللوجز',
      color: 'amber',
      icon: RotateCw,
    },
    admin_edits: {
      title: 'التعديلات الإدارية',
      subtitle: 'تعديلات العناوين وأرقام الهواتف والبيانات الإدارية والملاحظات',
      color: 'indigo',
      icon: FileText,
    },
    unresolved: {
      title: 'حركات غير محسومة / تحتاج إلى مراجعة',
      subtitle: 'سجلات اللوجز التي تحتاج إلى تدقيق أو لم يتم تصنيفها قطعيًا',
      color: 'purple',
      icon: ShieldAlert,
    },
    employee: {
      title: actorName ? `نشاط الموظف: ${actorName}` : 'حركات الموظف',
      subtitle: 'جميع الحركات المنسوبة لهذا المنفذ خلال الفترة المحددة',
      color: 'amber',
      icon: User,
    },
    all: {
      title: 'جميع حركات اللوجز للفترة',
      subtitle: 'السجل الكامل لجميع الأحداث التشغيلية المصدرية',
      color: 'slate',
      icon: Layers,
    },
  };

  const meta = pillarMeta[pillar] || pillarMeta.all;
  const Icon = meta.icon;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-6xl max-h-[92vh] flex flex-col shadow-2xl overflow-hidden text-right">
        {/* Header */}
        <div className="p-5 border-b border-slate-800 flex items-center justify-between bg-slate-900/60">
          <div className="flex items-center gap-3">
            <div className={`p-2.5 rounded-xl bg-${meta.color}-500/10 text-${meta.color}-400 border border-${meta.color}-500/20`}>
              <Icon className="w-6 h-6" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-xl font-bold text-slate-100">{meta.title}</h2>
                <span className="text-xs px-2.5 py-0.5 rounded-full bg-slate-800 text-slate-300 font-mono">
                  {total.toLocaleString()} {viewType === 'orders' ? 'طلب فريد' : 'حركة مسجلة'}
                </span>
              </div>
              <p className="text-xs text-slate-400 mt-0.5 font-sans">
                {meta.subtitle} • الفترة: <span className="text-amber-400 font-mono">{periodLabel}</span>
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handleExportModalCSV}
              disabled={total === 0}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700/60 transition disabled:opacity-50"
              title="تصدير السجلات إلى CSV"
            >
              <Download className="w-3.5 h-3.5 text-amber-400" />
              تصدير السجلات
            </button>
            <button
              onClick={onClose}
              className="p-1.5 text-slate-400 hover:text-slate-100 hover:bg-slate-800 rounded-lg transition"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Toolbar: Search and View Mode */}
        <div className="p-4 border-b border-slate-800/80 bg-slate-950/40 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3 flex-1 max-w-xl">
            <form onSubmit={handleSearchSubmit} className="flex-1 relative">
              <Search className="w-4 h-4 text-slate-500 absolute right-3 top-2.5" />
              <input
                type="text"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="بحث في كود الطلب، اسم المنفذ، نص الحركة، أو القيم..."
                className="w-full bg-slate-900 border border-slate-700/60 rounded-xl pr-9 pl-4 py-2 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-amber-500"
              />
            </form>

            {isOrderPillar && (
              <div className="flex items-center p-0.5 bg-slate-900 border border-slate-700/60 rounded-xl shrink-0 font-sans text-xs">
                <button
                  type="button"
                  onClick={() => { setViewType('orders'); setPage(1); }}
                  className={`px-3 py-1.5 rounded-lg transition-all ${
                    viewType === 'orders'
                      ? 'bg-amber-500 text-slate-950 font-bold shadow-sm'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  الطلبات الفريدة
                </button>
                <button
                  type="button"
                  onClick={() => { setViewType('events'); setPage(1); }}
                  className={`px-3 py-1.5 rounded-lg transition-all ${
                    viewType === 'events'
                      ? 'bg-amber-500 text-slate-950 font-bold shadow-sm'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  جميع الحركات
                </button>
              </div>
            )}
          </div>

          <div className="flex items-center gap-2 text-xs text-slate-400 font-mono">
            <span>الصفحة {page} من {totalPages}</span>
            <span>• المصدر: لوجز Vendoor المصدرية</span>
          </div>
        </div>

        {/* Table Body */}
        <div className="flex-1 overflow-auto p-4">
          {loading ? (
            <div className="py-20 flex flex-col items-center justify-center gap-3 text-slate-400">
              <div className="w-10 h-10 border-2 border-amber-500/20 border-t-amber-400 rounded-full animate-spin" />
              <p className="text-sm font-sans">جاري جلب تفاصيل السجلات المصدرية من اللوجز...</p>
            </div>
          ) : logEvents.length === 0 ? (
            <div className="py-20 text-center text-slate-500">
              <FileText className="w-12 h-12 mx-auto mb-2 opacity-30" />
              <p className="text-sm font-sans">لا توجد سجلات مطابقة لمعايير البحث في هذه الفترة</p>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-slate-800/80">
              <table className="w-full text-right text-xs">
                <thead>
                  <tr className="bg-slate-950/80 text-slate-400 border-b border-slate-800 font-sans">
                    <th className="py-3 px-3">#</th>
                    <th className="py-3 px-3">كود الطلب</th>
                    {viewType === 'orders' && <th className="py-3 px-3">حركات الطلب</th>}
                    <th className="py-3 px-3">التوقيت (القاهرة)</th>
                    <th className="py-3 px-3">المنفذ</th>
                    <th className="py-3 px-3">نوع الإجراء</th>
                    <th className="py-3 px-3">التفاصيل والتغييرات</th>
                    <th className="py-3 px-3">نص الحركة المصدرية الكامل</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60 font-mono">
                  {logEvents.map((ev, idx) => {
                    const rowNum = (page - 1) * 25 + idx + 1;
                    return (
                      <tr key={ev.id || idx} className="hover:bg-slate-800/30 transition-colors">
                        <td className="py-3 px-3 text-slate-500">{rowNum}</td>
                        <td className="py-3 px-3 font-bold text-amber-400">
                          {ev.order_code ? (
                            <div className="flex items-center gap-1.5">
                              <span>{ev.order_code}</span>
                              <button
                                onClick={() => handleCopy(ev.order_code)}
                                className="text-slate-500 hover:text-slate-300 p-0.5 rounded transition"
                                title="نسخ الكود"
                              >
                                {copiedCode === ev.order_code ? (
                                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                                ) : (
                                  <Copy className="w-3.5 h-3.5" />
                                )}
                              </button>
                              {onSelectOrder && (
                                <button
                                  onClick={() => {
                                    onClose();
                                    onSelectOrder(ev.order_code);
                                  }}
                                  className="text-sky-400 hover:text-sky-300 p-0.5 rounded transition"
                                  title="فتح تفاصيل الطلب"
                                >
                                  <ExternalLink className="w-3.5 h-3.5" />
                                </button>
                              )}
                            </div>
                          ) : (
                            <span className="text-slate-500 font-sans">عام / غير محدد</span>
                          )}
                        </td>
                        {viewType === 'orders' && (
                          <td className="py-3 px-3">
                            <span className="px-2 py-0.5 rounded-md bg-slate-800 text-amber-400 text-[11px] font-mono border border-slate-700/60">
                              {ev.events_count_for_order || 1} حركة
                            </span>
                          </td>
                        )}
                        <td className="py-3 px-3 text-slate-300 whitespace-nowrap text-[11px]">
                          {ev.event_timestamp ? ev.event_timestamp.replace('T', ' ').slice(0, 19) : '—'}
                        </td>
                        <td className="py-3 px-3 font-sans">
                          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium ${
                            ev.is_system_actor === 1
                              ? 'bg-slate-800 text-slate-400'
                              : 'bg-amber-500/10 text-amber-300 border border-amber-500/20'
                          }`}>
                            <User className="w-3 h-3" />
                            {ev.actor_name || 'غير محدد'}
                          </span>
                        </td>
                        <td className="py-3 px-3 font-sans">
                          <span className="px-2 py-0.5 rounded bg-slate-800 text-slate-200 border border-slate-700/60 text-[11px]">
                            {ev.action_type}
                          </span>
                        </td>
                        <td className="py-3 px-3 font-sans text-slate-300 max-w-xs">
                          {ev.to_status ? (
                            <div className="flex items-center gap-1.5 font-mono text-[11px]">
                              {ev.from_status && <span className="text-slate-500">{ev.from_status}</span>}
                              {ev.from_status && <span>←</span>}
                              <span className="px-1.5 py-0.5 rounded bg-emerald-950/60 border border-emerald-800/60 text-emerald-400 font-bold">
                                {ev.to_status}
                              </span>
                            </div>
                          ) : ev.field_name ? (
                            <div className="text-[11px]">
                              <span className="text-slate-400">{ev.field_name}: </span>
                              {ev.new_value && <span className="text-amber-300 font-mono">{ev.new_value}</span>}
                            </div>
                          ) : (
                            <span className="text-slate-500">—</span>
                          )}
                        </td>
                        <td className="py-3 px-3 font-sans text-slate-400 text-xs max-w-md break-words">
                          {ev.raw_action_text || '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Footer Pagination */}
        <div className="p-4 border-t border-slate-800 flex items-center justify-between bg-slate-950/40 text-xs">
          <div className="text-slate-400 font-sans">
            عرض {logEvents.length} من أصل {total.toLocaleString()} سجل موثق
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1 || loading}
              className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 disabled:opacity-40 transition"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
            <span className="font-mono text-slate-300 px-2">
              {page} / {totalPages}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages || loading}
              className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 disabled:opacity-40 transition"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
