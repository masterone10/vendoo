import React, { useState, useEffect } from 'react';
import { FileText, Search, Filter, Calendar, User, Clock, ArrowUpRight, RefreshCw } from 'lucide-react';

interface LogsViewProps {
  onSelectOrder?: (orderCode: string) => void;
  selectedDate?: string;
}

export const LogsView: React.FC<LogsViewProps> = ({ onSelectOrder, selectedDate }) => {
  const [logs, setLogs] = useState<any[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [search, setSearch] = useState<string>('');
  const [actor, setActor] = useState<string>('all');
  const [actionType, setActionType] = useState<string>('all');
  const [totalCount, setTotalCount] = useState<number>(0);
  const [page, setPage] = useState<number>(1);

  useEffect(() => {
    fetchLogs();
  }, [page, actor, actionType, selectedDate]);

  async function fetchLogs() {
    setLoading(true);
    try {
      let url = `/api/logs?page=${page}&limit=50`;
      if (search) url += `&search=${encodeURIComponent(search)}`;
      if (actor && actor !== 'all') url += `&actor=${encodeURIComponent(actor)}`;
      if (actionType && actionType !== 'all') url += `&actionType=${encodeURIComponent(actionType)}`;
      if (selectedDate) url += `&startDate=${selectedDate}&endDate=${selectedDate}`;

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

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto font-['Cairo',sans-serif]" dir="rtl">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-stone-800 pb-4">
        <div>
          <h2 className="text-xl font-bold text-stone-100 flex items-center gap-2">
            <FileText className="w-5 h-5 text-amber-400" />
            <span>سجل العمليات والأنشطة المصدري (System & Audit Logs)</span>
          </h2>
          <p className="text-xs text-stone-400 mt-1">
            سجل دقيق وموثق لكافة الأنشطة المنفذة من قبل موظفي التشغيل والنظام مستخرج مباشرة من سجلات فيندور
          </p>
        </div>

        <button
          onClick={fetchLogs}
          disabled={loading}
          className="px-3 py-1.5 bg-stone-900 border border-stone-800 hover:bg-stone-800 text-stone-300 text-xs rounded-lg flex items-center gap-2 transition-colors cursor-pointer"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          <span>تحديث السجل</span>
        </button>
      </div>

      {/* Filters Bar */}
      <div className="p-4 rounded-xl bg-stone-900/80 border border-stone-800 flex flex-wrap items-center justify-between gap-4">
        <form onSubmit={handleSearchSubmit} className="flex items-center gap-2 flex-1 min-w-[240px]">
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-stone-400 absolute right-3 top-2.5" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="بحث بكود الطلب أو نص الإجراء..."
              className="w-full bg-stone-950 border border-stone-800 rounded-lg pr-9 pl-3 py-1.5 text-xs text-stone-200 placeholder:text-stone-500"
            />
          </div>
          <button
            type="submit"
            className="px-3 py-1.5 bg-stone-800 hover:bg-stone-700 text-stone-200 text-xs rounded-lg font-medium cursor-pointer"
          >
            بحث
          </button>
        </form>

        <div className="flex items-center gap-3">
          <div>
            <select
              value={actionType}
              onChange={(e) => { setActionType(e.target.value); setPage(1); }}
              className="bg-stone-950 border border-stone-800 rounded-lg px-2.5 py-1.5 text-xs text-stone-200"
            >
              <option value="all">كافة أنواع الإجراءات</option>
              <option value="status_change">تغيير حالة (Status Change)</option>
              <option value="print">طباعة البوليصة (Print)</option>
              <option value="confirm">تأكيد الطلب (Confirm)</option>
              <option value="cancel">إلغاء الطلب (Cancel)</option>
              <option value="edit">تعديل بيانات (Edit)</option>
            </select>
          </div>

          <div className="text-xs text-stone-400 font-mono">
            إجمالي السجلات: <span className="text-stone-100 font-bold">{totalCount}</span>
          </div>
        </div>
      </div>

      {/* Logs Table */}
      <div className="bg-stone-900/90 border border-stone-800 rounded-xl overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-right text-xs">
            <thead className="bg-stone-950/80 border-b border-stone-800 text-stone-400 font-medium">
              <tr>
                <th className="py-3 px-4">توقيت الحدث المصدري (Cairo)</th>
                <th className="py-3 px-4">الموظف / المنفذ</th>
                <th className="py-3 px-4">نوع الإجراء</th>
                <th className="py-3 px-4">كود الطلب</th>
                <th className="py-3 px-4">تفاصيل الإجراء المصدري</th>
                <th className="py-3 px-4 text-center">إجراء</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-800/60 text-stone-200">
              {loading && logs.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-12 text-center text-stone-400">
                    <RefreshCw className="w-5 h-5 animate-spin mx-auto mb-2 text-stone-500" />
                    <span>جاري تحميل سجل العمليات...</span>
                  </td>
                </tr>
              ) : logs.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-12 text-center text-stone-500">
                    لا توجد سجلات مطابقة للفترة أو الفلاتر المحددة
                  </td>
                </tr>
              ) : (
                logs.map((l: any) => (
                  <tr key={l.id} className="hover:bg-stone-800/40 transition-colors">
                    <td className="py-3 px-4 font-mono text-[11px] text-stone-300">
                      {l.event_timestamp ? new Date(l.event_timestamp).toLocaleString('ar-EG', {
                        year: 'numeric',
                        month: '2-digit',
                        day: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit',
                      }) : 'غير محدد'}
                    </td>
                    <td className="py-3 px-4 font-semibold text-stone-100">
                      <div className="flex items-center gap-1.5">
                        <User className="w-3.5 h-3.5 text-stone-400" />
                        <span>{l.actor_name || 'النظام'}</span>
                      </div>
                    </td>
                    <td className="py-3 px-4">
                      <span className="px-2 py-0.5 rounded text-[11px] font-mono bg-stone-800 text-stone-300">
                        {l.action_type || 'نشاط'}
                      </span>
                    </td>
                    <td className="py-3 px-4 font-mono font-bold text-amber-400">
                      {l.order_code || 'عام'}
                    </td>
                    <td className="py-3 px-4 text-stone-300 max-w-md truncate">
                      {l.raw_action_text || '-'}
                    </td>
                    <td className="py-3 px-4 text-center">
                      {l.order_code && onSelectOrder && (
                        <button
                          onClick={() => onSelectOrder(l.order_code)}
                          className="p-1 hover:bg-stone-800 rounded text-stone-400 hover:text-amber-400 transition-colors cursor-pointer"
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
        <div className="p-3 bg-stone-950/60 border-t border-stone-800 flex items-center justify-between text-xs text-stone-400">
          <span>صفحة {page} من {Math.max(1, Math.ceil(totalCount / 50))}</span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="px-2.5 py-1 rounded bg-stone-900 border border-stone-800 disabled:opacity-30 hover:bg-stone-800 cursor-pointer"
            >
              السابق
            </button>
            <button
              onClick={() => setPage((p) => p + 1)}
              disabled={page * 50 >= totalCount}
              className="px-2.5 py-1 rounded bg-stone-900 border border-stone-800 disabled:opacity-30 hover:bg-stone-800 cursor-pointer"
            >
              التالي
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
