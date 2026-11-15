// /api/generate-visuals.js
// Vercel Serverless Function — يستقبل دفعة أسئلة ويرجّع لكل سؤال "شرح تفصيلي" مناسب (أو null لو مفيش حاجة تتشرح بصرياً).
// نفس أسلوب generate-questions.js: التحقق من Firebase ID Token + وجود الـ uid في admins قبل أي نداء لـ Gemini.
// الشكل المرجَّع: { visuals: { "<id السؤال>": {…شرح…} | null } }
// لو سؤال مش موجود في الرد معناه إن الذكاء الاصطناعي ما ردّش عليه صح، والفرونت هيسيبه للمحاولة الجاية.

const admin = require('firebase-admin');

if (!admin.apps.length) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
}

const SUBJECT_LABELS = {
    databases: "قواعد البيانات",
    structured_programming: "البرمجة الهيكلية",
    corporate_accounting: "محاسبة شركات",
    operations_management: "إدارة الانتاج والعمليات",
    economics_english: "انجليزي اقتصاد"
};

// توجيه إضافي لكل مادة: القوالب الأنسب + شدة الحذر في الأرقام
const SUBJECT_HINTS = {
    corporate_accounting: 'المادة محاسبة شركات (شركات الأشخاص والأموال). فضّل taccount وjournal وcalc وsplit وbars وlists وcards وnested وpairs. الأرقام: استخدم أرقام السؤال فقط. أي رقم ناتج عن حساب لازم تراجعه مرتين (الجمع والطرح والنسب) وأن يكون صحيحاً 100% ويتوافق مع الإجابة الصحيحة؛ ولو لست متأكداً من حساب رجّع null بدل المخاطرة. في taccount ضع الجانب المدين في dr والدائن في cr، وفي journal اكتب "من ح/..." للمدين و"إلى ح/..." للدائن.',
    operations_management: 'المادة إدارة الإنتاج والعمليات. فضّل cards وflow وcycle وlevels وmatrix وcompare وlists وcalc وbars وtable وtf وpairs. أي حساب أرقام لازم يكون صحيحاً 100% (راجعه مرتين) أو رجّع null.',
    structured_programming: 'المادة برمجة هيكلية. فضّل code وflow وcells وcompare وtable وtf وpairs. الأكواد بالإنجليزية كما هي.',
    databases: 'المادة قواعد بيانات. فضّل table وjoin وvenn وflow وcompare وcode وlevels وpairs. الاستعلامات بالإنجليزية كما هي.',
    economics_english: 'المادة انجليزي اقتصاد (الأسئلة بالإنجليزية). اكتب الشرح ثنائي اللغة لتسهيل الفهم على الطالب: title بالإنجليزية، وsub بالعربية يشرح الفكرة في سطر، وكل مصطلح اقتصادي بصيغة "English term (المصطلح بالعربية)"، والـcaption بالعربية البسيطة مع المصطلحات الإنجليزية بين أقواس. فضّل nested وgraph (للعرض والطلب وAD/AS مع dir وshift وeq) وscale وformula وtimeline وcompare وpairs وtf وcards وlists. لا تحط أرقاماً غير موجودة في السؤال.'
};

const MAX_QUESTIONS_PER_REQUEST = 10;
const MAX_FIELD_LENGTH = 700;      // نقص أي نص سؤال/خيار/شرح طويل قبل ما يروح للذكاء الاصطناعي
const MAX_VISUAL_JSON_LENGTH = 3000; // نفس حد الفرونت

const VISUAL_TYPES = ['flow', 'cells', 'code', 'table', 'compare', 'join', 'cards', 'taccount', 'calc', 'bars', 'split', 'journal', 'lists',
    'nested', 'timeline', 'formula', 'scale', 'graph', 'pairs', 'venn', 'levels', 'cycle', 'tf', 'matrix'];
const JOIN_KINDS = ['inner', 'left', 'right', 'full', 'left_only', 'right_only'];

