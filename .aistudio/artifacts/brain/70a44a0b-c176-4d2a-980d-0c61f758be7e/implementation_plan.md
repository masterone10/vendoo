# خطة تنفيذ: إصلاح واستكمال مزامنة أوردرات NEW في Vendoor ومطابقة العدد الفعلي

## 1. تحليل وتتبع مسار مزامنة الطلبات الحالي (Root Cause Analysis)

من خلال الفحص الفعلي للكود والشبكة الحية لمنصة Vendoor:

1. **مسار الطلبات الحالي**:
   - `src/components/DashboardView.tsx`: يقرأ رصيد الحالات من `stats.currentCounts.New`.
   - `server/routes.ts` (`/api/dashboard`): يستعلم مباشرة من SQLite:
     ```sql
     SELECT current_status, COUNT(*) as count FROM orders
     WHERE current_status IN ('New', 'Pending', 'Processing', 'Canceling')
     GROUP BY current_status
     ```
   - `server/syncEngine.ts`: يقوم بدورة المزامنة الدورية `runFullSyncCycle`.
   - `server/vendoorClient.ts`: يقوم بجلب الأوردرات عبر `fetchOrdersBatch(start, length, statusFilter)`.

2. **الأسباب الجذرية المثبتة لفرق الـ 342 أوردرًا**:
   - **السبب الجذري الأول (معامل الفلترة في Vendoor)**:
     في `server/vendoorClient.ts`، كان الكود يرسل المعامل `status_filter=1`. ولكن بفحص ملفات الجافاسكريبت وعناصر الـ HTML الحقيقية في `https://aff.ven-door.com/dashboard/orders`، تبيّن أن الـ Backend في Vendoor يعتمد على الـ Multiselect المسمى `category_filter[]` ويرسل في طلب الـ Ajax المعامل `category[]=1`، ويتجاهل تماماً معامل `status_filter=1` إذا أُرسل بمفرده. نتيجة لذلك، كان Vendoor يُرجع قائمة الطلبات العامة غير المفلترة (3,661 طلبًا مختلطًا من جميع الحالات).
   - **السبب الجذري الثاني (سقف الـ 200 أوردر في `syncEngine.ts`)**:
     في `server/syncEngine.ts` السطر 1086:
     `const maxScanOrders = (runType === 'RECONCILIATION') ? 25000 : 200;`
     كانت دورة المزامنة العادية تتوقف قسرياً بعد سحب 200 أوردر فقط (صفحتين). ومن بين هذه الـ 200 أوردر في القائمة العامة، كان يوجد فقط 207-213 أوردر بحالة "New"، في حين أن باقي أوردرات NEW (الـ 342 أوردر) كانت تقع في صفحات لاحقة ولم يتم استدعاؤها مطلقاً.
   - **السبب الجذري الثالث (تصنيف الحالة vs نوع الطلب)**:
     في Vendoor، حقل `order_type` يحتوي دائماً على "اوردر جديد" حتى لو كانت الحالة التشغيلية الفعلية للأوردر هي Pending أو Processing أو Printed. يجب الاعتماد الحصري والمطلق على حقل `status` (زر الـ HTML المستخرج منه النص التشغيلي الفعلي) لتحديد وتحديث `current_status`.

---

## 2. التدقيق الفعلي لحالة NEW مع Vendoor

- **الرابط المستهدف**: `GET https://aff.ven-door.com/dashboard/orders`
- **المعاملات المؤكدة بنجاح**:
  - `draw=1`
  - `start=0`
  - `length=100`
  - `category[]=1` (فلتر حالة New الحقيقي)
  - `status_filter=1` (للتوافق المزدوج)
- **النتيجة الحية أثناء الفحص الأولي (2026-10-25 08:09 UTC)**:
  - `recordsTotal`: **542** (مقارنة بـ 555 في الفحص السابق للمستخدم نتيجة تحرك بعض الطلبات تشغيلياً).
  - `recordsFiltered`: **542**.
- **توزيع الحالات الحية في Vendoor وقت التدقيق**:
  - **New (1)**: 542 أوردر
  - **Pending (3)**: 605 أوردر
  - **Processing (2)**: 168 أوردر
  - **Printed (13)**: 2,349 أوردر
  - **Canceled (12)**: 0 أوردر

---

## 3. خطة العمل والتعديلات المقترحة

### المرحلة 1: تصحيح `server/vendoorClient.ts`
- تعديل `fetchOrdersBatch` لإرسال `category[]` بالتوازي مع `status_filter` لكل حالة:
  - New: `category[]=1`
  - Processing: `category[]=2`
  - Pending: `category[]=3`
  - Printed: `category[]=13`
  - Canceled: `category[]=12`
