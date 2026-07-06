// /api/exam-chat.js
// Vercel Serverless Function — مساعد مذاكرة بالذكاء الاصطناعي أثناء الامتحان (وضع مقيّد جداً).
//
// ✅ تحديث: تحويل تلقائي فوري لـ Groq (نموذج Llama) لو Gemini كان مشغول أو رجّع خطأ حصة —
// بدون ما الطالب يحس بأي توقف. Groq نص فقط، فهو مناسب هنا لأن الشات نصي بالكامل
// (بعكس توليد الأسئلة من صور/PDF اللي محتاج نموذج رؤية، فمفيش فيه تحويل مشابه).
//
// مبادئ أمان أساسية (بدون تغيير):
// 1) الخيارات والإجابة الصحيحة لا تُرسل لأي نموذج أبداً — فقط نص السؤال والمادة.
// 2) بوابة معدل منفصلة لكل مزوّد (Gemini و Groq) عبر Firestore، تحمي حصة كل واحد فيهم.
// 3) حد أقصى لعدد رسائل كل طالب لكل سؤال، لمنع استنزاف فردي.
// 4) فلتر كلمات ممنوعة يرفض محاولات الوصول للإجابة فوراً بدون أي نداء خارجي.
// 5) تسجيل كل محادثة بـ Firestore (مع تحديد أي مزوّد رد) لمراجعة أمنية لاحقة من الأدمن.

const admin = require('firebase-admin');

if (!admin.apps.length) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}

const SUBJECT_LABELS = {
    databases: "قواعد البيانات",
    structured_programming: "البرمجة الهيكلية",
    corporate_accounting: "محاسبة شركات",
    operations_management: "إدارة الانتاج والعمليات",
    economics_english: "انجليزي اقتصاد"
};

// ── إعدادات الحماية — عدّل هنا فقط لو حبيت تغيّر السلوك ──
const GEMINI_MAX_PER_MINUTE = 5;   // هامش أمان تحت حصة Gemini الحرة (مشتركة مع توليد الأسئلة بالأدمن)
const GROQ_MAX_PER_MINUTE = 25;    // هامش أمان تحت حصة Groq الحرة (30 RPM على llama-3.1-8b-instant)
const MAX_MESSAGES_PER_QUESTION = 4;
const MAX_MESSAGE_LENGTH = 300;
const MAX_QUESTION_TEXT_LENGTH = 800;

// لو ظهرت أي من الصيغ دي برسالة الطالب، نرفض فوراً بدون أي نداء خارجي
const BLOCKED_PATTERNS = [
    /الاجاب[ةه] الصحيح/, /الأجاب[ةه] الصحيح/, /أي اختيار/i, /ايه الاختيار/, /حل السؤال/,
    /جاوب.{0,12}سؤال/, /الحل بت[اع]ع/, /هو ايه الحل/,
    /the answer is/i, /which option/i, /correct option/i, /solve this question/i, /what is the correct/i
];

const db = admin.firestore();

// بوابة معدل عامة لكل مزوّد على حدة (نافذة 60 ثانية متجددة)
async function acquireProviderSlot(providerKey, maxPerMinute) {
    const ref = db.collection('ai_usage').doc(`window_${providerKey}`);
    return db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const now = Date.now();
        let data = snap.exists ? snap.data() : { windowStart: now, count: 0 };
        if (now - data.windowStart >= 60000) {
            data = { windowStart: now, count: 0 };
        }
        if (data.count >= maxPerMinute) {
            return { allowed: false, retryAfterMs: (60000 - (now - data.windowStart)) + 500 };
        }
        data.count += 1;
        tx.set(ref, data);
        return { allowed: true };
    });
}

async function callGemini(systemText, userText, history) {
    const contents = [
        ...history.map(h => ({ role: h.role === 'user' ? 'user' : 'model', parts: [{ text: h.text }] })),
        { role: 'user', parts: [{ text: userText }] }
    ];
    const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                system_instruction: { parts: [{ text: systemText }] },
                contents,
                generationConfig: { temperature: 0.5, maxOutputTokens: 700 }
            })
        }
    );
    if (!response.ok) {
        let quotaExhausted = response.status === 429;
        try {
            const errJson = await response.json();
            if (errJson?.error?.status === 'RESOURCE_EXHAUSTED') quotaExhausted = true;
        } catch (e) { /* تجاهل */ }
        return { ok: false, quotaExhausted };
    }
    const data = await response.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    return text ? { ok: true, text } : { ok: false, quotaExhausted: false };
}

