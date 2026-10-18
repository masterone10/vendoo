import React, { useState, useEffect } from 'react';
import { AlertTriangle, PhoneCall, ShoppingBag, CheckCircle, Search, Eye } from 'lucide-react';
import { Order } from '../types';

interface PrintedViewProps {
  initialSubTab?: 'all' | 'no_extra_phone' | 'multi_merchant' | 'low_delivery';
  onSelectOrder: (orderCode: string) => void;
}

export const PrintedView: React.FC<PrintedViewProps> = ({
  initialSubTab = 'all',
  onSelectOrder,
}) => {
  const [subTab, setSubTab] = useState<'all' | 'no_extra_phone' | 'multi_merchant' | 'low_delivery'>(initialSubTab);
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');

  useEffect(() => {
    setSubTab(initialSubTab);
  }, [initialSubTab]);

  useEffect(() => {
    fetchPrintedOrders();
  }, [subTab]);

  async function fetchPrintedOrders() {
    setLoading(true);
    try {
      const res = await fetch(`/api/printed?category=${subTab}`);
      const data = await res.json();
      setOrders(data.orders || []);
    } catch (err) {
      console.error('Error fetching printed orders:', err);
    } finally {
      setLoading(false);
    }
  }

  const filtered = orders.filter((o) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      o.random_number.toLowerCase().includes(q) ||
      o.customer_phone.includes(q) ||
      (o.customer_name && o.customer_name.toLowerCase().includes(q))
    );
  });

  return (
    <div className="p-6 space-y-5 max-w-7xl mx-auto">
      {/* Header & Tabs */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-800 pb-4">
        <div>
          <h2 className="text-xl font-bold text-slate-100 flex items-center gap-2">
            <span>الطلبات المطبوعة والمؤكدة (Printed Orders)</span>
            <span className="text-xs font-mono text-emerald-400 font-semibold px-2 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/20">
              {orders.length} طلب
            </span>
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            مراقبة شاملة لكفاءة وجودة الطلبات التي دخلت حالة الطباعة والتأكيد
          </p>
        </div>

        {/* Category Tabs */}
        <div className="flex items-center gap-1.5 p-1 bg-slate-900 border border-slate-800 rounded-lg text-xs font-medium">
          <button
            onClick={() => setSubTab('all')}
            className={`px-3 py-1.5 rounded-md transition-all cursor-pointer ${
              subTab === 'all'
                ? 'bg-slate-800 text-slate-100 shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            الكل
          </button>
          <button
            onClick={() => setSubTab('multi_merchant')}
            className={`px-3 py-1.5 rounded-md transition-all flex items-center gap-1.5 cursor-pointer ${
              subTab === 'multi_merchant'
                ? 'bg-rose-500/20 text-rose-300 border border-rose-500/30 shadow-sm'
                : 'text-slate-400 hover:text-rose-400'
            }`}
          >
            <AlertTriangle className="w-3.5 h-3.5 text-rose-400" />
            <span>فئة ب: تعدد أكواد المستودعات</span>
          </button>
          <button
            onClick={() => setSubTab('no_extra_phone')}
            className={`px-3 py-1.5 rounded-md transition-all flex items-center gap-1.5 cursor-pointer ${
              subTab === 'no_extra_phone'
                ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30 shadow-sm'
                : 'text-slate-400 hover:text-amber-400'
            }`}
          >
            <PhoneCall className="w-3.5 h-3.5 text-amber-400" />
            <span>فئة أ: دون هاتف إضافي</span>
          </button>
          <button
            onClick={() => setSubTab('low_delivery')}
            className={`px-3 py-1.5 rounded-md transition-all flex items-center gap-1.5 cursor-pointer ${
              subTab === 'low_delivery'
                ? 'bg-rose-500/20 text-rose-300 border border-rose-500/30 shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <span>فئة ج: نسبة تسليم &lt; 70%</span>
          </button>
        </div>
      </div>

      {/* Search Input */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-md">
          <Search className="w-4 h-4 absolute right-3 top-3 text-slate-500" />
          <input
            type="text"
            placeholder="بحث بالكود العشوائي (tc7328)، الهاتف، أو اسم العميل..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full bg-slate-900 border border-slate-800 rounded-lg pr-9 pl-4 py-2 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-amber-500/50"
          />
        </div>
      </div>

      {/* Orders Table */}
      <div className="border border-slate-800 rounded-xl bg-slate-900/60 overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-right text-xs">
            <thead>
              <tr className="border-b border-slate-800 bg-slate-950/40 text-slate-400">
                <th className="py-3 px-4 font-semibold">كود الطلب</th>
                <th className="py-3 px-4 font-semibold">العميل</th>
                <th className="py-3 px-4 font-semibold">الهاتف الأساسي</th>
                <th className="py-3 px-4 font-semibold">الهاتف الإضافي</th>
                <th className="py-3 px-4 font-semibold">المحافظة</th>
                <th className="py-3 px-4 font-semibold">أكواد المستودعات</th>
                <th className="py-3 px-4 font-semibold">نسبة التسليم</th>
                <th className="py-3 px-4 font-semibold">الإجمالي</th>
                <th className="py-3 px-4 font-semibold">تاريخ الطباعة</th>
                <th className="py-3 px-4 font-semibold text-center">إجراء</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {loading ? (
                <tr>
                  <td colSpan={10} className="py-12 text-center text-slate-500">
                    جاري تحميل الطلبات المطبوعة...
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={10} className="py-12 text-center text-slate-500">
                    لا توجد طلبات مطابقة للفئة المحددة حاليًا
                  </td>
                </tr>
              ) : (
                filtered.map((order) => {
                  const isMulti = order.multi_merchant_flag === 1;
                  const hasLowDelivery = order.delivery_rate !== null && order.delivery_rate < 70;
                  const noExtraPhone = !order.customer_phone_extra || order.extra_phone_valid === 0;

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
                        {order.order_no && (
                          <div className="text-[10px] text-slate-500 font-mono mt-0.5">
                            داخلي: {order.order_no}
                          </div>
                        )}
                      </td>

                      {/* Customer */}
                      <td className="py-3 px-4 font-medium text-slate-200">
                        {order.customer_name || 'غير محدد'}
                      </td>

                      {/* Primary Phone */}
                      <td className="py-3 px-4 font-mono text-slate-300">
                        {order.customer_phone}
                      </td>

                      {/* Extra Phone with Validation */}
                      <td className="py-3 px-4">
                        {order.customer_phone_extra ? (
                          <span
                            className={`font-mono ${
                              order.extra_phone_valid === 1
                                ? 'text-slate-300'
                                : 'text-rose-400 line-through'
                            }`}
                          >
                            {order.customer_phone_extra}
                          </span>
                        ) : (
                          <span className="text-amber-400/80 text-[11px] font-medium">
                            لا يوجد
                          </span>
                        )}
                      </td>

                      {/* Governorate */}
                      <td className="py-3 px-4 text-slate-400">
                        {order.governorate || '—'}
                      </td>

                      {/* Merchant Codes */}
                      <td className="py-3 px-4">
                        {isMulti ? (
                          <span className="inline-flex items-center gap-1 text-rose-400 font-bold">
                            <AlertTriangle className="w-3.5 h-3.5" />
                            <span>{order.distinct_merchant_count} مستودعات</span>
                          </span>
                        ) : (
                          <span className="text-slate-400 text-xs">
                            مستودع واحد ({order.distinct_merchant_count})
                          </span>
                        )}
                      </td>

                      {/* Customer Delivery Rate */}
                      <td className="py-3 px-4">
                        {order.delivery_rate !== null ? (
                          <div className="flex items-center gap-1.5">
                            <span
                              className={`font-mono font-bold ${
                                order.delivery_rate < 70 ? 'text-rose-400' : 'text-emerald-400'
                              }`}
                            >
                              {order.delivery_rate}%
                            </span>
                            {order.delivery_rate_num !== null && (
                              <span className="text-[10px] text-slate-500 font-mono">
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

                      {/* Printed Date */}
                      <td className="py-3 px-4 text-slate-400 font-mono text-[11px]">
                        {order.printed_date || '—'}
                      </td>

                      {/* Action */}
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
      </div>
    </div>
  );
};