// نفس قواعد _vsValidate في الفرونت — الفحص على السيرفر هنا حماية إضافية قبل ما أي شيء يرجع للأدمن
function validateVisual(v) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
    if (!VISUAL_TYPES.includes(v.type)) return false;
    if (JSON.stringify(v).length > MAX_VISUAL_JSON_LENGTH) return false;
    if (v.type === 'flow')    return Array.isArray(v.steps) && v.steps.length >= 1 && v.steps.length <= 8;
    if (v.type === 'cells')   return Array.isArray(v.cells) && v.cells.length >= 1 && v.cells.length <= 20;
    if (v.type === 'code')    return Array.isArray(v.lines) && v.lines.length >= 1 && v.lines.length <= 14;
    if (v.type === 'table')   return Array.isArray(v.cols) && Array.isArray(v.rows) && v.cols.length <= 6 && v.rows.length <= 8;
    if (v.type === 'compare') return !!v.left && !!v.right;
    if (v.type === 'join')    return JOIN_KINDS.includes(v.kind);
    if (v.type === 'cards')    return Array.isArray(v.items) && v.items.length >= 1 && v.items.length <= 8;
    if (v.type === 'taccount') return Array.isArray(v.dr) && Array.isArray(v.cr) && v.dr.length <= 8 && v.cr.length <= 8 && (v.dr.length + v.cr.length) > 0;
    if (v.type === 'calc')     return Array.isArray(v.rows) && v.rows.length >= 1 && v.rows.length <= 10;
    if (v.type === 'bars')     return Array.isArray(v.items) && v.items.length >= 1 && v.items.length <= 6;
    if (v.type === 'split')    return Array.isArray(v.parts) && v.parts.length >= 2 && v.parts.length <= 5;
    if (v.type === 'journal')  return Array.isArray(v.lines) && v.lines.length >= 1 && v.lines.length <= 8;
    if (v.type === 'lists')    return Array.isArray(v.groups) && v.groups.length >= 1 && v.groups.length <= 4;
    if (v.type === 'nested')   return !!v.box && typeof v.box === 'object' && !!v.box.h;
    if (v.type === 'timeline') return Array.isArray(v.points) && v.points.length >= 2 && v.points.length <= 9;
    if (v.type === 'formula')  return Array.isArray(v.parts) && v.parts.length >= 2 && v.parts.length <= 6;
    if (v.type === 'scale')    return !!v.left && !!v.right;
    if (v.type === 'graph')    return Array.isArray(v.lines) && v.lines.length >= 1 && v.lines.length <= 4 && v.lines.every(l => l && ['up', 'down', 'flat', 'vertical'].includes(l.dir));
    if (v.type === 'pairs')    return Array.isArray(v.items) && v.items.length >= 1 && v.items.length <= 8;
    if (v.type === 'venn')     return !!v.left && !!v.right && !!v.both;
    if (v.type === 'levels')   return Array.isArray(v.items) && v.items.length >= 2 && v.items.length <= 6;
    if (v.type === 'cycle')    return Array.isArray(v.steps) && v.steps.length >= 3 && v.steps.length <= 6;
    if (v.type === 'tf')       return Array.isArray(v.items) && v.items.length >= 1 && v.items.length <= 6;
    if (v.type === 'matrix')   return Array.isArray(v.cells) && v.cells.length === 4;
    return false;
}

function clip(s) {
    return String(s == null ? '' : s).slice(0, MAX_FIELD_LENGTH);
}