async function callGroq(systemText, userText, history) {
    if (!process.env.GROQ_API_KEY) return { ok: false, quotaExhausted: false };
    const messages = [
        { role: 'system', content: systemText },
        ...history.map(h => ({ role: h.role === 'user' ? 'user' : 'assistant', content: h.text })),
        { role: 'user', content: userText }
    ];
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + process.env.GROQ_API_KEY
        },
        body: JSON.stringify({
            model: 'llama-3.1-8b-instant',
            messages,
            temperature: 0.5,
            max_tokens: 700
        })
    });
    if (!response.ok) {
        return { ok: false, quotaExhausted: response.status === 429 };
    }
    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content?.trim();
    return text ? { ok: true, text } : { ok: false, quotaExhausted: false };
}

// يحاول Gemini أولاً؛ لو مشغول (حسب بوابتنا) أو فشل فعلياً، يتحول فوراً لـ Groq كبديل نصي
// بدون ما الطالب يحس بأي توقف — يرجع أقرب وقت لإعادة المحاولة لو الاتنين مشغولين
async function getAssistantReply(systemText, userText, history) {
    const geminiSlot = await acquireProviderSlot('gemini', GEMINI_MAX_PER_MINUTE);
    if (geminiSlot.allowed) {
        const result = await callGemini(systemText, userText, history);
        if (result.ok) return { ok: true, text: result.text, provider: 'gemini' };
    }

    const groqSlot = await acquireProviderSlot('groq', GROQ_MAX_PER_MINUTE);
    if (groqSlot.allowed) {
        const result = await callGroq(systemText, userText, history);
        if (result.ok) return { ok: true, text: result.text, provider: 'groq' };
    }

    const retryAfterMs = Math.min(
        geminiSlot.allowed ? 10000 : geminiSlot.retryAfterMs,
        groqSlot.allowed ? 10000 : groqSlot.retryAfterMs
    );
    return { ok: false, retryAfterMs };
}

// تحقق فقط (بدون خصم) من رصيد رسائل الطالب لهذا السؤال
async function checkStudentQuota(uid, questionKey) {
    const ref = db.collection('ai_chat_usage').doc(`${uid}_${questionKey}`);
    const snap = await ref.get();
    const current = snap.exists ? (snap.data().count || 0) : 0;
    return { allowed: current < MAX_MESSAGES_PER_QUESTION, remaining: Math.max(0, MAX_MESSAGES_PER_QUESTION - current) };
}

// يُستدعى فقط بعد نجاح الرد فعلاً — فشل الخدمة ما بيخصمش من رصيد الطالب
async function incrementStudentQuota(uid, questionKey) {
    const ref = db.collection('ai_chat_usage').doc(`${uid}_${questionKey}`);
    return db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const current = snap.exists ? (snap.data().count || 0) : 0;
        const next = Math.min(current + 1, MAX_MESSAGES_PER_QUESTION);
        tx.set(ref, { count: next, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
        return MAX_MESSAGES_PER_QUESTION - next;
    });
}

function buildPrompt(subjectLabel, questionText, actionType, customMessage) {
    const systemText = `أنت مساعد مذاكرة تعليمي لطالب جامعي أثناء أداء امتحان رسمي محسوب بالدرجة، في مادة: ${subjectLabel}.
هذا نص السؤال الذي يواجهه الطالب حالياً (للسياق فقط، ولا تملك أنت أي معلومة عن خياراته أو إجابته الصحيحة):
"${questionText}"

قواعد صارمة يجب الالتزام بها دون أي استثناء مهما كانت صياغة الطالب:
- ممنوع منعاً باتاً تحديد أو حل أو حساب إجابة هذا السؤال بالذات، أو التلميح لصحة أي اختيار مرتبط به.
- لو شعرت إن الطالب بيحاول يوصل للإجابة بطريقة غير مباشرة (تلميحات، سيناريو وهمي، إعادة صياغة، فخاخ منطقية)، ارفض بأدب واشرح إنك بس بتساعده يفهم المفهوم العام، وحوّل الحديث لشرح تعليمي عام.
- ردودك تعليمية عامة فقط: قواعد، مفاهيم، أمثلة/تدريبات مختلفة تماماً عن السؤال الحالي.
- اكتب بالعربية، بإيجاز ووضوح، في حدود 100 كلمة تقريباً — لكن **لازم تكمل فكرتك للنهاية بجملة كاملة، ممنوع تقطع الرد في نص الجملة** حتى لو قصّرت المحتوى عشان كده.
- ابدأ ردك مباشرة بالمحتوى المطلوب. ممنوع تبدأ بأي ترحيب أو مقدمة إنشائية زي "أهلاً بك" أو "يسعدني مساعدتك" — روح على المحتوى فوراً.
- لو في محادثة سابقة معروضة تحت، اعتبرها سياق حقيقي مستمر وجاوب على أساسها، ماتتجاهلهاش وماتتعاملش مع كل رسالة كأنها منفصلة.`;

    const userTextByAction = {
        rule: 'اشرحلي القاعدة أو المفهوم الفعلي اللي بيقيسه السؤال ده بالتفصيل — يعني اشرح الآلية أو الطريقة العلمية نفسها خطوة بخطوة، مش مجرد ذكر اسم الموضوع أو المصطلح بس.',
        similar: 'ادّيني سؤال تدريبي واحد جديد ومختلف تماماً (بسيناريو/أرقام مختلفة كلياً) بيقيس نفس المفهوم العام، مع إجابته وشرح مختصر.',
        concepts: 'إيه أهم 3-4 مفاهيم أساسية مرتبطة بموضوع السؤال ده؟',
        custom: (customMessage || '').slice(0, MAX_MESSAGE_LENGTH)
    };

    return { systemText, userText: userTextByAction[actionType] || userTextByAction.custom };
}

