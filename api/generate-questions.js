// /api/generate-questions.js
// Vercel Serverless Function — يستقبل صورة/صور منهج + مادة، ويرجّع أسئلة مقترحة من Gemini.
// ✅ تحديث: يدعم الآن مصفوفة صور (imagesBase64) لدعم دفعات صفحات PDF بجانب الصورة المفردة القديمة (imageBase64).
// ✅ تحديث: يدعم customNote — ملاحظة نصية اختيارية من الأدمن تُضاف لتعليمات الذكاء الاصطناعي (مثال: تنويع طول الخيارات).
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

// حماية إضافية بجانب حد الدفعة المضبوط بالفرونت (لو حد استدعى الـ API مباشرة)
const MAX_IMAGES_PER_REQUEST = 4;
const MAX_QUESTIONS_PER_REQUEST = 15;
const MAX_NOTE_LENGTH = 300;

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
        // دعم الشكل القديم (imageBase64 مفرد) والجديد (imagesBase64 مصفوفة) معاً للتوافق العكسي
        const { imageBase64, imagesBase64, subject, count, customNote } = req.body || {};
        const imagesList = Array.isArray(imagesBase64) && imagesBase64.length
            ? imagesBase64
            : (imageBase64 ? [imageBase64] : []);

        if (!imagesList.length || !subject || !SUBJECT_LABELS[subject]) {
            return res.status(400).json({ error: 'صورة واحدة على الأقل والمادة مطلوبتان (مادة غير معروفة؟)' });
        }
        if (imagesList.length > MAX_IMAGES_PER_REQUEST) {
            return res.status(400).json({ error: `الحد الأقصى ${MAX_IMAGES_PER_REQUEST} صور/صفحات بالنداء الواحد` });
        }

        const questionCount = Math.min(Math.max(parseInt(count, 10) || 5, 1), MAX_QUESTIONS_PER_REQUEST);

        const imageParts = [];
        for (const img of imagesList) {
            const match = String(img).match(/^data:(image\/\w+);base64,(.+)$/);
            if (!match) {
                return res.status(400).json({ error: 'صيغة إحدى الصور غير صالحة' });
            }
            imageParts.push({ inline_data: { mime_type: match[1], data: match[2] } });
        }

        const safeNote = typeof customNote === 'string' ? customNote.trim().slice(0, MAX_NOTE_LENGTH) : '';

        // ── ٣) بناء الطلب لـ Gemini ──
        const subjectLabel = SUBJECT_LABELS[subject];
        const pagesNote = imageParts.length > 1
            ? `مرفق ${imageParts.length} صور تمثل صفحات متتالية من نفس المصدر — اعتبرها محتوى واحد متصل.`
            : '';

        const prompt = `أنت مساعد متخصص في إعداد أسئلة اختبارات جامعية باللغة العربية من محتوى صورة/صفحات منهج دراسي.
المادة: ${subjectLabel}
${pagesNote}
المطلوب: استخرج حتى ${questionCount} سؤال بناءً فقط على المحتوى الفعلي الموجود في الصور المرفقة.

القواعد الإلزامية:
- لكل سؤال اختيار من متعدد: أعطِ بالضبط 4 خيارات (options)، واحد منها صحيح فقط.
- لكل سؤال صح/خطأ: أعطِ خيارين فقط بالضبط: ["صح", "خطأ"].
- answer يجب أن يطابق نص أحد الخيارات حرفياً تماماً (نفس الحروف والمسافات تماماً).
- مهم جداً: نوّع طول الخيارات الأربعة بشكل عشوائي وواقعي — لا تجعل الخيار الصحيح هو الأطول دائماً ولا في نفس الترتيب دائماً (وزّع مكانه عشوائياً بين الخيارات). اجعل الخيارات الخاطئة معقولة وقريبة بالطول من الخيار الصحيح.
- ممنوع اختراع معلومات غير موجودة في الصور. لو المحتوى غير كافٍ لعدد الأسئلة المطلوب، أرجع عدد أقل بدل الاختلاق.${safeNote ? `\n- ملاحظة إضافية من الأدمن يجب مراعاتها بدقة: "${safeNote}"` : ''}
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
                            ...imageParts
                        ]
                    }],
                    generationConfig: { temperature: 0.4 }
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
