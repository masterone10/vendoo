export interface OrderItem {
  id: number;
  order_id: number;
  vendoor_item_id: number | null;
  product_id: number | null;
  product_name: string;
  merchant_code: string;
  merchant_id: string | null;
  sku: string | null;
  size: string | null;
  color: string | null;
  quantity: number;
  unit_price: number;
  pay_vendor: number;
  image_path: string | null;
  created_at: string;
}

export interface Order {
  id: number;
  vendoor_id: number;
  random_number: string;
  order_no: string | null;
  order_type: string;
  current_status: 'New' | 'Pending' | 'Processing' | 'Printed' | 'Canceled' | string;
  affiliate_code: string;
  affiliate_name: string;
  customer_name: string;
  customer_phone: string;
  customer_phone_extra: string | null;
  extra_phone_valid: number;
  extra_phone_status?: 'NOT_RETRIEVED' | 'PRESENT' | 'CONFIRMED_ABSENT' | 'RETRIEVAL_FAILED' | string;
  governorate: string;
  address: string;
  address_quality_status?: 'VALID' | 'SHORT_ADDRESS' | 'LATIN_SCRIPT' | 'MISSING' | 'NOT_RETRIEVED' | string;
  total_price: number;
  shipping_cost: number;
  total_order: number;
  distinct_merchant_count: number;
  multi_merchant_flag: number;
  delivery_rate: number | null;
  delivery_rate_num: number | null;
  delivery_rate_denom: number | null;
  cancel_rate: number | null;
  total_customer_orders: number | null;
  phone_repetition_count: number | null;
  customer_last_order_status: string | null;
  customer_last_order_elapsed: string | null;
  customer_delivery_warning: string | null;
  confirmation_age_category: '1_day' | '2_days' | '3_days' | 'over_3_days' | null;
  printed_date: string | null;
  state_entry_at: string | null;
  created_at_source: string;
  last_observed_at: string;
}

export interface Alert {
  id: number;
  alert_key: string;
  order_id: number;
  random_number: string;
  alert_type: 'MULTIPLE_MERCHANT_CODES' | 'LOW_DELIVERY_RATE' | 'MISSING_EXTRA_PHONE' | 'INCOMPLETE_DATA';
  severity: 'CRITICAL' | 'WARNING' | 'INFO';
  status: 'OPEN' | 'IN_REVIEW' | 'RESOLVED';
  title: string;
  description: string;
  details_json: string | null;
  is_pre_existing: number;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution_notes: string | null;
  customer_name?: string;
  customer_phone?: string;
  governorate?: string;
  total_order?: number;
  delivery_rate?: number;
}

export interface DashboardStats {
  selectedDate?: string;
  isToday?: boolean;
  storageTier?: 'HOT' | 'COLD';
  coverageStatus?: string;
  isCached?: boolean;
  currentCounts: {
    New: number;
    Pending: number;
    Processing: number;
    Canceling: number;
    Printed: number;
    Canceled: number;
  };
  confirmationAges: {
    '1_day': number;
    '2_days': number;
    '3_days': number;
    'over_3_days': number;
  };
  riskIndicators: {
    multiMerchantPrinted: number;
    lowDeliveryRatePrinted: number;
    missingExtraPhonePrinted: number;
    openAlertsCount: number;
  };
  todayActivity: {
    Created: number;
    Printed: number;
    Pending: number;
    Processing: number;
    Canceling: number;
    Canceled: number;
  };
  pendingAge: {
    lessThanTwoDays: number;
    twoToFourDays: number;
    fourToFiveDays: number;
    overFiveDays: number;
    unknown: number;
    total: number;
  };
  processingAge: {
    lessThanTwoDays: number;
    twoToFourDays: number;
    fourToFiveDays: number;
    overFiveDays: number;
    unknown: number;
    total: number;
  };
  syncStatus: SyncStatus;
  databaseMode?: 'SUPABASE_POSTGRES' | 'SQLITE_AWAITING_CONFIG';
  supabaseConfigured?: boolean;
}

export interface SupabaseStatus {
  isConfigured: boolean;
  isConnected: boolean;
  latencyMs: number | null;
  mode: 'SUPABASE_POSTGRES' | 'SQLITE_AWAITING_CONFIG';
  host?: string;
  database?: string;
  missingTables: string[];
  presentTables: string[];
  tableCounts: Record<string, number>;
  canonicalConstraintPresent: boolean;
  error?: string | null;
}

export interface SyncStatus {
  isRunning: boolean;
  cycleState?: 'IDLE' | 'QUEUED' | 'RUNNING' | 'PARTIAL' | 'SUCCESS' | 'ERROR';
  lastSyncStartedAt: string | null;
  lastSyncCompletedAt: string | null;
  lastSuccessfulSyncAt: string | null;
  nextScheduledRunAt?: string | null;
  currentPhase: string;
  totalOrdersInDb: number;
  totalAlertsOpen: number;
  lastError: string | null;
  consecutiveFailures: number;
  lastDurationMs?: number | null;
}

export interface TeamMember {
  name: string;
  actions: number;
  uniqueOrders: number;
  printed: number;
  pending: number;
  processing: number;
  cancel: number;
  other: number;
  printedPercent?: number;
  pendingPercent?: number;
  processingPercent?: number;
  cancelPercent?: number;
  otherPercent?: number;
}
