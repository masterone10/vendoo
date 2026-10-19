import React, { useState, useEffect } from 'react';
import {
  X,
  ShoppingBag,
  User,
  Phone,
  MapPin,
  Calendar,
  AlertTriangle,
  Clock,
  ShieldAlert,
  RotateCw,
  ExternalLink,
  Tag,
  CheckCircle2,
  Eye,
  MessageSquare,
} from 'lucide-react';
import { Order, OrderItem, Alert, SystemLogEvent } from '../types';
import { isLowDeliveryRate } from '../utils/delivery';
import { LogDetailsModal } from './LogDetailsModal';

interface OrderDetailsModalProps {
  orderCode: string | null;
  onClose: () => void;
}

export const OrderDetailsModal: React.FC<OrderDetailsModalProps> = ({ orderCode, onClose }) => {
  const [order, setOrder] = useState<Order | null>(null);
  const [items, setItems] = useState<OrderItem[]>([]);
  const [timeline, setTimeline] = useState<any[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [customerObservations, setCustomerObservations] = useState<any[]>([]);
  const [sourceLogs, setSourceLogs] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (orderCode) {
      fetchOrderDetails(orderCode);
    }
  }, [orderCode]);

  async function fetchOrderDetails(code: string) {
    setLoading(true);
    try {
      const res = await fetch(`/api/orders/${code}`);
      const data = await res.json();
      setOrder(data.order || null);
      setItems(data.items || []);
      setTimeline(data.timeline || []);
      setAlerts(data.alerts || []);
      setCustomerObservations(data.customerObservations || []);
      setSourceLogs(data.sourceLogs || []);
    } catch (err) {
      console.error('Error fetching order details:', err);
    } finally {
      setLoading(false);
    }
  }

  if (!orderCode) return null;

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/85 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-4xl max-h-[90vh] flex flex-col shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="p-5 border-b border-slate-800 flex items-center justify-between bg-slate-950/50">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-400 font-mono font-bold">
              #
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-lg font-bold font-mono text-amber-400">
                  {order?.random_number || orderCode}
                </h3>
                {order && (
                  <span
                    className={`text-xs font-semibold px-2 py-0.5 rounded ${
                      order.current_status === 'Printed'
                        ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                        : order.current_status === 'Pending'
                        ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                        : order.current_status === 'Processing'
                        ? 'bg-sky-500/10 text-sky-400 border border-sky-500/20'
                        : order.current_status === 'Canceled'
                        ? 'bg-rose-500/10 text-rose-400 border border-rose-500/20'
                        : 'bg-slate-800 text-slate-300'
                    }`}
                  >
                    {order.current_status}
                  </span>
                )}
                {order?.multi_merchant_flag === 1 && (
                  <span className="text-xs font-bold text-rose-400 bg-rose-500/10 border border-rose-500/20 px-2 py-0.5 rounded flex items-center gap-1">
                    <AlertTriangle className="w-3.5 h-3.5" />
                    <span>تعدد مخازن ({order.distinct_merchant_count})</span>
                  </span>
                )}
              </div>
              <p className="text-xs text-slate-400 mt-0.5">
                الرقم الداخلي: {order?.order_no || order?.vendoor_id || '—'} · نوع الطلب: {order?.order_type || 'أوردر جديد'}
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-2 text-slate-400 hover:text-slate-100 rounded-lg hover:bg-slate-800 transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="p-6 overflow-y-auto space-y-6 flex-1 text-xs">
          {loading ? (
            <div className="py-20 text-center text-slate-500 flex flex-col items-center gap-2">
              <RotateCw className="w-6 h-6 animate-spin text-amber-500" />
              <span>جاري استخراج السجلات التاريخية للطلب...</span>
            </div>
          ) : !order ? (
            <div className="py-16 text-center text-slate-500">
              لم يتم العثور على سجلات للطلب المطلوب
            </div>
          ) : (
            <>
              {/* Critical Alerts Banner if any */}
              {alerts.length > 0 && (
                <div className="p-4 rounded-xl bg-rose-500/10 border border-rose-500/30 space-y-2">
                  <div className="flex items-center gap-2 text-rose-300 font-bold text-sm">
                    <ShieldAlert className="w-4 h-4 text-rose-400" />
                    <span>تنبيه تشغيلي حرج مسجل على هذا الطلب:</span>
                  </div>
                  {alerts.map((a) => (
                    <div key={a.id} className="text-xs text-slate-300">
                      <span className="font-semibold text-rose-400">{a.title}</span> — {a.description}
                      <span className="text-slate-500 mr-2 font-mono">
                        (الحالة: {a.status === 'OPEN' ? 'مفتوح' : a.status === 'IN_REVIEW' ? 'قيد المراجعة' : 'تم الحل'})
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {/* Grid: Customer Data & Intelligence */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Customer Info Card */}
                <div className="p-4 rounded-xl bg-slate-950/60 border border-slate-800 space-y-3">
                  <h4 className="font-bold text-slate-200 flex items-center gap-2 border-b border-slate-800 pb-2">
                    <User className="w-4 h-4 text-sky-400" />
                    <span>بيانات العميل والتوصيل</span>
                  </h4>

                  <div className="space-y-2 text-slate-300">
                    <div className="flex justify-between">
                      <span className="text-slate-500">اسم العميل:</span>
                      <span className="font-medium text-slate-100">{order.customer_name || '—'}</span>
                    </div>

                    <div className="flex justify-between">
                      <span className="text-slate-500">الهاتف الأساسي:</span>
                      <span className="font-mono text-slate-100 font-semibold">{order.customer_phone}</span>
                    </div>

                    <div className="flex justify-between">
                      <span className="text-slate-500">هاتف آخر:</span>
                      {order.customer_phone_extra ? (
                        <span className={`font-mono ${order.extra_phone_valid ? 'text-slate-200' : 'text-rose-400 line-through'}`}>
                          {order.customer_phone_extra}
                        </span>
                      ) : (
                        <span className="text-amber-400">غير مسجل</span>
                      )}
                    </div>

                    <div className="flex justify-between">
                      <span className="text-slate-500">المحافظة:</span>
                      <span className="text-slate-200">{order.governorate || '—'}</span>
                    </div>

                    <div className="flex justify-between">
                      <span className="text-slate-500">العنوان:</span>
                      <span className="text-slate-200 text-left max-w-xs">{order.address || '—'}</span>
                    </div>

                    <div className="flex justify-between pt-1 border-t border-slate-800/80">
                      <span className="text-slate-500">كود الأفلييت:</span>
                      <span className="font-mono text-slate-300">{order.affiliate_code} ({order.affiliate_name})</span>
                    </div>
                  </div>
                </div>

                {/* Customer Intelligence & Delivery Rates */}
                <div className="p-4 rounded-xl bg-slate-950/60 border border-slate-800 space-y-3">
                  <h4 className="font-bold text-slate-200 flex items-center gap-2 border-b border-slate-800 pb-2">
                    <Clock className="w-4 h-4 text-emerald-400" />
                    <span>السجل التاريخي للعميل (Vendoor Intelligence)</span>
                  </h4>

                  <div className="space-y-2 text-slate-300">
                    <div className="flex justify-between">
                      <span className="text-slate-500">عدد تكرار رقم العميل:</span>
                      <span className="font-mono font-bold text-amber-400">
                        {order.phone_repetition_count !== null ? order.phone_repetition_count : '—'}
                      </span>
                    </div>

                    <div className="flex justify-between">
                      <span className="text-slate-500">إجمالي الطلبات السابقة:</span>
                      <span className="font-mono text-slate-200">{order.total_customer_orders ?? '—'}</span>
                    </div>

                    <div className="flex justify-between">
                      <span className="text-slate-500">نسبة التسليم:</span>
                      <div className="flex items-center gap-1 font-mono font-bold">
                        {order.delivery_rate !== null && (order.delivery_rate_denom || order.total_customer_orders) ? (
                          <span className={isLowDeliveryRate(order.delivery_rate, order.cancel_rate, order.total_customer_orders, order.delivery_rate_denom) ? 'text-rose-400' : 'text-emerald-400'}>
                            {order.delivery_rate}%
                          </span>
                        ) : (
                          <span className="text-slate-400 font-normal text-xs">لا توجد طلبات سابقة (أول طلب للعميل)</span>
                        )}
                        {order.delivery_rate_num !== null && (
                          <span className="text-[10px] text-slate-500 font-normal">
                            ({order.delivery_rate_num} من {order.delivery_rate_denom})
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="flex justify-between">
                      <span className="text-slate-500">نسبة الإلغاء / المرتجع:</span>
                      <div className="flex items-center gap-1 font-mono">
                        {order.cancel_rate !== null ? (
                          <span className={order.cancel_rate > 30 ? 'text-rose-400 font-bold' : 'text-slate-300'}>
                            {order.cancel_rate}%
                          </span>
                        ) : (
                          <span className="text-slate-500">غير متاحة</span>
                        )}
                      </div>
                    </div>

                    <div className="flex justify-between">
                      <span className="text-slate-500">حالة آخر طلب سابق:</span>
                      <span className="font-medium text-slate-200">{order.customer_last_order_status || 'لا يوجد'}</span>
                    </div>

                    <div className="flex justify-between">
                      <span className="text-slate-500">المدة منذ آخر طلب:</span>
                      <span className="text-slate-400 font-mono">{order.customer_last_order_elapsed || '—'}</span>
                    </div>

                    {order.customer_delivery_warning && (
                      <div className="p-2 rounded bg-rose-500/10 border border-rose-500/20 text-rose-300 text-center font-bold">
                        {order.customer_delivery_warning}
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Products Table with Dedicated Merchant Codes and Warehouse Names */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h4 className="font-bold text-slate-200 flex items-center gap-2">
                    <ShoppingBag className="w-4 h-4 text-amber-400" />
                    <span>أصناف الطلب وتوزيع المخازن والتجار ({items.length} صنف)</span>
                  </h4>
                  <span className="text-slate-400 text-xs">
                    عدد المخازن المميزة: <strong className="text-amber-400 font-mono">{order.distinct_merchant_count}</strong>
                  </span>
                </div>

                <div className="border border-slate-800 rounded-xl overflow-hidden bg-slate-950/40">
                  <table className="w-full text-right text-xs">
                    <thead>
                      <tr className="border-b border-slate-800 bg-slate-950/80 text-slate-400">
                        <th className="py-2.5 px-3">م</th>
                        <th className="py-2.5 px-3">اسم الصنف</th>
                        <th className="py-2.5 px-3">كود الصنف / SKU</th>
                        <th className="py-2.5 px-3">كود التاجر (Merchant Code)</th>
                        <th className="py-2.5 px-3">كود المستودع</th>
                        <th className="py-2.5 px-3">اسم المستودع</th>
                        <th className="py-2.5 px-3">اللون</th>
                        <th className="py-2.5 px-3">المقاس</th>
                        <th className="py-2.5 px-3">الكمية</th>
                        <th className="py-2.5 px-3">السعر</th>
                        <th className="py-2.5 px-3">الإجمالي</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/60 font-mono">
                      {items.map((item, idx) => (
                        <tr key={item.id} className="hover:bg-slate-800/20">
                          <td className="py-2.5 px-3 text-slate-500">{idx + 1}</td>
                          <td className="py-2.5 px-3 font-sans font-medium text-slate-200">
                            {item.product_name}
                          </td>
                          <td className="py-2.5 px-3 text-slate-300 font-mono text-[11px]">{item.sku || '—'}</td>
                          <td className="py-2.5 px-3 font-mono font-bold">
                            {item.merchant_code && item.merchant_code.trim().length > 0 && !item.merchant_code.startsWith('مخزن ') && item.merchant_code !== 'غير محدد' ? (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-amber-950/70 border border-amber-500/60 text-amber-300 text-xs shadow-xs">
                                {item.merchant_code}
                              </span>
                            ) : (
                              <span
                                className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-slate-900 border border-slate-700/60 text-slate-400 font-sans text-[11px]"
                                title="كود التاجر غير متوفر في مصدر الطلب الأصلي - بانتظار استيراد ملف أكواد التجار المعتمد"
                              >
                                <span className="w-1.5 h-1.5 rounded-full bg-slate-500"></span>
                                غير متوفر
                              </span>
                            )}
                          </td>
                          <td className="py-2.5 px-3 font-mono">
                            {item.warehouse_code ? (
                              <span className="px-2 py-0.5 rounded bg-slate-900 border border-slate-700/60 text-sky-300 font-bold text-xs">
                                {item.warehouse_code}
                              </span>
                            ) : (
                              <span className="text-slate-500">—</span>
                            )}
                          </td>
                          <td className="py-2.5 px-3 font-sans">
                            {item.warehouse_name ? (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-sky-950/60 border border-sky-800/70 text-sky-300 font-semibold text-[11px]">
                                {item.warehouse_name}
                              </span>
                            ) : (
                              <span className="text-slate-500 font-normal">غير محدد</span>
                            )}
                          </td>
                          <td className="py-2.5 px-3 font-sans text-slate-300">{item.color || '—'}</td>
                          <td className="py-2.5 px-3 font-sans text-slate-300">{item.size || '—'}</td>
                          <td className="py-2.5 px-3 text-slate-200">{item.quantity}</td>
                          <td className="py-2.5 px-3 text-slate-200">{item.unit_price} ج.م</td>
                          <td className="py-2.5 px-3 font-bold text-amber-400">
                            {item.unit_price * item.quantity} ج.م
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-400 px-1 border-b border-slate-800/60 pb-2">
                  <div className="flex items-center gap-3">
                    <span className="inline-flex items-center gap-1 text-sky-400">
                      <span className="w-1.5 h-1.5 rounded-full bg-sky-400"></span>
                      <strong>اسم وكود المستودع:</strong> موثقان من بيانات الأصناف الأصلية
                    </span>
                    <span>·</span>
                    <span className="inline-flex items-center gap-1 text-amber-400">
                      <span className="w-1.5 h-1.5 rounded-full bg-amber-400"></span>
                      <strong>كود التاجر (Merchant Code):</strong> خاص بالتاجر المعتمد (لا يُشتق من اسم المخزن أو الصنف)
                    </span>
                  </div>
                </div>

                <div className="flex justify-end gap-6 text-xs text-slate-300 pt-1 font-mono">
                  <div>سعر المنتجات: <strong>{order.total_price} ج.م</strong></div>
                  <div>تكلفة الشحن: <strong>{order.shipping_cost} ج.م</strong></div>
                  <div className="text-amber-400 font-bold">إجمالي الأوردر: <strong>{order.total_order} ج.م</strong></div>
                </div>
              </div>

              {/* Status Timeline History */}
              <div className="space-y-3">
                <h4 className="font-bold text-slate-200 flex items-center gap-2">
                  <Calendar className="w-4 h-4 text-sky-400" />
                  <span>خط التغيرات الزمني للحالات (Status Transitions Timeline)</span>
                </h4>

                <div className="p-4 rounded-xl bg-slate-950/60 border border-slate-800 space-y-3">
                  {timeline.length === 0 ? (
                    <div className="text-slate-500 text-center py-4">
                      لا توجد سجلات انتقالات سابقة محفوظة
                    </div>
                  ) : (
                    timeline.map((evt) => (
                      <div key={evt.id} className="flex items-start gap-3 border-b border-slate-800/60 last:border-0 pb-2.5 last:pb-0">
                        <div className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${evt.source_channel === 'poll_detection' ? 'bg-sky-400' : 'bg-amber-400'}`}></div>
                        <div className="flex-1 space-y-0.5">
                          <div className="flex items-center justify-between">
                            <span className="font-semibold text-slate-200">
                              {evt.from_status ? `${evt.from_status} ← ${evt.to_status}` : `الحالة الأولية: ${evt.to_status}`}
                            </span>
                            <span className="font-mono text-slate-500 text-[11px]">
                              {evt.event_time_source || evt.observed_at}
                            </span>
                          </div>
                          <div className="text-[11px] text-slate-400 flex items-center gap-2">
                            <span>المنفذ: {evt.actor_name || 'النظام'}</span>
                            <span>·</span>
                            <span>القناة: {evt.source_channel === 'poll_detection' ? 'كشف المزامنة الدورية (Poll)' : 'سجل أصلي (Source Log)'}</span>
                          </div>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>

              {/* Genuine Vendoor System Logs for this Order */}
              {sourceLogs.length > 0 && (
                <div className="space-y-3">
                  <h4 className="font-bold text-slate-200 flex items-center gap-2">
                    <Clock className="w-4 h-4 text-emerald-400" />
                    <span>سجلات العمليات الرسمية من Vendoor ({sourceLogs.length} حركة مسجلة)</span>
                  </h4>

                  <div className="p-4 rounded-xl bg-slate-950/60 border border-slate-800 space-y-2.5 max-h-60 overflow-y-auto">
                    {sourceLogs.map((log) => (
                      <div key={log.id} className="flex items-start justify-between gap-3 text-xs border-b border-slate-800/50 pb-2 last:border-0">
                        <div className="space-y-0.5">
                          <div className="text-slate-200 font-medium">{log.raw_action_text || log.action_type}</div>
                          <div className="text-[11px] text-slate-400 font-mono">
                            الموظف: <strong className="text-amber-400">{log.actor_name}</strong> · النوع: {log.action_type}
                          </div>
                        </div>
                        <span className="text-[11px] font-mono text-slate-500 whitespace-nowrap">
                          {log.event_timestamp}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-slate-800 bg-slate-950/50 flex justify-end">
          <button
            onClick={onClose}
            className="px-5 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold rounded-lg transition-colors cursor-pointer"
          >
            إغلاق
          </button>
        </div>
      </div>
    </div>
  );
};
