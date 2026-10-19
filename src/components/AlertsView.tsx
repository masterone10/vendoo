import React, { useState, useEffect } from 'react';
import { ShieldAlert, AlertTriangle, CheckCircle, Clock, Eye, MessageSquare, Check, X } from 'lucide-react';
import { Alert } from '../types';

interface AlertsViewProps {
  onSelectOrder: (orderCode: string) => void;
}

export const AlertsView: React.FC<AlertsViewProps> = ({ onSelectOrder }) => {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState<'all' | 'OPEN' | 'IN_REVIEW' | 'RESOLVED'>('OPEN');
  const [selectedAlertForAction, setSelectedAlertForAction] = useState<Alert | null>(null);
  const [actionNotes, setActionNotes] = useState('');
  const [actionStatus, setActionStatus] = useState<'IN_REVIEW' | 'RESOLVED'>('RESOLVED');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetchAlerts();
  }, [statusFilter]);

  async function fetchAlerts() {
    setLoading(true);
    try {
      const url = statusFilter === 'all' ? '/api/alerts' : `/api/alerts?status=${statusFilter}`;
      const res = await fetch(url);
      const data = await res.json();
      setAlerts(data.alerts || []);
    } catch (err) {
      console.error('Error fetching alerts:', err);
    } finally {
      setLoading(false);
    }
  }

  async function handleUpdateAlertStatus() {
    if (!selectedAlertForAction) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/alerts/${selectedAlertForAction.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: actionStatus,
          notes: actionNotes,
          resolvedBy: 'مشرف العمليات',
        }),
      });

      if (res.ok) {
        setSelectedAlertForAction(null);
        setActionNotes('');
        fetchAlerts();
      }
    } catch (err) {
      console.error('Error updating alert status:', err);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      {/* Header & Status Filter */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-800 pb-4">
        <div>
          <h2 className="text-xl font-bold text-slate-100 flex items-center gap-2">
            <ShieldAlert className="w-5 h-5 text-rose-400" />
            <span>مركز التنبيهات الحرجة (تعدد أكواد المخازن)</span>
            <span className="text-xs font-mono font-semibold px-2 py-0.5 rounded bg-rose-500/10 border border-rose-500/20 text-rose-400">
              {alerts.length} تنبيه
            </span>
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            كشف فوري للطلبات التي دخلت حالة التأكيد (Printed) وتحتوي على منتجات تابعة لأكثر من كود مخزن مستقل
          </p>
        </div>

        {/* Filter Tabs */}
        <div className="flex items-center gap-1.5 p-1 bg-slate-900 border border-slate-800 rounded-lg text-xs font-medium">
          <button
            onClick={() => setStatusFilter('OPEN')}
            className={`px-3 py-1.5 rounded-md transition-all cursor-pointer ${
              statusFilter === 'OPEN'
                ? 'bg-rose-500/20 text-rose-300 border border-rose-500/30 shadow-sm font-semibold'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            المفتوحة (Open)
          </button>
          <button
            onClick={() => setStatusFilter('IN_REVIEW')}
            className={`px-3 py-1.5 rounded-md transition-all cursor-pointer ${
              statusFilter === 'IN_REVIEW'
                ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30 shadow-sm font-semibold'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            قيد المراجعة (In Review)
          </button>
          <button
            onClick={() => setStatusFilter('RESOLVED')}
            className={`px-3 py-1.5 rounded-md transition-all cursor-pointer ${
              statusFilter === 'RESOLVED'
                ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 shadow-sm font-semibold'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            المحلولة (Resolved)
          </button>
          <button
            onClick={() => setStatusFilter('all')}
            className={`px-3 py-1.5 rounded-md transition-all cursor-pointer ${
              statusFilter === 'all'
                ? 'bg-slate-800 text-slate-100 shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            الكل
          </button>
        </div>
      </div>

      {/* Alerts Grid */}
      {loading ? (
        <div className="py-16 text-center text-slate-500">
          جاري تحميل التنبيهات...
        </div>
      ) : alerts.length === 0 ? (
        <div className="py-16 text-center text-slate-400 bg-slate-900/40 rounded-xl border border-slate-800 space-y-2">
          <CheckCircle className="w-8 h-8 text-emerald-400 mx-auto" />
          <div className="font-semibold text-slate-200">لا توجد تنبيهات حرجة في هذه القائمة</div>
          <div className="text-xs text-slate-500">
            جميع الطلبات المؤكدة ملتزمة بكود مخزن واحد أو تم حسم مراجعتها.
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {alerts.map((alert) => {
            let details: any = null;
            try {
              if (alert.details_json) details = JSON.parse(alert.details_json);
            } catch (e) {
              // ignore
            }

            const isOpen = alert.status === 'OPEN';
            const isInReview = alert.status === 'IN_REVIEW';
            const isResolved = alert.status === 'RESOLVED';

            return (
              <div
                key={alert.id}
                className={`p-5 rounded-xl border transition-all ${
                  isOpen
                    ? 'bg-slate-900/90 border-rose-500/30 hover:border-rose-500/50 shadow-md shadow-rose-950/20'
                    : isInReview
                    ? 'bg-slate-900/80 border-amber-500/30'
                    : 'bg-slate-900/50 border-slate-800 opacity-80'
                }`}
              >
                <div className="flex flex-col md:flex-row md:items-start justify-between gap-4">
                  {/* Left Column: Details */}
                  <div className="space-y-2.5 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        onClick={() => onSelectOrder(alert.random_number)}
                        className="font-mono text-base font-bold text-amber-400 hover:underline cursor-pointer"
                      >
                        {alert.random_number}
                      </button>

                      <span className="text-slate-600">·</span>

                      <span
                        className={`text-xs font-semibold px-2 py-0.5 rounded border ${
                          isOpen
                            ? 'bg-rose-500/10 border-rose-500/30 text-rose-400'
                            : isInReview
                            ? 'bg-amber-500/10 border-amber-500/30 text-amber-400'
                            : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                        }`}
                      >
                        {isOpen ? 'مفتوح (بحاجة لاتخاذ إجراء)' : isInReview ? 'قيد المراجعة' : 'تم الحل'}
                      </span>

                      {alert.is_pre_existing === 1 && (
                        <span className="text-[11px] text-slate-500 bg-slate-800/80 px-2 py-0.5 rounded border border-slate-700">
                          مكتشف أثناء التهيئة
                        </span>
                      )}

                      <span className="text-slate-600">·</span>
                      <span className="text-xs text-slate-400 font-mono">
                        رُصد في: {new Date(alert.created_at).toLocaleString('ar-EG')}
                      </span>
                    </div>

                    <h4 className="text-sm font-bold text-slate-100">{alert.title}</h4>
                    <p className="text-xs text-slate-300 leading-relaxed">{alert.description}</p>

                    {/* Products & Merchant Codes Breakdown */}
                    {details?.products && (
                      <div className="mt-3 p-3 rounded-lg bg-slate-950/60 border border-slate-800/80 space-y-2">
                        <div className="text-[11px] font-semibold text-slate-400">
                          أصناف الطلب وتوزيع المخازن:
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                          {details.products.map((p: any, idx: number) => {
                            const whName = details.warehouses?.[idx] || details.warehouseNames?.[idx] || details.merchantCodes?.[idx] || 'مخزن';
                            return (
                              <div
                                key={idx}
                                className="p-2 rounded bg-slate-900 border border-slate-800 flex items-center justify-between"
                              >
                                <span className="text-slate-200 truncate">{p.name}</span>
                                <span className="text-sky-400 font-mono font-bold shrink-0 ml-2 text-xs">
                                  {whName}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {/* Resolution Notes if any */}
                    {alert.resolution_notes && (
                      <div className="text-xs text-emerald-400/90 bg-emerald-500/10 p-2.5 rounded-lg border border-emerald-500/20">
                        <span className="font-bold">ملاحظات المعالجة:</span> {alert.resolution_notes}
                        {alert.resolved_by && (
                          <span className="text-slate-400 mr-2 font-mono">({alert.resolved_by})</span>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Right Column: Actions */}
                  <div className="flex flex-col sm:flex-row md:flex-col gap-2 shrink-0">
                    <button
                      onClick={() => onSelectOrder(alert.random_number)}
                      className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium rounded-lg flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
                    >
                      <Eye className="w-3.5 h-3.5" />
                      <span>تفاصيل الطلب</span>
                    </button>

                    {!isResolved && (
                      <button
                        onClick={() => {
                          setSelectedAlertForAction(alert);
                          setActionStatus(isOpen ? 'IN_REVIEW' : 'RESOLVED');
                          setActionNotes(alert.resolution_notes || '');
                        }}
                        className="px-3 py-1.5 bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-bold rounded-lg flex items-center justify-center gap-1.5 transition-colors cursor-pointer shadow-sm"
                      >
                        <MessageSquare className="w-3.5 h-3.5" />
                        <span>تحديث الحالة / حل</span>
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Action Dialog Modal */}
      {selectedAlertForAction && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-lg shadow-2xl p-6 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="font-bold text-slate-100 flex items-center gap-2">
                <span>تحديث حالة التنبيه ({selectedAlertForAction.random_number})</span>
              </h3>
              <button
                onClick={() => setSelectedAlertForAction(null)}
                className="p-1 text-slate-400 hover:text-slate-100 rounded-lg hover:bg-slate-800 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-3 text-xs">
              <div>
                <label className="block text-slate-400 mb-1.5 font-medium">الحالة الجديدة:</label>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setActionStatus('IN_REVIEW')}
                    className={`flex-1 py-2 rounded-lg font-medium border transition-colors cursor-pointer ${
                      actionStatus === 'IN_REVIEW'
                        ? 'bg-amber-500/20 border-amber-500 text-amber-300 font-bold'
                        : 'bg-slate-950 border-slate-800 text-slate-400'
                    }`}
                  >
                    قيد المراجعة (In Review)
                  </button>
                  <button
                    type="button"
                    onClick={() => setActionStatus('RESOLVED')}
                    className={`flex-1 py-2 rounded-lg font-medium border transition-colors cursor-pointer ${
                      actionStatus === 'RESOLVED'
                        ? 'bg-emerald-500/20 border-emerald-500 text-emerald-300 font-bold'
                        : 'bg-slate-950 border-slate-800 text-slate-400'
                    }`}
                  >
                    تم الحل (Resolved)
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-slate-400 mb-1.5 font-medium">ملاحظات المعالجة والإجراء المتخذ:</label>
                <textarea
                  rows={3}
                  value={actionNotes}
                  onChange={(e) => setActionNotes(e.target.value)}
                  placeholder="مثال: تم التواصل مع المخزن وتنسيق البوليصة في فيندور..."
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg p-3 text-slate-200 placeholder-slate-500 focus:outline-none focus:border-amber-500/50"
                />
              </div>

              <div className="text-[11px] text-slate-500">
                * ملاحظة: تحديث التنبيه محلي للمراقبة، ولا يُعدل بيانات Vendoor حفاظًا على وضع القراءة والتحقق.
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-800">
              <button
                type="button"
                onClick={() => setSelectedAlertForAction(null)}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium rounded-lg cursor-pointer"
              >
                إلغاء
              </button>
              <button
                type="button"
                onClick={handleUpdateAlertStatus}
                disabled={submitting}
                className="px-5 py-2 bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-slate-950 text-xs font-bold rounded-lg cursor-pointer transition-colors"
              >
                {submitting ? 'جاري الحفظ...' : 'حفظ التحديث'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