- التأكد من قراءة `recordsTotal` و `recordsFiltered` الحقيقية بدقة من استجابة Vendoor.

### المرحلة 2: إعادة هيكلة `server/syncEngine.ts` للمسح الكامل بحسب الحالة (Per-Status Dynamic Drain)
- إضافة وظيفة `syncOrdersByStatus(statusName: string, statusId: string)`:
  - تقرأ العدد الإجمالي الحقيقي (`recordsTotal`) للحالة من الصفحة الأولى.
  - تجلب جميع الصفحات تباعاً (`start = 0, 100, 200, ...`) حتى استيفاء آخر سجل (`start >= recordsTotal`).
  - إلغاء أي سقف عشوائي (مثل سقف 200 سجل السابق).
  - تطبيق تأخير منتظم (Pacing) بمقدار 80-120 مللي ثانية بين الصفحات لتفادي حظر الشبكة أو الـ Rate Limit.
  - تطبيق Exponential Backoff عند حدوث انقطاع مؤقت مع استئناف المزامنة من رقم الصفحة/الـ offset التالي.
  - حفظ الأوردرات تدريجياً داخل معاملات قاعدة البيانات (Batch Transactions).
- تحديث دالة `upsertCanonicalOrder`:
  - تحديث `current_status` فوراً بالحالة الجديدة الواردة من زر `status` الفعلي.
  - تحديث `last_observed_at` و `state_entry_at` في حال تغيرت الحالة.
  - عدم تغيير حالة أي أوردر إلى Canceled إذا لم يظهر في مسح جزئي.

### المرحلة 3: تدقيق ومقارنة الأكواد الـ 342 المفقودة
- تنفيذ سكريبت تدقيق ومقارنة (Audit & Diff Script) لمقارنة:
  1. الأكواد الواردة من Vendoor بحالة NEW.
  2. الأكواد المسجلة محلياً في SQLite.
- تصنيف وحصر:
  - الأوردرات التي لم تكن مسحوبة أصلاً (بسبب سقف الـ 200 وسقوط الفلتر).
  - الأوردرات المحفوظة بحالة أخرى.
  - الأكواد المكررة أو مختلفة المفاتيح.
- عرض عينات من الأكواد لتأكيد استيعابها في قاعدة البيانات.

### المرحلة 4: اختبارات القبول الشاملة (Acceptance Testing)
1. إنشاء اختبار محاكاة مستقل `server/tests/orders_status_pagination_sync.test.ts`:
   - يحاكي مصدراً يحتوي على 555 أوردر بحالة NEW عبر صفحات متعددة (حجم الصفحة 200).
   - يتحقق من استيفاء جميع الصفحات وحفظ كافة الأوردرات الـ 555.
   - يختبر استئناف المزامنة بعد تعثر شبكة في منتصف المسح دون أي تكرار.
   - يختبر انتقال أوردر من NEW إلى Processing وتحديث حالته تلقائياً في SQLite والـ API.
2. تشغيل تدقيق ميداني حي مع خادم Vendoor الحقيقي لسحب وحفظ جميع أوردرات NEW الحالية.
3. التحقق من أن استعلام قاعدة البيانات، والـ API `/api/dashboard`، والداشبورد يظهرون نفس العدد الدقيق المتطابق مع Vendoor.
4. التأكد من نجاح كافة الاختبارات الـ 28 السابقة بالإضافة للاختبار الجديد (`npm test`) واكتمال `npm run lint` و `npm run build`.

---

## 4. خطة التحقق والمطابقة النهائية (Verification Plan)

| المؤشر | طريقة التحقق | النتيجة المتوقعة |
|---|---|---|
| **عدد Vendoor الحي** | استعلام مباشر لـ Vendoor عبر `category[]=1` | الحصول على العدد الحي الدقيق (542-555) |
| **قاعدة بيانات SQLite** | `SELECT count(*) FROM orders WHERE current_status = 'New'` | مطابقة 100% مع عدد Vendoor |
| **مسار API** | `GET http://localhost:3000/api/dashboard` -> `stats.currentCounts.New` | مطابقة 100% |
| **واجهة Dashboard** | فحص قيمة بطاقة "أوردر جديد" | مطابقة 100% |
| **اختبارات النظام** | تشغيل `npm test` | نجاح جميع ملفات الاختبار واختبار المزامنة الجديد |
