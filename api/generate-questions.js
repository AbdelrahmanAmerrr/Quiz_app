// /api/generate-questions.js
// Vercel Serverless Function — يستقبل صورة منهج + مادة، ويرجّع أسئلة مقترحة من Gemini.
// الأمان: يتحقق من Firebase ID Token ومن وجود الـ uid داخل مجموعة admins قبل أي نداء لـ Gemini،
// حتى لا يقدر أي زائر يكتشف رابط الـ API ويستهلك حصتك المجانية.

const admin = require('firebase-admin');

if (!admin.apps.length) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
}

// نفس أسماء المواد المستخدمة في AmerQuiz.html (fixedSubjects) — للعرض داخل الـ prompt فقط
const SUBJECT_LABELS = {
    databases: "قواعد البيانات",
    structured_programming: "البرمجة الهيكلية",
    corporate_accounting: "محاسبة شركات",
    operations_management: "إدارة الانتاج والعمليات",
    economics_english: "انجليزي اقتصاد"
};

module.exports = async (req, res) => {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        // ── ١) التحقق من هوية الأدمن ──
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

        // ── ٢) قراءة وتحقق أساسي من المدخلات ──
        const { imageBase64, subject, count } = req.body || {};
        if (!imageBase64 || !subject || !SUBJECT_LABELS[subject]) {
            return res.status(400).json({ error: 'الصورة والمادة مطلوبتان (مادة غير معروفة؟)' });
        }
        const questionCount = Math.min(Math.max(parseInt(count, 10) || 5, 1), 10);

        const match = imageBase64.match(/^data:(image\/\w+);base64,(.+)$/);
        if (!match) {
            return res.status(400).json({ error: 'صيغة الصورة غير صالحة' });
        }
        const mimeType = match[1];
        const base64Data = match[2];

        // ── ٣) بناء الطلب لـ Gemini ──
        const subjectLabel = SUBJECT_LABELS[subject];
        const prompt = `أنت مساعد متخصص في إعداد أسئلة اختبارات جامعية باللغة العربية من محتوى صورة صفحة منهج دراسي.
المادة: ${subjectLabel}
المطلوب: استخرج حتى ${questionCount} سؤال بناءً فقط على المحتوى الفعلي الموجود في الصورة المرفقة.

القواعد الإلزامية:
- لكل سؤال اختيار من متعدد: أعطِ بالضبط 4 خيارات (options)، واحد منها صحيح فقط.
- لكل سؤال صح/خطأ: أعطِ خيارين فقط بالضبط: ["صح", "خطأ"].
- answer يجب أن يطابق نص أحد الخيارات حرفياً تماماً (نفس الحروف والمسافات تماماً).
- ممنوع اختراع معلومات غير موجودة في الصورة. لو المحتوى غير كافٍ لعدد الأسئلة المطلوب، أرجع عدد أقل بدل الاختلاق.
- أعد الإجابة بصيغة JSON فقط، بدون أي نص أو شرح قبله أو بعده، وبدون علامات backticks أو كلمة json، بالضبط بهذا الشكل:
[{"question":"...","options":["...","...","...","..."],"answer":"...","explanation":"..."}]`;

        const geminiResponse = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{
                        parts: [
                            { text: prompt },
                            { inline_data: { mime_type: mimeType, data: base64Data } }
                        ]
                    }],
                    generationConfig: { temperature: 0.2 }
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
                    // نكتفي بأول 150 حرف من رسالة جوجل الحقيقية بدل تفريغها كاملة (كانت تملأ الشاشة)
                    friendlyMsg = 'فشل الاتصال بخدمة الذكاء الاصطناعي: ' + String(errJson.error.message).slice(0, 150);
                }
            } catch (e) { /* الرد مش JSON صالح، نكتفي بالرسالة الافتراضية أعلاه */ }
            return res.status(502).json({ error: friendlyMsg });
        }

        const geminiData = await geminiResponse.json();
        let rawText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        rawText = rawText.replace(/```json|```/g, '').trim();

        let questions;
        try {
            questions = JSON.parse(rawText);
        } catch (e) {
            return res.status(502).json({ error: 'رد غير قابل للقراءة من الذكاء الاصطناعي، جرّب مرة أخرى أو بصورة أوضح' });
        }

        if (!Array.isArray(questions)) {
            return res.status(502).json({ error: 'صيغة غير متوقعة من الذكاء الاصطناعي' });
        }

        // ── ٤) تحقق أساسي: نتجاهل أي سؤال ناقص أو answer لا يطابق أحد الخيارات ──
        const validQuestions = questions
            .filter(q =>
                q && typeof q.question === 'string' && q.question.trim() &&
                Array.isArray(q.options) && q.options.length >= 2 && q.options.length <= 4 &&
                typeof q.answer === 'string' &&
                q.options.map(o => String(o).trim()).includes(q.answer.trim())
            )
            .map(q => ({
                question: q.question.trim(),
                options: q.options.map(o => String(o).trim()),
                answer: q.answer.trim(),
                explanation: typeof q.explanation === 'string' ? q.explanation.trim() : ''
            }));

        return res.status(200).json({ questions: validQuestions, subject });

    } catch (err) {
        return res.status(500).json({ error: 'خطأ داخلي في الخادم: ' + err.message });
    }
};
