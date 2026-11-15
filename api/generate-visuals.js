// /api/generate-visuals.js
// Vercel Serverless Function — يستقبل دفعة أسئلة ويرجّع لكل سؤال "شرح مرئي" مناسب (أو null لو مفيش حاجة تتشرح بصرياً).
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

const MAX_QUESTIONS_PER_REQUEST = 10;
const MAX_FIELD_LENGTH = 700;      // نقص أي نص سؤال/خيار/شرح طويل قبل ما يروح للذكاء الاصطناعي
const MAX_VISUAL_JSON_LENGTH = 3000; // نفس حد الفرونت

const VISUAL_TYPES = ['flow', 'cells', 'code', 'table', 'compare', 'join'];
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
        const prompt = `أنت مصمم شروح مرئية لمنصة اختبارات جامعية. المادة: ${SUBJECT_LABELS[subject]}.
لكل سؤال أدناه، قرر هل فيه "شرح مرئي" يفيد الطالب فعلاً في فهم المفهوم، واختر له القالب الأنسب. لو السؤال مجرد تعريف أو حفظ أو لا يستفيد من رسم، رجّع null بدل ما تفتعل شرحاً.

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

القواعد الإلزامية:
- الشرح لازم يتطابق تماماً مع الإجابة الصحيحة (answer) ولا يناقضها، ولا تخترع معلومات خارج السؤال وشرحه المرفق.
- title وcaption بالعربية البسيطة وقصيرين. الأكواد وأسماء الدوال والمصطلحات التقنية تبقى بالإنجليزية كما هي.
- خلّي الشرح صغيراً: flow بحد أقصى 6 خطوات، code بحد أقصى 8 أسطر، table بحد أقصى 5 صفوف و5 أعمدة، cells بحد أقصى 12 عنصراً.
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
