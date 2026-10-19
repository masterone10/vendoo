/**
 * High-fidelity parser for Vendoor raw activity log texts.
 * Extracts structured action types, labels, field names, old/new values, notes, and metadata.
 */

export interface ParsedLogDetails {
  actionType: string;
  actionLabelAr: string;
  fieldName: string | null;
  oldValue: string | null;
  newValue: string | null;
  noteText: string | null;
  fromStatus: string | null;
  toStatus: string | null;
  summaryAr: string;
  isAdministrative: boolean;
  extraPhoneOperation?: 'ADDITION' | 'REPLACEMENT' | 'DELETION' | 'UNCLEAR';
  extraMeta?: Record<string, any>;
}

export function decodeHtmlEntities(str: string): string {
  if (!str) return '';
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim();
}

/**
 * Standardizes raw status strings to canonical Vendoor status names
 */
export function normalizeStatus(raw: string | null): string | null {
  if (!raw) return null;
  const clean = raw.trim().replace(/^['"״]|['"״]$/g, '').trim();
  const lower = clean.toLowerCase();

  if (lower === 'new' || clean === 'جديد' || clean === 'أوردر جديد' || clean === 'اوردر جديد') return 'New';
  if (lower === 'pending' || clean === 'معلق' || clean === 'قيد الانتظار') return 'Pending';
  if (lower === 'processing' || clean === 'قيد التجهيز' || clean === 'جاري التجهيز') return 'Processing';
  if (lower === 'printed' || clean === 'مطبوع' || clean === 'تمت الطباعة' || clean === 'طباعة') return 'Printed';
  if (lower === 'shipped' || clean === 'تم الشحن' || clean === 'مشحون') return 'Shipped';
  if (lower === 'delivered' || clean === 'تم التسليم' || clean === 'مسلم') return 'Delivered';
  if (lower === 'canceled' || lower === 'cancelled' || clean === 'ملغي' || clean === 'تم الإلغاء' || clean === 'تم الالغاء' || clean === 'إلغاء') return 'Canceled';
  if (lower === 'canceling' || clean === 'قيد الإلغاء' || clean === 'قيد الالغاء') return 'Canceling';
  if (lower.includes('returned') || clean.includes('مرتجع') || clean.includes('استرجاع')) return 'Returned';
  if (lower.includes('confirmed') || clean.includes('مؤكد')) return 'Confirmed';
  
  return clean;
}

export function parseLogActionDetails(rawText: string, actorName = '', orderCode = ''): ParsedLogDetails {
  const t = decodeHtmlEntities(rawText || '').trim();

  // Default fallback
  const result: ParsedLogDetails = {
    actionType: 'other',
    actionLabelAr: 'إجراء تشغيلي',
    fieldName: null,
    oldValue: null,
    newValue: null,
    noteText: null,
    fromStatus: null,
    toStatus: null,
    summaryAr: t || 'لا توجد تفاصيل إضافية',
    isAdministrative: !orderCode,
  };

  if (!t) return result;

  // 1. NOTES: (ملاحظة: / note:)
  const noteMatch = t.match(/(?:أضاف|اضاف)\s+(?:.+?\s+)?(?:ملاحظة|ملاحظه|note)\s*:\s*([\s\S]+)/i) ||
                    t.match(/(?:ملاحظة|ملاحظه|note)\s*:\s*([\s\S]+)/i);
  if (noteMatch) {
    const note = noteMatch[1].trim();
    result.actionType = 'note_added';
    result.actionLabelAr = 'إضافة ملاحظة';
    result.fieldName = 'الملاحظة';
    result.newValue = note;
    result.noteText = note;
    result.summaryAr = `إضافة ملاحظة: "${note}"`;
    result.isAdministrative = false;
    return result;
  }

  // 2. ORDER CREATED:
  const isOrderCreation = 
    ((t.includes('اوردر جديد') || t.includes('أوردر جديد') || t.includes('طلب جديد') ||
      t.includes('انشاء اوردر') || t.includes('إنشاء اوردر') || t.includes('انشاء طلب') ||
      t.includes('إنشاء طلب') || t.includes('أضاف اوردر') || t.includes('اضاف اوردر') ||
      t.toLowerCase().includes('create order') || t.toLowerCase().includes('order created')) &&
     !t.includes('عدل') && !t.includes('تعديل'));

  if (isOrderCreation) {
    result.actionType = 'order_created';
    result.actionLabelAr = 'إنشاء طلب جديد';
    result.fieldName = 'حالة الطلب';
    result.newValue = 'New';
    result.toStatus = 'New';
    result.summaryAr = 'تم إنشاء الطلب بنجاح في النظام (أوردر جديد)';
    result.isAdministrative = false;
    return result;
  }

  // 3. STATUS CHANGE: Full pattern (حالة الطلب / الاوردر من X إلى Y)
  const fullStatusRegex = /حالة\s+(?:الطلب|الاوردر)\s+من\s*['"״\s]*([^'"״\s]+(?:\s+[^'"״\s]+)*?)['"״\s]*(?:إلى|إلي|الى)\s*['"״\s]*([^'"״\s]+(?:\s+[^'"״\s]+)*?)['"״\s]*$/i;
  const fullStatusMatch = t.match(fullStatusRegex);
  if (fullStatusMatch) {
    const rawFrom = fullStatusMatch[1].trim().replace(/^['"״]|['"״]$/g, '');
    const rawTo = fullStatusMatch[2].trim().replace(/^['"״]|['"״]$/g, '');
    const normFrom = normalizeStatus(rawFrom);
    const normTo = normalizeStatus(rawTo);
    result.actionType = 'status_change';
    result.actionLabelAr = 'تغيير حالة الطلب';
    result.fieldName = 'حالة الطلب';
    result.oldValue = rawFrom;
    result.newValue = rawTo;
    result.fromStatus = normFrom;
    result.toStatus = normTo;
    result.summaryAr = `تغيير الحالة من (${rawFrom}) إلى (${rawTo})`;
    result.isAdministrative = false;
    return result;
  }

  // STATUS CHANGE: Target only (عدل حالة الطلب / الاوردر إلى Y)
  const toStatusRegex = /(?:عدل|تغيير)\s+(?:.+?\s+)?(?:حالة\s+)?(?:الطلب|الاوردر)\s+(?:إلى|إلي|الى)\s*['"״\s]*([\s\S]+?)['"״\s]*$/i;
  const toStatusMatch = t.match(toStatusRegex);
  if (toStatusMatch) {
    const rawTo = toStatusMatch[1].trim().replace(/^['"״]|['"״]$/g, '');
    const normTo = normalizeStatus(rawTo);
    result.actionType = 'status_change';
    result.actionLabelAr = 'تغيير حالة الطلب';
    result.fieldName = 'حالة الطلب';
    result.newValue = rawTo;
    result.toStatus = normTo;
    result.summaryAr = `تغيير حالة الطلب إلى (${rawTo})`;
    result.isAdministrative = false;
    return result;
  }

  // 4. ADDRESS EDIT: (العنوان من X إلى Y)
  const addrRegex = /(?:العنوان|عنوان\s+الشحن|address)\s+من\s*['"״\s]?([\s\S]+?)(?:'|"|״)?\s*(?:إلى|إلي|الى)\s*['"״\s]?([\s\S]+?)(?:'|"|״)?\s*$/i;
  const addrMatch = t.match(addrRegex);
  if (addrMatch) {
    const oldVal = addrMatch[1].trim().replace(/^['"״]|['"״]$/g, '');
    const newVal = addrMatch[2].trim().replace(/^['"״]|['"״]$/g, '');
    result.actionType = 'address_edit';
    result.actionLabelAr = 'تعديل عنوان التوصيل';
    result.fieldName = 'العنوان';
    result.oldValue = oldVal;
    result.newValue = newVal;
    result.summaryAr = `تعديل العنوان إلى: "${newVal}"`;
    result.isAdministrative = false;
    return result;
  }

  // 5. PHONE / EXTRA PHONE:
  // Pattern 5a: Range (من X إلى Y)
  const phoneRegex = /(?:رقم\s+هاتف\s+آخر|رقم\s+التليفون\s+البديل|الهاتف\s+الإضافي|الهاتف\s+الاضافي|هاتف\s+آخر|هاتف\s+بديل|رقم\s+الهاتف|الموبايل|التليفون|الهاتف)\s+من\s*['"״\s]?([\s\S]*?)(?:'|"|״)?\s*(?:إلى|إلي|الى)\s*['"״\s]?([\s\S]+?)(?:'|"|״)?\s*$/i;
  const phoneMatch = t.match(phoneRegex);
  if (phoneMatch) {
    const isExtra = t.includes('آخر') || t.includes('بديل') || t.includes('إضافي') || t.includes('اضافي');
    const oldVal = phoneMatch[1].trim().replace(/^['"״]|['"״]$/g, '');
    const newVal = phoneMatch[2].trim().replace(/^['"״]|['"״]$/g, '');
    result.actionType = isExtra ? 'extra_phone_edit' : 'phone_edit';
    result.actionLabelAr = isExtra ? 'تعديل الهاتف الإضافي' : 'تعديل رقم الهاتف';
    result.fieldName = isExtra ? 'الهاتف الإضافي' : 'رقم الهاتف';
    result.oldValue = oldVal;
    result.newValue = newVal;
    
    // Classify extra phone operation
    if (isExtra) {
      const cleanOld = oldVal.replace(/['"״]/g, '').trim();
      const cleanNew = newVal.replace(/['"״]/g, '').trim();
      if (!cleanOld && cleanNew) {
        result.extraPhoneOperation = 'ADDITION';
      } else if (cleanOld && !cleanNew) {
        result.extraPhoneOperation = 'DELETION';
      } else if (cleanOld && cleanNew && cleanOld !== cleanNew) {
        result.extraPhoneOperation = 'REPLACEMENT';
      } else {
        result.extraPhoneOperation = 'UNCLEAR';
      }
    }

    result.summaryAr = `تعديل ${result.fieldName} من (${oldVal}) إلى (${newVal})`;
    result.isAdministrative = false;
    return result;
  }

  // Pattern 5b: Direct Addition of extra phone (أضاف رقم هاتف آخر : 010... أو رقم هاتف آخر إلى '010...')
  const extraAddRegex = /(?:أضاف|اضاف)\s+(?:رقم\s+هاتف\s+آخر|رقم\s+التليفون\s+البديل|الهاتف\s+الإضافي|الهاتف\s+الاضافي|هاتف\s+آخر|هاتف\s+بديل)\s*[:：]\s*([\d\+\-\s]+)/i;
  const extraAddMatch = t.match(extraAddRegex);
  if (extraAddMatch) {
    const newVal = extraAddMatch[1].trim();
    result.actionType = 'extra_phone_added';
    result.actionLabelAr = 'إضافة هاتف إضافي';
    result.fieldName = 'الهاتف الإضافي';
    result.oldValue = '';
    result.newValue = newVal;
    result.extraPhoneOperation = 'ADDITION';
    result.summaryAr = `إضافة رقم هاتف إضافي: "${newVal}"`;
    result.isAdministrative = false;
    return result;
  }

  // Pattern 5c: Target only extra phone (رقم هاتف آخر إلى '010...')
  const extraToRegex = /(?:رقم\s+هاتف\s+آخر|رقم\s+التليفون\s+البديل|الهاتف\s+الإضافي|الهاتف\s+الاضافي|هاتف\s+آخر|هاتف\s+بديل)\s+(?:إلى|إلي|الى)\s*['"״\s]?([\s\S]+?)(?:'|"|״)?\s*$/i;
  const extraToMatch = t.match(extraToRegex);
  if (extraToMatch) {
    const newVal = extraToMatch[1].trim().replace(/^['"״]|['"״]$/g, '');
    result.actionType = 'extra_phone_added';
    result.actionLabelAr = 'إضافة هاتف إضافي';
    result.fieldName = 'الهاتف الإضافي';
    result.oldValue = '';
    result.newValue = newVal;
    result.extraPhoneOperation = 'ADDITION';
    result.summaryAr = `إضافة رقم هاتف إضافي: "${newVal}"`;
    result.isAdministrative = false;
    return result;
  }

  // 6. CUSTOMER NAME EDIT:
  const custRegex = /(?:اسم\s+العميل|العميل)\s+من\s*['"״\s]?([\s\S]+?)(?:'|"|״)?\s*(?:إلى|إلي|الى)\s*['"״\s]?([\s\S]+?)(?:'|"|״)?\s*$/i;
  const custMatch = t.match(custRegex);
  if (custMatch) {
    const oldVal = custMatch[1].trim().replace(/^['"״]|['"״]$/g, '');
    const newVal = custMatch[2].trim().replace(/^['"״]|['"״]$/g, '');
    result.actionType = 'customer_edit';
    result.actionLabelAr = 'تعديل اسم العميل';
    result.fieldName = 'اسم العميل';
    result.oldValue = oldVal;
    result.newValue = newVal;
    result.summaryAr = `تعديل اسم العميل من (${oldVal}) إلى (${newVal})`;
    result.isAdministrative = false;
    return result;
  }

  // 7. FINANCIAL / SHIPPING / COMMISSION EDIT:
  const finRegex = /(?:سعر\s+الشحن|مصاريف\s+الشحن|الشحن|العمولة|السعر|إجمالي\s+الطلب|اجمالي\s+الطلب)\s+من\s*['"״\s]?([\s\S]+?)(?:'|"|״)?\s*(?:إلى|إلي|الى)\s*['"״\s]?([\s\S]+?)(?:'|"|״)?\s*$/i;
  const finMatch = t.match(finRegex);
  if (finMatch) {
    const oldVal = finMatch[1].trim().replace(/^['"״]|['"״]$/g, '');
    const newVal = finMatch[2].trim().replace(/^['"״]|['"״]$/g, '');
    result.actionType = 'financial_edit';
    result.actionLabelAr = 'تعديل مالي / شحن';
    result.fieldName = 'بيانات مالية / الشحن';
    result.oldValue = oldVal;
    result.newValue = newVal;
    result.summaryAr = `تعديل مالي من (${oldVal}) إلى (${newVal})`;
    result.isAdministrative = false;
    return result;
  }

  // 8. PRODUCT / SIZE / COLOR / ITEM EDIT:
  if (t.includes('منتج') || t.includes('المقاس') || t.includes('اللون') || t.includes('الكمية') || t.includes('صنف')) {
    result.actionType = 'product_edit';
    result.actionLabelAr = 'تعديل في منتجات الطلب';
    result.fieldName = 'أصناف ومنتجات الطلب';
    result.summaryAr = t;
    result.isAdministrative = false;
    return result;
  }

  // 9. GENERAL ORDER DATA EDIT:
  if (t.includes('عدل في بيانات الاوردر') || t.includes('تعديل بيانات')) {
    result.actionType = 'general_edit';
    result.actionLabelAr = 'تعديل بيانات الطلب';
    result.fieldName = 'بيانات الطلب';
    result.summaryAr = 'تعديل عام في تفاصيل وبيانات الطلب';
    result.isAdministrative = false;
    return result;
  }

  // 10. SHIPPING WAYBILL (رقم البوليصة):
  if (t.includes('رقم البوليصة') || t.includes('البوليصة')) {
    result.actionType = 'waybill_edit';
    result.actionLabelAr = 'تعديل / إضافة رقم البوليصة';
    result.fieldName = 'رقم البوليصة';
    result.toStatus = null;
    result.fromStatus = null;
    result.summaryAr = t;
    result.isAdministrative = true;
    return result;
  }

  // 11. PRINTING / CONFIRMATION (Rule: Printed = تأكيد الأوردر):
  if (
    t.includes('طبع الاوردر') ||
    t.includes('طباعة الاوردر') ||
    t.includes('طبع الفاتورة') ||
    t.includes('طباعة الفاتورة') ||
    t.includes('تأكيد الطلب') ||
    t.toLowerCase() === 'printed' ||
    t === 'مطبوع'
  ) {
    result.actionType = 'status_change';
    result.actionLabelAr = 'تغيير حالة الطلب إلى Printed';
    result.fieldName = 'حالة الطلب';
    result.newValue = 'Printed';
    result.toStatus = 'Printed';
    result.summaryAr = 'تأكيد الأوردر (Printed)';
    result.isAdministrative = false;
    return result;
  }

  // 11. STAFF ASSIGNMENT:
  if (t.includes('تعيين') || t.includes('مسؤول') || t.toLowerCase().includes('assign')) {
    result.actionType = 'assign_staff';
    result.actionLabelAr = 'تعيين موظف مسؤول';
    result.fieldName = 'المسؤول';
    result.summaryAr = t;
    result.isAdministrative = true;
    return result;
  }

  return result;
}
