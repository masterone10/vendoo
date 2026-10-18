import React, { useState, useEffect } from 'react';
import { Search, Filter, Eye, AlertTriangle, Layers, ChevronRight, ChevronLeft } from 'lucide-react';
import { Order } from '../types';

interface OrdersViewProps {
  initialStatus?: string;
  selectedDate?: string;
  onSelectOrder: (orderCode: string) => void;
}

export const OrdersView: React.FC<OrdersViewProps> = ({
  initialStatus = 'all',
  selectedDate,
  onSelectOrder,
}) => {
  const [orders, setOrders] = useState<Order[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState(initialStatus);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [multiOnly, setMultiOnly] = useState(false);
  const [lowDeliveryOnly, setLowDeliveryOnly] = useState(false);

  const limit = 50;

  useEffect(() => {
    setStatus(initialStatus);
    setPage(0);
  }, [initialStatus]);

  useEffect(() => {
    fetchOrders();
  }, [status, page, multiOnly, lowDeliveryOnly, selectedDate]);

  async function fetchOrders() {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (status && status !== 'all') params.set('status', status);
      if (search) params.set('search', search);
      if (multiOnly) params.set('multiMerchant', '1');
      if (lowDeliveryOnly) params.set('lowDelivery', '1');
      if (selectedDate) params.set('date', selectedDate);
      params.set('limit', String(limit));
      params.set('offset', String(page * limit));

      const res = await fetch(`/api/orders?${params.toString()}`);
      const data = await res.json();
      setOrders(data.orders || []);
      setTotal(data.total || 0);
    } catch (err) {
      console.error('Error fetching orders:', err);
    } finally {
      setLoading(false);
    }
  }

  function handleSearchSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPage(0);
    fetchOrders();
  }

  const totalPages = Math.ceil(total / limit);

  return (
    <div className="p-6 space-y-5 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-800 pb-4">
        <div>
          <h2 className="text-xl font-bold text-slate-100 flex items-center gap-2">
            <span>سجل الطلبات الشامل</span>
            <span className="text-xs font-mono text-slate-400 font-semibold px-2 py-0.5 rounded bg-slate-800 border border-slate-700">
              {total} طلب مؤكد محليًا
            </span>
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            البحث في كافة الطلبات المستخرجة من Vendoor مع فلاتر الحالات ونسب الاستلام وتعدد التجار
          </p>
        </div>

        {/* Status Dropdown & Fast Toggles */}
        <div className="flex flex-wrap items-center gap-3">
          <select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setPage(0);
            }}
            className="bg-slate-900 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-amber-500/50"
          >
            <option value="all">كل الحالات</option>
            <option value="New">أوردر جديد (New)</option>
            <option value="Pending">معلق (Pending)</option>
            <option value="Processing">قيد التنفيذ (Processing)</option>
            <option value="Canceling">قيد الإلغاء (Canceling)</option>
            <option value="Printed">مطبوع / مؤكد (Printed)</option>
            <option value="Canceled">ملغي (Canceled)</option>
          </select>

          <button
            onClick={() => {
              setMultiOnly(!multiOnly);
              setPage(0);
            }}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors flex items-center gap-1.5 cursor-pointer ${
              multiOnly
                ? 'bg-rose-500/20 border-rose-500/40 text-rose-300'
                : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'
            }`}
          >
            <AlertTriangle className="w-3.5 h-3.5" />
            <span>تعدد المستودعات (Multi-Warehouse)</span>
          </button>

          <button
            onClick={() => {
              setLowDeliveryOnly(!lowDeliveryOnly);
              setPage(0);
            }}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors cursor-pointer ${
              lowDeliveryOnly
                ? 'bg-rose-500/20 border-rose-500/40 text-rose-300'
                : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'
            }`}
          >
            نسبة استلام &lt; 70%
          </button>
        </div>
      </div>

      {/* Search Bar */}
      <form onSubmit={handleSearchSubmit} className="flex gap-2 max-w-lg">
        <div className="relative flex-1">
          <Search className="w-4 h-4 absolute right-3 top-3 text-slate-500" />
          <input
            type="text"
            placeholder="بحث بالكود (tc7328)، الهاتف، أو اسم العميل..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full bg-slate-900 border border-slate-800 rounded-lg pr-9 pl-4 py-2 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-amber-500/50"
          />
        </div>
        <button
          type="submit"
          className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium rounded-lg transition-colors cursor-pointer"
        >
          بحث
        </button>
      </form>

      {/* Table */}
      <div className="border border-slate-800 rounded-xl bg-slate-900/60 overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-right text-xs">
            <thead>
              <tr className="border-b border-slate-800 bg-slate-950/40 text-slate-400">
                <th className="py-3 px-4 font-semibold">كود الطلب</th>
                <th className="py-3 px-4 font-semibold">الحالة الحالية</th>
                <th className="py-3 px-4 font-semibold">العميل</th>
                <th className="py-3 px-4 font-semibold">الهاتف</th>
                <th className="py-3 px-4 font-semibold">المحافظة</th>
                <th className="py-3 px-4 font-semibold">أكواد المستودعات (Warehouse)</th>
                <th className="py-3 px-4 font-semibold">نسبة التسليم</th>
                <th className="py-3 px-4 font-semibold">الإجمالي</th>
                <th className="py-3 px-4 font-semibold">تاريخ الإنشاء</th>
                <th className="py-3 px-4 font-semibold text-center">إجراء</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {loading ? (
                <tr>
                  <td colSpan={10} className="py-12 text-center text-slate-500">
                    جاري تحميل الطلبات...
                  </td>
                </tr>
              ) : orders.length === 0 ? (
                <tr>
                  <td colSpan={10} className="py-12 text-center text-slate-500">
                    لا توجد طلبات مطابقة لمعايير البحث
                  </td>
                </tr>
              ) : (
                orders.map((order) => {
                  return (
                    <tr
                      key={order.id}
                      className="hover:bg-slate-800/40 transition-colors group"
                    >
                      {/* Random Order Code */}
                      <td className="py-3 px-4">
                        <button
                          onClick={() => onSelectOrder(order.random_number)}
                          className="font-mono font-bold text-amber-400 hover:text-amber-300 text-sm hover:underline cursor-pointer"
                        >
                          {order.random_number}
                        </button>
                      </td>

                      {/* Status */}
                      <td className="py-3 px-4">
                        <span
                          className={`font-semibold ${
                            order.current_status === 'Printed'
                              ? 'text-emerald-400'
                              : order.current_status === 'Pending'
                              ? 'text-amber-400'
                              : order.current_status === 'Processing'
                              ? 'text-sky-400'
                              : order.current_status === 'Canceled'
                              ? 'text-rose-400'
                              : 'text-slate-300'
                          }`}
                        >
                          {order.current_status}
                        </span>
                      </td>

                      {/* Customer */}
                      <td className="py-3 px-4 font-medium text-slate-200">
                        {order.customer_name || 'غير محدد'}
                      </td>

                      {/* Phone */}
                      <td className="py-3 px-4 font-mono text-slate-300">
                        {order.customer_phone}
                      </td>

                      {/* Governorate */}
                      <td className="py-3 px-4 text-slate-400">
                        {order.governorate || '—'}
                      </td>

                      {/* Warehouse Codes */}
                      <td className="py-3 px-4">
                        {order.distinct_merchant_count > 1 ? (
                          <span className="text-rose-400 font-bold inline-flex items-center gap-1">
                            <AlertTriangle className="w-3.5 h-3.5" />
                            <span>{order.distinct_merchant_count} مستودعات</span>
                          </span>
                        ) : (
                          <span className="text-slate-400 text-xs">مستودع واحد</span>
                        )}
                      </td>

                      {/* Delivery Rate */}
                      <td className="py-3 px-4">
                        {order.delivery_rate !== null ? (
                          <div className="flex items-center gap-1.5 font-mono">
                            <span
                              className={`font-bold ${
                                order.delivery_rate < 70 ? 'text-rose-400' : 'text-emerald-400'
                              }`}
                            >
                              {order.delivery_rate}%
                            </span>
                            {order.delivery_rate_num !== null && (
                              <span className="text-[10px] text-slate-500">
                                ({order.delivery_rate_num}/{order.delivery_rate_denom})
                              </span>
                            )}
                          </div>
                        ) : (
                          <span className="text-slate-500 text-[11px]">لا توجد طلبات سابقة</span>
                        )}
                      </td>

                      {/* Total */}
                      <td className="py-3 px-4 font-mono font-semibold text-slate-200">
                        {order.total_order} ج.م
                      </td>

                      {/* Created Date */}
                      <td className="py-3 px-4 text-slate-400 font-mono text-[11px]">
                        {order.created_at_source || '—'}
                      </td>

                      {/* Actions */}
                      <td className="py-3 px-4 text-center">
                        <button
                          onClick={() => onSelectOrder(order.random_number)}
                          className="p-1.5 text-slate-400 hover:text-amber-400 hover:bg-slate-800 rounded-md transition-colors cursor-pointer"
                          title="عرض التفاصيل الكاملة"
                        >
                          <Eye className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination Bar */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between p-4 border-t border-slate-800 bg-slate-950/30 text-xs text-slate-400">
            <div>
              عرض {page * limit + 1} إلى {Math.min((page + 1) * limit, total)} من أصل {total} طلب
            </div>
            <div className="flex items-center gap-2">
              <button
                disabled={page === 0}
                onClick={() => setPage(p => Math.max(0, p - 1))}
                className="px-3 py-1 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed rounded-md text-slate-200 flex items-center gap-1 transition-colors cursor-pointer"
              >
                <ChevronRight className="w-3.5 h-3.5" />
                <span>السابق</span>
              </button>
              <span className="font-mono text-slate-300">
                صفحة {page + 1} من {totalPages}
              </span>
              <button
                disabled={page >= totalPages - 1}
                onClick={() => setPage(p => p + 1)}
                className="px-3 py-1 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed rounded-md text-slate-200 flex items-center gap-1 transition-colors cursor-pointer"
              >
                <span>التالي</span>
                <ChevronLeft className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
