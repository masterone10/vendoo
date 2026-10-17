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
} from 'lucide-react';

export type NavTab =
  | 'dashboard'
  | 'orders'
  | 'pending'
  | 'processing'
  | 'printed'
  | 'team'
  | 'alerts'
  | 'sync_health';

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
  printedCount = 0,
  pendingCount = 0,
  processingCount = 0,
}) => {
  const isOrdersActive = ['orders', 'pending', 'processing', 'printed'].includes(currentTab);
  const [ordersExpanded, setOrdersExpanded] = useState<boolean>(true);

  return (
    <aside className="w-64 border-l border-slate-800 bg-slate-900/60 flex flex-col justify-between shrink-0 select-none">
      <div className="p-4 space-y-2">
        <div className="px-3 py-1.5 text-[11px] font-semibold tracking-wider text-slate-500 uppercase">
          القوائم التشغيلية
        </div>

        {/* 1. Dashboard */}
        <button
          onClick={() => onSelectTab('dashboard')}
          className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-sm font-medium transition-all ${
            currentTab === 'dashboard'
              ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20 shadow-sm'
              : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
          }`}
        >
          <div className="flex items-center gap-3">
            <LayoutDashboard className={`w-4 h-4 ${currentTab === 'dashboard' ? 'text-amber-400' : 'text-slate-400'}`} />
            <span>لوحة التحكم (Dashboard)</span>
          </div>
        </button>

        {/* 2. Orders (with Pending, Processing, etc. nested under it) */}
        <div className="space-y-1">
          <button
            onClick={() => {
              if (!isOrdersActive) {
                onSelectTab('orders');
              }
              setOrdersExpanded(!ordersExpanded);
            }}
            className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-sm font-medium transition-all ${
              isOrdersActive
                ? 'bg-slate-800/70 text-slate-100 border border-slate-700/50'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
            }`}
          >
            <div className="flex items-center gap-3">
              <ShoppingBag className={`w-4 h-4 ${isOrdersActive ? 'text-amber-400' : 'text-slate-400'}`} />
              <span className="font-semibold">إدارة الطلبات (Orders)</span>
            </div>
            {ordersExpanded ? (
              <ChevronDown className="w-4 h-4 text-slate-400" />
            ) : (
              <ChevronLeft className="w-4 h-4 text-slate-400" />
            )}
          </button>

          {/* Sub-items under Orders */}
          {ordersExpanded && (
            <div className="pr-4 mr-2 border-r-2 border-slate-800 space-y-1 pt-1">
              {/* All Orders */}
              <button
                onClick={() => onSelectTab('orders')}
                className={`w-full flex items-center justify-between px-3 py-2 rounded-md text-xs font-medium transition-all ${
                  currentTab === 'orders'
                    ? 'bg-amber-500/15 text-amber-300 font-bold'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/40'
                }`}
              >
                <span>كافة الطلبات (All)</span>
              </button>

              {/* Pending */}
              <button
                onClick={() => onSelectTab('pending')}
                className={`w-full flex items-center justify-between px-3 py-2 rounded-md text-xs font-medium transition-all ${
                  currentTab === 'pending'
                    ? 'bg-amber-500/15 text-amber-300 font-bold'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/40'
                }`}
              >
                <div className="flex items-center gap-2">
                  <Clock className="w-3.5 h-3.5 text-amber-400" />
                  <span>المعلقة (Pending)</span>
                </div>
                {pendingCount > 0 && (
                  <span className="text-[11px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 font-mono">
                    {pendingCount}
                  </span>
                )}
              </button>

              {/* Processing */}
              <button
                onClick={() => onSelectTab('processing')}
                className={`w-full flex items-center justify-between px-3 py-2 rounded-md text-xs font-medium transition-all ${
                  currentTab === 'processing'
                    ? 'bg-sky-500/15 text-sky-300 font-bold'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/40'
                }`}
              >
                <div className="flex items-center gap-2">
                  <RotateCw className="w-3.5 h-3.5 text-sky-400" />
                  <span>قيد التنفيذ (Processing)</span>
                </div>
                {processingCount > 0 && (
                  <span className="text-[11px] px-1.5 py-0.5 rounded bg-sky-500/20 text-sky-400 font-mono">
                    {processingCount}
                  </span>
                )}
              </button>

              {/* Printed */}
              <button
                onClick={() => onSelectTab('printed')}
                className={`w-full flex items-center justify-between px-3 py-2 rounded-md text-xs font-medium transition-all ${
                  currentTab === 'printed'
                    ? 'bg-emerald-500/15 text-emerald-300 font-bold'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/40'
                }`}
              >
                <div className="flex items-center gap-2">
                  <Printer className="w-3.5 h-3.5 text-emerald-400" />
                  <span>المطبوعة (Printed)</span>
                </div>
                {printedCount > 0 && (
                  <span className="text-[11px] px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-400 font-mono">
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
          className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-sm font-medium transition-all ${
            currentTab === 'team'
              ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20 shadow-sm'
              : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
          }`}
        >
          <div className="flex items-center gap-3">
            <Users className={`w-4 h-4 ${currentTab === 'team' ? 'text-amber-400' : 'text-slate-400'}`} />
            <span>أداء الفريق (Team)</span>
          </div>
        </button>
      </div>

      {/* Account Info Footer */}
      <div className="p-4 border-t border-slate-800 bg-slate-950/40 text-xs text-slate-400 space-y-1">
        <div className="flex items-center justify-between">
          <span className="text-slate-500">حساب المراقبة:</span>
          <span className="font-mono text-slate-300 font-medium">Ziad@vendoor.com</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-slate-500">المنطقة الزمنية:</span>
          <span className="text-slate-300">Africa/Cairo</span>
        </div>
        <div className="flex items-center justify-between pt-1">
          <span className="text-slate-500">وضع الوصول:</span>
          <span className="text-emerald-400 font-medium">قراءة وتحقق فقط</span>
        </div>
      </div>
    </aside>
  );
};
