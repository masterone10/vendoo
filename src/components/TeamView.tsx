import React, { useState, useEffect } from 'react';
import { Users, Clock, CheckCircle2, RotateCw, XCircle, ChevronLeft, Calendar, Info, X } from 'lucide-react';
import { TeamMember } from '../types';

interface TeamViewProps {
  selectedDate?: string;
  onSelectOrder: (orderCode: string) => void;
}

export type TeamPeriodType = 'today' | 'yesterday' | 'all' | 'custom';

export const TeamView: React.FC<TeamViewProps> = ({ selectedDate, onSelectOrder }) => {
  const [period, setPeriod] = useState<TeamPeriodType>(selectedDate ? 'custom' : 'today');
  const [customDate, setCustomDate] = useState<string>(selectedDate || '');
  const [team, setTeam] = useState<TeamMember[]>([]);
  const [totalActions, setTotalActions] = useState(0);
  const [totalUniqueOrders, setTotalUniqueOrders] = useState(0);
  const [dateFilterLabel, setDateFilterLabel] = useState('');
  const [loading, setLoading] = useState(false);
  const [selectedMember, setSelectedMember] = useState<string | null>(null);
  const [memberEvents, setMemberEvents] = useState<any[]>([]);
  const [eventsLoading, setEventsLoading] = useState(false);

  useEffect(() => {
    if (selectedDate) {
      setCustomDate(selectedDate);
      setPeriod('custom');
    }
  }, [selectedDate]);

  useEffect(() => {
    fetchTeamData();
  }, [period, customDate]);

  async function fetchTeamData() {
    setLoading(true);
    try {
      let url = '/api/team';
      if (period === 'today') {
        url = '/api/team?period=today';
      } else if (period === 'yesterday') {
        url = '/api/team?period=yesterday';
      } else if (period === 'all') {
        url = '/api/team?period=all';
      } else if (period === 'custom') {
        if (customDate) {
          url = `/api/team?date=${encodeURIComponent(customDate)}`;
        } else {
          url = '/api/team?period=today';
        }
      }
      const res = await fetch(url);
      const data = await res.json();
      setTeam(data.team || []);
      setTotalActions(data.totalActions || 0);
      setTotalUniqueOrders(data.totalUniqueOrders || 0);
      setDateFilterLabel(data.dateFilter || customDate || '');
    } catch (err) {
      console.error('Error fetching team stats:', err);
    } finally {
      setLoading(false);
    }
  }

  async function handleSelectMember(name: string) {
    setSelectedMember(name);
    setEventsLoading(true);
    try {
      let url = `/api/team/${encodeURIComponent(name)}/events`;
      if (period === 'today') {
        url += '?period=today';
      } else if (period === 'yesterday') {
        url += '?period=yesterday';
      } else if (period === 'all') {
        url += '?period=all';
      } else if (period === 'custom' && customDate) {
        url += `?date=${encodeURIComponent(customDate)}`;
      }
      const res = await fetch(url);
      const data = await res.json();
      setMemberEvents(data.events || []);
    } catch (err) {
      console.error('Error fetching member events:', err);
    } finally {
      setEventsLoading(false);
    }
  }

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      {/* Header & Period Filters */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-800 pb-4">
        <div>
          <h2 className="text-xl font-bold text-slate-100 flex items-center gap-2 flex-wrap">
            <Users className="w-5 h-5 text-amber-400" />
            <span>أداء ونشاط الفريق التشغيلي (Team Performance)</span>
            <span className="text-xs font-mono text-amber-400 px-2 py-0.5 rounded bg-amber-500/10 border border-amber-500/20">
              {totalActions} عملية مؤكدة
            </span>
            <span className="text-xs font-mono text-sky-400 px-2 py-0.5 rounded bg-sky-500/10 border border-sky-500/20">
              {totalUniqueOrders} طلب فريد
            </span>
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            مبني حصريًا على سجل العمليات الفعلي (Logs) دون تخمين، لحساب العمليات والطلبات الفريدة بدقة لأي نطاق تاريخي
          </p>
        </div>

        {/* Period Selector */}
        <div className="flex items-center gap-1.5 flex-wrap p-1 bg-slate-900 border border-slate-800 rounded-lg text-xs font-medium">
          <button
            onClick={() => setPeriod('today')}
            className={`px-3 py-1.5 rounded-md transition-all cursor-pointer ${
              period === 'today'
                ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30 shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            اليوم (Cairo)
          </button>
          <button
            onClick={() => setPeriod('yesterday')}
            className={`px-3 py-1.5 rounded-md transition-all cursor-pointer ${
              period === 'yesterday'
                ? 'bg-slate-800 text-slate-100 shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            أمس
          </button>
          <button
            onClick={() => setPeriod('all')}
            className={`px-3 py-1.5 rounded-md transition-all cursor-pointer ${
              period === 'all'
                ? 'bg-slate-800 text-slate-100 shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            كل الفترات
          </button>
          <button
            onClick={() => setPeriod('custom')}
            className={`px-3 py-1.5 rounded-md transition-all cursor-pointer ${
              period === 'custom'
                ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30 shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            تاريخ محدد
          </button>
          {period === 'custom' && (
            <input
              type="date"
              value={customDate}
              onChange={(e) => setCustomDate(e.target.value)}
              className="px-2 py-1 bg-slate-950 border border-slate-700 rounded text-slate-200 text-xs focus:outline-none focus:border-amber-400"
            />
          )}
        </div>
      </div>

      {/* Audit Explainer Note */}
      <div className="p-3.5 rounded-lg bg-slate-900/80 border border-slate-800 text-xs text-slate-400 flex items-start gap-2.5">
        <Info className="w-4 h-4 text-sky-400 shrink-0 mt-0.5" />
        <div className="leading-relaxed">
          <span className="text-slate-200 font-semibold">تنويه منهجي:</span> النسبة المئوية بجوار كل حالة تمثل حصة تلك الحالة من إجمالي عمليات الموظف في الفترة المحددة، وليست نسبة نجاح أو تسليم. العمليات تشمل فقط الأحداث الفريدة الموثقة بعد إزالة التكرار من سجلات النظام.
        </div>
      </div>

      {/* Employee Cards Grid */}
      {loading ? (
        <div className="py-16 text-center text-slate-500">
          جاري تحليل سجلات النشاط...
        </div>
      ) : team.length === 0 ? (
        <div className="py-16 text-center text-slate-500 bg-slate-900/40 rounded-xl border border-slate-800">
          لا توجد عمليات مسجلة للموظفين خلال الفترة المختارة
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {team.map((member) => {
            const printedPct = member.actions > 0 ? Math.round((member.printed / member.actions) * 100) : 0;
            const pendingPct = member.actions > 0 ? Math.round((member.pending / member.actions) * 100) : 0;
            const processingPct = member.actions > 0 ? Math.round((member.processing / member.actions) * 100) : 0;
            const cancelPct = member.actions > 0 ? Math.round((member.cancel / member.actions) * 100) : 0;

            return (
              <div
                key={member.name}
                onClick={() => handleSelectMember(member.name)}
                className="p-5 rounded-xl bg-slate-900 border border-slate-800 hover:border-amber-500/30 hover:bg-slate-800/60 transition-all cursor-pointer group space-y-4 shadow-sm"
              >
                {/* Header */}
                <div className="flex items-center justify-between border-b border-slate-800/80 pb-3">
                  <div>
                    <h3 className="font-bold text-slate-100 group-hover:text-amber-400 transition-colors">
                      {member.name}
                    </h3>
                    <div className="text-[11px] text-slate-500 mt-0.5">موظف عمليات / خدمة عملاء</div>
                  </div>
                  <div className="text-left flex items-center gap-3">
                    <div className="text-center">
                      <div className="text-[10px] text-slate-400">ORDERS</div>
                      <div className="text-base font-bold font-mono text-sky-400">
                        {member.uniqueOrders ?? 0}
                      </div>
                    </div>
                    <div className="text-center pl-1 border-r border-slate-800">
                      <div className="text-[10px] text-slate-400">ACTIONS</div>
                      <div className="text-xl font-bold font-mono text-amber-400">
                        {member.actions}
                      </div>
                    </div>
                  </div>
                </div>

                {/* State Transitions Breakdown */}
                <div className="grid grid-cols-2 gap-2 text-xs">
                  {/* Printed */}
                  <div className="p-2.5 rounded-lg bg-slate-950/60 border border-slate-800 flex items-center justify-between">
                    <div>
                      <div className="text-[11px] text-slate-400">PRINTED</div>
                      <div className="font-mono font-bold text-emerald-400 text-sm mt-0.5">
                        {member.printed}
                      </div>
                    </div>
                    <span className="text-[11px] font-mono text-slate-500">
                      {printedPct}%
                    </span>
                  </div>

                  {/* Pending */}
                  <div className="p-2.5 rounded-lg bg-slate-950/60 border border-slate-800 flex items-center justify-between">
                    <div>
                      <div className="text-[11px] text-slate-400">PENDING</div>
                      <div className="font-mono font-bold text-amber-400 text-sm mt-0.5">
                        {member.pending}
                      </div>
                    </div>
                    <span className="text-[11px] font-mono text-slate-500">
                      {pendingPct}%
                    </span>
                  </div>

                  {/* Processing */}
                  <div className="p-2.5 rounded-lg bg-slate-950/60 border border-slate-800 flex items-center justify-between">
                    <div>
                      <div className="text-[11px] text-slate-400">PROCESSING</div>
                      <div className="font-mono font-bold text-sky-400 text-sm mt-0.5">
                        {member.processing}
                      </div>
                    </div>
                    <span className="text-[11px] font-mono text-slate-500">
                      {processingPct}%
                    </span>
                  </div>

                  {/* Cancel */}
                  <div className="p-2.5 rounded-lg bg-slate-950/60 border border-slate-800 flex items-center justify-between">
                    <div>
                      <div className="text-[11px] text-slate-400">CANCEL</div>
                      <div className="font-mono font-bold text-rose-400 text-sm mt-0.5">
                        {member.cancel}
                      </div>
                    </div>
                    <span className="text-[11px] font-mono text-slate-500">
                      {cancelPct}%
                    </span>
                  </div>
                </div>

                <div className="flex items-center justify-between text-[11px] text-slate-500 pt-1">
                  <span>عمليات أخرى: {member.other}</span>
                  <span className="text-amber-400 flex items-center gap-1 group-hover:-translate-x-1 transition-transform">
                    <span>عرض السجل المفصل</span>
                    <ChevronLeft className="w-3.5 h-3.5" />
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Member Drill-down Modal */}
      {selectedMember && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-3xl max-h-[85vh] flex flex-col shadow-2xl">
            {/* Modal Header */}
            <div className="p-5 border-b border-slate-800 flex items-center justify-between">
              <div>
                <h3 className="text-base font-bold text-slate-100 flex items-center gap-2">
                  <span>سجل عمليات: {selectedMember}</span>
                  <span className="text-xs font-normal text-slate-400 font-mono">
                    ({memberEvents.length} حدث)
                  </span>
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  التسلسل الزمني الدقيق للعمليات المنفذة من واقع السجلات
                </p>
              </div>
              <button
                onClick={() => setSelectedMember(null)}
                className="p-1.5 text-slate-400 hover:text-slate-100 rounded-lg hover:bg-slate-800 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-5 overflow-y-auto space-y-3 flex-1 text-xs">
              {eventsLoading ? (
                <div className="py-12 text-center text-slate-500">
                  جاري تحميل الأحداث...
                </div>
              ) : memberEvents.length === 0 ? (
                <div className="py-12 text-center text-slate-500">
                  لا توجد أحداث مفصلة محفوظة لهذا الموظف
                </div>
              ) : (
                <div className="divide-y divide-slate-800/60 border border-slate-800 rounded-xl overflow-hidden bg-slate-950/40">
                  {memberEvents.map((evt) => (
                    <div key={evt.id} className="p-3.5 hover:bg-slate-800/30 flex items-start justify-between gap-4">
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          {evt.order_code ? (
                            <button
                              onClick={() => {
                                setSelectedMember(null);
                                onSelectOrder(evt.order_code);
                              }}
                              className="font-mono font-bold text-amber-400 hover:underline cursor-pointer"
                            >
                              {evt.order_code}
                            </button>
                          ) : (
                            <span className="text-slate-500 font-mono">عملية عامة</span>
                          )}
                          <span className="text-slate-600">·</span>
                          <span className="text-slate-300 font-medium">{evt.raw_action_text}</span>
                        </div>

                        {evt.from_status && evt.to_status && (
                          <div className="text-[11px] text-slate-400 flex items-center gap-1.5 font-mono">
                            <span>انتقال:</span>
                            <span className="text-slate-300">{evt.from_status}</span>
                            <span>←</span>
                            <span className="text-emerald-400 font-bold">{evt.to_status}</span>
                          </div>
                        )}
                      </div>

                      <div className="text-right text-[11px] font-mono text-slate-500 whitespace-nowrap">
                        {evt.event_timestamp}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Modal Footer */}
            <div className="p-4 border-t border-slate-800 flex justify-end">
              <button
                onClick={() => setSelectedMember(null)}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium rounded-lg cursor-pointer"
              >
                إغلاق
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
