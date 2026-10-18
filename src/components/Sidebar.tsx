import React, { useState } from 'react';
import {
  LayoutDashboard,
  ShoppingBag,
  Users,
  Clock,
  RotateCw,
  Printer,
  ChevronDown,
  ChevronLeft,
  BarChart3,
  ArrowRightLeft,
  FileText,
  ShieldAlert,
  Archive,
  Activity,
  Settings,
} from 'lucide-react';

export type NavTab =
  | 'dashboard'
  | 'orders'
  | 'pending'
  | 'processing'
  | 'printed'
  | 'team'
  | 'reports'
  | 'comparison'
  | 'logs'
  | 'alerts'
  | 'archive'
  | 'sync_health'
  | 'settings';

interface SidebarProps {
  currentTab: NavTab;
  onSelectTab: (tab: NavTab) => void;
  openAlertsCount: number;
  printedCount?: number;
  pendingCount?: number;
  processingCount?: number;
}

export const Sidebar: React.FC<SidebarProps> = ({
  currentTab,
  onSelectTab,
  openAlertsCount = 0,
  printedCount = 0,
  pendingCount = 0,
  processingCount = 0,
}) => {
  const isOrdersActive = ['orders', 'pending', 'processing', 'printed'].includes(currentTab);
  const [ordersExpanded, setOrdersExpanded] = useState<boolean>(true);

  return (
    <aside className="w-64 border-l border-stone-800 bg-stone-900/70 flex flex-col justify-between shrink-0 select-none font-['Cairo',sans-serif]" dir="rtl">
      <div className="p-4 space-y-1.5 overflow-y-auto">
        <div className="px-3 py-1 text-[11px] font-bold tracking-wider text-stone-400 uppercase">
          القوائم التشغيلية والرقابية
        </div>

        {/* 1. Dashboard */}
        <button
          onClick={() => onSelectTab('dashboard')}
          className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs font-medium transition-all cursor-pointer ${
            currentTab === 'dashboard'
              ? 'bg-amber-500/15 text-amber-300 font-bold border border-amber-500/25 shadow-sm'
              : 'text-stone-300 hover:text-stone-100 hover:bg-stone-800/60'
          }`}
        >
          <div className="flex items-center gap-2.5">
            <LayoutDashboard className={`w-4 h-4 ${currentTab === 'dashboard' ? 'text-amber-400' : 'text-stone-400'}`} />
            <span>لوحة التحكم (Dashboard)</span>
          </div>
        </button>

        {/* 2. Orders (with Pending, Processing, Printed nested) */}
        <div className="space-y-0.5">
          <button
            onClick={() => {
              if (!isOrdersActive) {
                onSelectTab('orders');
              }
              setOrdersExpanded(!ordersExpanded);
            }}
            className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs font-medium transition-all cursor-pointer ${
              isOrdersActive
                ? 'bg-stone-800/80 text-stone-100 border border-stone-700/60'
                : 'text-stone-300 hover:text-stone-100 hover:bg-stone-800/60'
            }`}
          >
            <div className="flex items-center gap-2.5">
              <ShoppingBag className={`w-4 h-4 ${isOrdersActive ? 'text-amber-400' : 'text-stone-400'}`} />
              <span className="font-semibold">إدارة الطلبات (Orders)</span>
            </div>
            {ordersExpanded ? (
              <ChevronDown className="w-3.5 h-3.5 text-stone-400" />
            ) : (
              <ChevronLeft className="w-3.5 h-3.5 text-stone-400" />
            )}
          </button>

          {/* Sub-items under Orders */}
          {ordersExpanded && (
            <div className="pr-4 mr-2 border-r border-stone-800 space-y-0.5 pt-0.5">
              <button
                onClick={() => onSelectTab('orders')}
                className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-md text-[11px] font-medium transition-all cursor-pointer ${
                  currentTab === 'orders'
                    ? 'bg-amber-500/15 text-amber-300 font-bold'
                    : 'text-stone-400 hover:text-stone-200 hover:bg-stone-800/40'
                }`}
              >
                <span>كافة الطلبات (All)</span>
              </button>

              <button
                onClick={() => onSelectTab('pending')}
                className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-md text-[11px] font-medium transition-all cursor-pointer ${
                  currentTab === 'pending'
                    ? 'bg-amber-500/15 text-amber-300 font-bold'
                    : 'text-stone-400 hover:text-stone-200 hover:bg-stone-800/40'
                }`}
              >
                <div className="flex items-center gap-2">
                  <Clock className="w-3 h-3 text-amber-400" />
                  <span>المعلقة (Pending)</span>
                </div>
                {pendingCount > 0 && (
                  <span className="text-[10px] px-1.5 py-0.2 rounded bg-amber-500/20 text-amber-300 font-mono">
                    {pendingCount}
                  </span>
                )}
              </button>

              <button
                onClick={() => onSelectTab('processing')}
                className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-md text-[11px] font-medium transition-all cursor-pointer ${
                  currentTab === 'processing'
                    ? 'bg-sky-500/15 text-sky-300 font-bold'
                    : 'text-stone-400 hover:text-stone-200 hover:bg-stone-800/40'
                }`}
              >
                <div className="flex items-center gap-2">
                  <RotateCw className="w-3 h-3 text-sky-400" />
                  <span>قيد التنفيذ (Processing)</span>
                </div>
                {processingCount > 0 && (
                  <span className="text-[10px] px-1.5 py-0.2 rounded bg-sky-500/20 text-sky-300 font-mono">
                    {processingCount}
                  </span>
                )}
              </button>

              <button
                onClick={() => onSelectTab('printed')}
                className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-md text-[11px] font-medium transition-all cursor-pointer ${
                  currentTab === 'printed'
                    ? 'bg-emerald-500/15 text-emerald-300 font-bold'
                    : 'text-stone-400 hover:text-stone-200 hover:bg-stone-800/40'
                }`}
              >
                <div className="flex items-center gap-2">
                  <Printer className="w-3 h-3 text-emerald-400" />
                  <span>المطبوعة (Printed)</span>
                </div>
                {printedCount > 0 && (
                  <span className="text-[10px] px-1.5 py-0.2 rounded bg-emerald-500/20 text-emerald-300 font-mono">
                    {printedCount}
                  </span>
                )}
              </button>
            </div>
          )}
        </div>

        {/* 3. Team */}
        <button
          onClick={() => onSelectTab('team')}
          className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs font-medium transition-all cursor-pointer ${
            currentTab === 'team'
              ? 'bg-amber-500/15 text-amber-300 font-bold border border-amber-500/25 shadow-sm'
              : 'text-stone-300 hover:text-stone-100 hover:bg-stone-800/60'
          }`}
        >
          <div className="flex items-center gap-2.5">
            <Users className={`w-4 h-4 ${currentTab === 'team' ? 'text-amber-400' : 'text-stone-400'}`} />
            <span>أداء الفريق (Team)</span>
          </div>
        </button>

        {/* 4. Reports */}
        <button
          onClick={() => onSelectTab('reports')}
          className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs font-medium transition-all cursor-pointer ${
            currentTab === 'reports'
              ? 'bg-amber-500/15 text-amber-300 font-bold border border-amber-500/25 shadow-sm'
              : 'text-stone-300 hover:text-stone-100 hover:bg-stone-800/60'
          }`}
        >
          <div className="flex items-center gap-2.5">
            <BarChart3 className={`w-4 h-4 ${currentTab === 'reports' ? 'text-amber-400' : 'text-stone-400'}`} />
            <span>التقارير المتقدمة (Reports)</span>
          </div>
        </button>

        {/* 5. Period Comparison */}
        <button
          onClick={() => onSelectTab('comparison')}
          className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs font-medium transition-all cursor-pointer ${
            currentTab === 'comparison'
              ? 'bg-amber-500/15 text-amber-300 font-bold border border-amber-500/25 shadow-sm'
              : 'text-stone-300 hover:text-stone-100 hover:bg-stone-800/60'
          }`}
        >
          <div className="flex items-center gap-2.5">
            <ArrowRightLeft className={`w-4 h-4 ${currentTab === 'comparison' ? 'text-amber-400' : 'text-stone-400'}`} />
            <span>مقارنة الفترات (Comparison)</span>
          </div>
        </button>

        {/* 6. Logs */}
        <button
          onClick={() => onSelectTab('logs')}
          className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs font-medium transition-all cursor-pointer ${
            currentTab === 'logs'
              ? 'bg-amber-500/15 text-amber-300 font-bold border border-amber-500/25 shadow-sm'
              : 'text-stone-300 hover:text-stone-100 hover:bg-stone-800/60'
          }`}
        >
          <div className="flex items-center gap-2.5">
            <FileText className={`w-4 h-4 ${currentTab === 'logs' ? 'text-amber-400' : 'text-stone-400'}`} />
            <span>سجل العمليات (Audit Logs)</span>
          </div>
        </button>

        {/* 8. Historical Archive */}
        <button
          onClick={() => onSelectTab('archive')}
          className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs font-medium transition-all cursor-pointer ${
            currentTab === 'archive'
              ? 'bg-amber-500/15 text-amber-300 font-bold border border-amber-500/25 shadow-sm'
              : 'text-stone-300 hover:text-stone-100 hover:bg-stone-800/60'
          }`}
        >
          <div className="flex items-center gap-2.5">
            <Archive className={`w-4 h-4 ${currentTab === 'archive' ? 'text-amber-400' : 'text-stone-400'}`} />
            <span>الأرشيف التاريخي (Archive)</span>
          </div>
        </button>

        {/* 9. Settings */}
        <button
          onClick={() => onSelectTab('settings')}
          className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs font-medium transition-all cursor-pointer ${
            currentTab === 'settings'
              ? 'bg-amber-500/15 text-amber-300 font-bold border border-amber-500/25 shadow-sm'
              : 'text-stone-300 hover:text-stone-100 hover:bg-stone-800/60'
          }`}
        >
          <div className="flex items-center gap-2.5">
            <Settings className={`w-4 h-4 ${currentTab === 'settings' ? 'text-amber-400' : 'text-stone-400'}`} />
            <span>الإعدادات والربط (Settings)</span>
          </div>
        </button>
      </div>

      {/* Account Info Footer */}
      <div className="p-3.5 border-t border-stone-800 bg-stone-950/60 text-[11px] text-stone-400 space-y-1">
        <div className="flex items-center justify-between">
          <span className="text-stone-500">حساب المراقبة:</span>
          <span className="font-mono text-stone-300 font-medium truncate max-w-[120px]">Ziad@vendoor.com</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-stone-500">المنطقة الزمنية:</span>
          <span className="text-stone-300">Africa/Cairo</span>
        </div>
        <div className="flex items-center justify-between pt-0.5">
          <span className="text-stone-500">وضع الوصول:</span>
          <span className="text-emerald-400 font-medium">قراءة وتحقق فقط</span>
        </div>
      </div>
    </aside>
  );
};