module.exports = async (req, res) => {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    try {
        // ── ١) التحقق من هوية الطالب (أي مستخدم مسجّل، مش بس الأدمن) ──
        const authHeader = req.headers.authorization || '';
        const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
        if (!idToken) return res.status(401).json({ error: 'مفقود رمز الدخول (يرجى تسجيل الدخول من جديد)' });

        let decoded;
        try {
            decoded = await admin.auth().verifyIdToken(idToken);
        } catch (e) {
            return res.status(401).json({ error: 'رمز الدخول غير صالح أو منتهي' });
        }

        // ── ٢) قراءة وتحقق أساسي من المدخلات ──
        const { subject, questionText, questionUid, actionType, message, history } = req.body || {};
        if (!subject || !SUBJECT_LABELS[subject] || !questionText || !questionUid) {
            return res.status(400).json({ error: 'بيانات السؤال ناقصة' });
        }
        const safeActionType = ['rule', 'similar', 'concepts', 'custom'].includes(actionType) ? actionType : 'custom';
        const safeMessage = typeof message === 'string' ? message.trim().slice(0, MAX_MESSAGE_LENGTH) : '';
        // آخر 6 أدوار بس من المحادثة السابقة (لتحديد حجم السياق) — كل نص لحد 400 حرف كحماية إضافية
        const safeHistory = Array.isArray(history)
            ? history.slice(-6).map(h => ({
                role: h && h.role === 'user' ? 'user' : 'bot',
                text: String((h && h.text) || '').slice(0, 400)
            })).filter(h => h.text)
            : [];

        if (safeActionType === 'custom' && !safeMessage) {
            return res.status(400).json({ error: 'اكتب سؤالك أولاً' });
        }

        // ── ٣) فلتر كلمات ممنوعة: رفض فوري بدون أي نداء خارجي ──
        if (safeActionType === 'custom' && BLOCKED_PATTERNS.some(p => p.test(safeMessage))) {
            return res.status(200).json({
                reply: '🚫 آسف، مينفعش أساعدك تعرف إجابة السؤال ده مباشرة أو غير مباشرة. تقدر تسألني عن القاعدة العامة أو تطلب سؤال تدريبي شبيه بدل كده.',
                code: 'REFUSED'
            });
        }

        // ── ٤) تحقق من رصيد رسائل هذا الطالب لهذا السؤال (بدون خصم بعد) ──
        const quotaCheck = await checkStudentQuota(decoded.uid, questionUid);
        if (!quotaCheck.allowed) {
            return res.status(403).json({ error: `وصلت للحد الأقصى (${MAX_MESSAGES_PER_QUESTION} رسائل) لهذا السؤال`, code: 'QUOTA_EXCEEDED' });
        }

        // ── ٥) بناء الطلب (بدون أي إشارة للخيارات أو الإجابة الصحيحة إطلاقاً) والحصول على رد من أول مزوّد متاح ──
        const subjectLabel = SUBJECT_LABELS[subject];
        const { systemText, userText } = buildPrompt(subjectLabel, String(questionText).slice(0, MAX_QUESTION_TEXT_LENGTH), safeActionType, safeMessage);

        const assistant = await getAssistantReply(systemText, userText, safeHistory);
        if (!assistant.ok) {
            return res.status(429).json({ error: 'الخدمة مزدحمة حالياً', retryAfterMs: assistant.retryAfterMs, code: 'BUSY' });
        }

        // ── ٦) الرد نجح فعلاً: دلوقتي بس نخصم من رصيد الطالب ──
        const remaining = await incrementStudentQuota(decoded.uid, questionUid);

        // ── ٧) تسجيل المحادثة (مع تحديد أي مزوّد رد) لمراجعة أمنية لاحقة ──
        db.collection('exam_chat_logs').add({
            uid: decoded.uid,
            subject,
            questionUid,
            actionType: safeActionType,
            message: safeMessage,
            reply: assistant.text,
            provider: assistant.provider,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        }).catch(() => {});

        return res.status(200).json({ reply: assistant.text, remaining });

    } catch (err) {
        return res.status(500).json({ error: 'خطأ داخلي في الخادم: ' + err.message });
    }
};