module.exports = async (req, res) => {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        // ── ١) التحقق من هوية الأدمن (نفس generate-questions) ──
        const authHeader = req.headers.authorization || '';
        const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
        if (!idToken) {
            return res.status(401).json({ error: 'مفقود رمز الدخول (يرجى تسجيل الدخول من جديد)' });
        }

        let decoded;
        try {
            decoded = await admin.auth().verifyIdToken(idToken);
        } catch (e) {
            return res.status(401).json({ error: 'رمز الدخول غير صالح أو منتهي' });
        }

        const db = admin.firestore();
        const adminDoc = await db.collection('admins').doc(decoded.uid).get();
        if (!adminDoc.exists) {
            return res.status(403).json({ error: 'هذا الحساب لا يملك صلاحية أدمن' });
        }

        // ── ٢) المدخلات ──
        const { subject, questions } = req.body || {};
        if (!subject || !SUBJECT_LABELS[subject]) {
            return res.status(400).json({ error: 'المادة غير معروفة' });
        }
        if (!Array.isArray(questions) || !questions.length) {
            return res.status(400).json({ error: 'لا توجد أسئلة في الطلب' });
        }
        if (questions.length > MAX_QUESTIONS_PER_REQUEST) {
            return res.status(400).json({ error: `الحد الأقصى ${MAX_QUESTIONS_PER_REQUEST} أسئلة بالنداء الواحد` });
        }

        // نستخدم أرقام قصيرة (0..n) في الـ prompt بدل الـ id الحقيقي، ونرجّعها لـ id بعد الرد
        const items = questions.map((q, i) => ({
            i,
            id: String(q && q.id || ''),
            question: clip(q && q.question),
            options: Array.isArray(q && q.options) ? q.options.map(clip) : [],
            answer: clip(q && q.answer),
            explanation: clip(q && q.explanation)
        })).filter(x => x.id && x.question);

        if (!items.length) {
            return res.status(400).json({ error: 'الأسئلة المرسلة غير صالحة' });
        }

        const promptQuestions = items.map(x =>
            JSON.stringify({ i: x.i, question: x.question, options: x.options, answer: x.answer, explanation: x.explanation })
        ).join('\n');

        // ── ٣) الـ prompt ──
        const prompt = `أنت مصمم شروح تفصيلية لمنصة اختبارات جامعية. المادة: ${SUBJECT_LABELS[subject]}.
توجيه خاص بالمادة: ${SUBJECT_HINTS[subject] || ''}
لكل سؤال أدناه، قرر هل فيه "شرح تفصيلي" يفيد الطالب فعلاً في فهم المفهوم، واختر له القالب الأنسب. لو السؤال مجرد تعريف أو حفظ أو لا يستفيد من رسم، رجّع null بدل ما تفتعل شرحاً.

القوالب المتاحة (استخدم هذه الحقول بالضبط، وبدون أي حقول أخرى):
1) flow — سلسلة خطوات أو مراحل أو ترتيب أحداث:
{"type":"flow","title":"...","steps":[{"t":"اسم قصير","d":"وصف قصير"}],"active":رقم الخطوة المطلوبة في السؤال (يبدأ من 0),"caption":"الخلاصة"}
2) cells — خانات مصفوفة/ذاكرة/ترتيب عناصر. كل عنصر نص بصيغة "الفهرس" أو "الفهرس|القيمة". استخدم "…" لاختصار الجزء الأوسط:
{"type":"cells","title":"...","cells":["0","1","2","…","49","50"],"hl":[أرقام مواضع الخانات المهمة في المصفوفة],"caption":"..."}
3) code — تتبّع كود سطر بسطر:
{"type":"code","title":"...","lines":["سطر كود","سطر كود"],"hl":[أرقام الأسطر المهمة (تبدأ من 0)],"notes":[{"l":رقم السطر,"t":"ماذا يفعل"}],"caption":"..."}
4) table — جدول بيانات أو جدول قاعدة بيانات:
{"type":"table","title":"...","name":"اسم الجدول","cols":["..."],"rows":[["..."]],"hr":[أرقام الصفوف المميزة],"hc":[أرقام الأعمدة المميزة],"caption":"..."}
5) compare — مقارنة بين شيئين:
{"type":"compare","title":"...","left":{"h":"...","tone":"good أو bad أو محايد","items":["..."]},"right":{"h":"...","tone":"...","items":["..."]},"caption":"..."}
6) join — مخطط JOIN في قواعد البيانات (kind واحد من: inner, left, right, full, left_only, right_only):
{"type":"join","title":"...","kind":"inner","left":"اسم الجدول الأيسر","right":"اسم الجدول الأيمن","sql":"استعلام SQL قصير","caption":"..."}
7) cards — بطاقات ملوّنة مرقّمة (أنواع، تصنيفات، خصائص):
{"type":"cards","title":"...","sub":"سطر فرعي اختياري","items":[{"t":"العنوان","d":"وصف قصير"}],"hl":[رقم البطاقة المطلوبة (من 0)],"caption":"..."}
8) taccount — حساب T (مدين/دائن). dr = الجانب المدين (منه)، cr = الجانب الدائن (له). v نص الرقم، hl:true لتمييز السطر المطلوب:
{"type":"taccount","title":"ح/ اسم الحساب","sub":"سطر فرعي","dr":[{"t":"البند","v":"1,000"}],"cr":[{"t":"البند","v":"1,000","hl":true}],"drTot":"إجمالي المدين","crTot":"إجمالي الدائن","caption":"..."}
9) calc — قائمة حساب سطر بسطر. op واحد من + أو - أو = ، b:true لسطر الإجمالي، hl:true للسطر المطلوب:
{"type":"calc","title":"...","sub":"الأرقام بالجنيه","rows":[{"l":"البند","v":"60,000","op":"+","b":false,"hl":false}],"caption":"..."}
10) bars — أشرطة مقارنة بين قيم رقمية. v رقم حقيقي (للتناسب)، s نص العرض، res نتيجة اختيارية (tone: bad لو سلبية):
{"type":"bars","title":"...","items":[{"l":"الإيرادات","v":600,"s":"50 × 12 = 600"}],"res":{"t":"600 - 180 = 420 ربح","d":"شرح قصير","tone":"good"},"caption":"..."}
11) split — شريط توزيع نسب أو حصص. v وزن الحصة (رقم)، n النص المعروض:
{"type":"split","title":"...","label":"الباقي 24,000 بنسبة متساوية","parts":[{"l":"نصيب أ","v":1,"n":"12,000"},{"l":"نصيب ب","v":1,"n":"12,000"}],"caption":"..."}
12) journal — قيد يومية. k إما dr (مدين) أو cr (دائن):
{"type":"journal","title":"...","lines":[{"k":"dr","a":"من ح/ الصندوق","v":"5,000"},{"k":"cr","a":"إلى ح/ رأس المال","v":"5,000"}],"note":"البيان","caption":"..."}
13) lists — مجموعات نقاط ✓ (خصائص أو شروط أو مقارنة نظريات):
{"type":"lists","title":"...","groups":[{"h":"العنوان","sub":"سطر فرعي","items":["نقطة","نقطة"]}],"caption":"..."}
14) nested — صناديق متداخلة (جزء داخل كل، حتى 3 مستويات). hl:true لتمييز الصندوق المطلوب:
{"type":"nested","title":"...","sub":"...","box":{"h":"العنوان","d":"وصف","items":["نقطة"],"kids":[{"h":"...","d":"...","items":["..."],"hl":true,"kids":[]}]},"caption":"..."}
15) timeline — خط زمني أو مراحل مرتبة (من 2 إلى 9 نقاط). l لافتة فوق النقطة (تُستخدم للأولى والأخيرة غالباً)، arc نص قوس المقارنة بين الأولى والأخيرة:
{"type":"timeline","title":"...","sub":"...","points":[{"y":"2020","l":"base year"},{"y":"2021"},{"y":"2026","l":"current year"}],"arc":"compared with","caption":"..."}
16) formula — معادلة مكوّنة من أجزاء، كل جزء بطاقة برمز كبير. expr المعادلة نفسها (رموزها لازم تطابق sym حرفياً لتتلوّن):
{"type":"formula","title":"...","sub":"...","parts":[{"sym":"C","en":"Consumers","ar":"المستهلكون","d":"Consumption"}],"hl":[رقم الجزء المطلوب],"expr":"AD = C + I + G + (X - M)","caption":"..."}
17) scale — ميزان كفتين لمقارنة كمّيتين. heavy: left أو right أو none (الجهة الأثقل/الأكبر):
{"type":"scale","title":"...","sub":"...","left":{"l":"Revenue","s":"الإيرادات"},"right":{"l":"Expenditure","s":"النفقات"},"heavy":"right","res":{"t":"النتيجة","tone":"bad"},"caption":"..."}
18) graph — رسم بياني اقتصادي بمنحنيات. dir واحد من: down (منحنى هابط كالطلب)، up (صاعد كالعرض)، flat (أفقي)، vertical (رأسي). shift رقم صحيح من -2 إلى 2 لإزاحة المنحنى (موجب = يمين/أعلى)، dash:true لمنحنى قديم متقطع. eq لإظهار نقطة التوازن بين أول منحنى down وأول منحنى up غير متقطعين:
{"type":"graph","title":"...","sub":"...","x":"Quantity","y":"Price","lines":[{"l":"D","dir":"down"},{"l":"S","dir":"up"}],"eq":{"p":"P","q":"Q"},"caption":"..."}
19) pairs — مصطلح ومعناه (تعريفات أو مطابقة):
{"type":"pairs","title":"...","items":[{"a":"المصطلح","b":"معناه"}],"caption":"..."}
20) venn — أوجه الشبه والاختلاف بين شيئين. عناوين h كلمة أو كلمتين فقط:
{"type":"venn","title":"...","left":{"h":"A","items":["..."]},"right":{"h":"B","items":["..."]},"both":{"h":"مشترك","items":["..."]},"caption":"..."}
21) levels — هرم أو مستويات (من 2 إلى 6). inv:true يعكس الشكل (قمع):
{"type":"levels","title":"...","items":[{"t":"المستوى","d":"وصف"}],"caption":"..."}
22) cycle — دورة مغلقة من 3 إلى 6 خطوات، center نص قصير في المنتصف:
{"type":"cycle","title":"...","center":"PDCA","steps":[{"t":"Plan"},{"t":"Do"},{"t":"Check"},{"t":"Act"}],"caption":"..."}
23) tf — عبارات صحيحة وخاطئة مع السبب (ok:true أو false):
{"type":"tf","title":"...","items":[{"t":"العبارة","ok":true,"d":"السبب"}],"caption":"..."}
24) matrix — مصفوفة 2×2 بترتيب: (أعلى يسار، أعلى يمين، أسفل يسار، أسفل يمين). xl عنوان المحور الأفقي وyl العمودي:
{"type":"matrix","title":"...","xl":"التكلفة →","yl":"↑ الجودة","cells":[{"t":"...","d":"..."},{"t":"..."},{"t":"..."},{"t":"..."}],"hl":[0],"caption":"..."}

القواعد الإلزامية:
- الشرح لازم يتطابق تماماً مع الإجابة الصحيحة (answer) ولا يناقضها، ولا تخترع معلومات خارج السؤال وشرحه المرفق.
- title وcaption بالعربية البسيطة وقصيرين. الأكواد وأسماء الدوال والمصطلحات التقنية تبقى بالإنجليزية كما هي.
- خلّي الشرح صغيراً: flow بحد أقصى 6 خطوات، code بحد أقصى 8 أسطر، table بحد أقصى 5 صفوف و5 أعمدة، cells بحد أقصى 12 عنصراً، cards بحد أقصى 5 بطاقات، taccount بحد أقصى 5 بنود في كل جانب، calc بحد أقصى 8 أسطر.
- لا تستخدم مصفوفات داخل مصفوفات في أي قالب (استخدم كائنات كما في الأشكال أعلاه).
- يمكنك إضافة sub (سطر فرعي قصير تحت العنوان) لأي قالب.
- اختر القالب الأبسط الذي يوصّل الفكرة؛ لا تعقّد الشرح.
- لا تستخدم ردود طويلة؛ الشرح كله أقل من 1500 حرف.
- نوّع القوالب حسب ما يناسب كل سؤال، ولا تستخدم نفس القالب لكل الأسئلة.

الأسئلة (كل سطر JSON، الحقل i هو رقم السؤال):
${promptQuestions}

أعد الإجابة بصيغة JSON فقط، بدون أي نص قبلها أو بعدها، وبدون backticks، مصفوفة بنفس عدد الأسئلة بالضبط:
[{"i":0,"visual":{...} أو null},{"i":1,"visual":null}]`;

        // ── ٤) نداء Gemini ──
        const geminiResponse = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: { temperature: 0.3, responseMimeType: 'application/json' }
                })
            }
        );

        if (!geminiResponse.ok) {
            let friendlyMsg = `فشل الاتصال بخدمة الذكاء الاصطناعي (رمز الخطأ: ${geminiResponse.status})`;
            try {
                const errJson = await geminiResponse.json();
                const status = errJson?.error?.status;
                if (geminiResponse.status === 429 || status === 'RESOURCE_EXHAUSTED') {
                    friendlyMsg = '⏳ تم تجاوز الحد المجاني المسموح من Gemini مؤقتاً. انتظر دقيقة وحاول مرة أخرى.';
                } else if (errJson?.error?.message) {
                    friendlyMsg = 'فشل الاتصال بخدمة الذكاء الاصطناعي: ' + String(errJson.error.message).slice(0, 150);
                }
            } catch (e) { /* الرد مش JSON صالح */ }
            return res.status(502).json({ error: friendlyMsg });
        }

        const geminiData = await geminiResponse.json();
        let rawText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        rawText = rawText.replace(/```json|```/g, '').trim();

        let parsed;
        try {
            parsed = JSON.parse(rawText);
        } catch (e) {
            return res.status(502).json({ error: 'رد غير قابل للقراءة من الذكاء الاصطناعي، جرّب مرة أخرى' });
        }
        if (!Array.isArray(parsed)) {
            return res.status(502).json({ error: 'صيغة غير متوقعة من الذكاء الاصطناعي' });
        }

        // ── ٥) بناء الرد: شرح صالح / null صريح (متخطّى) / غير موجود (يُعاد المحاولة) ──
        const visuals = {};
        const byIndex = new Map(items.map(x => [x.i, x]));
        for (const row of parsed) {
            if (!row || typeof row.i !== 'number') continue;
            const item = byIndex.get(row.i);
            if (!item) continue;
            if (row.visual === null) {
                visuals[item.id] = null;
            } else if (validateVisual(row.visual)) {
                visuals[item.id] = row.visual;
            }
            // غير صالح: لا نضيفه، فالفرونت يحسبه فاشل ويسيبه للمرة الجاية
        }

        return res.status(200).json({ visuals, subject });

    } catch (err) {
        return res.status(500).json({ error: 'خطأ داخلي في الخادم: ' + err.message });
    }
};
