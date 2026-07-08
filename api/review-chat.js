// /api/review-chat.js
// Vercel Serverless Function — مساعد مذاكرة بالذكاء الاصطناعي في صفحة المراجعة (بعد تسليم الامتحان).
//
// بخلاف مساعد الامتحان الحي (اتحذف نهائياً)، هنا لا يوجد أي قيد على الإجابة —
// السؤال اتقيّم فعلاً والدرجة اتسجلت، فمفيش أي خطر غش. المساعد يقدر يشرح الإجابة الصحيحة
// بالتفصيل، يقول ليه اختيار الطالب كان صح أو غلط، ويقترح أسئلة تدريبية بإجاباتها كاملة.
//
// اللي فضل من التصميم القديم (لأسباب تشغيلية بحتة، مش أمنية):
// 1) Gemini أولاً، وتحويل تلقائي فوري لـ Groq ثم Cerebras لو الاتنين مشغولين/فشلوا — بدون ما الطالب يحس بأي توقف.
// 2) حد أقصى لعدد رسائل كل طالب لكل سؤال — يحمي الحصة المجانية المشتركة من الاستنزاف.
// 3) سياق محادثة (آخر 6 أدوار) — عشان المتابعات تتفهم صح.
// 4) تسجيل كل محادثة بـ Firestore لمراجعة لاحقة لو حبيت.

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

// ── إعدادات الحماية التشغيلية (حماية حصة API، مش قيود أمنية) ──
const GEMINI_MAX_PER_MINUTE = 5;
const GROQ_MAX_PER_MINUTE = 25;
const CEREBRAS_MAX_PER_MINUTE = 4; // التوثيق الرسمي الأحدث (يونيو 2026) يقول 5 طلبات/دقيقة فقط — هامش أمان تحتها
const MAX_MESSAGES_PER_QUESTION = 4;
const MAX_MESSAGE_LENGTH = 300;
const MAX_QUESTION_TEXT_LENGTH = 800;
const MAX_OPTION_LENGTH = 200;

const db = admin.firestore();

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
                generationConfig: { temperature: 0.6, maxOutputTokens: 350 }
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
            temperature: 0.6,
            max_tokens: 350
        })
    });
    if (!response.ok) {
        return { ok: false, quotaExhausted: response.status === 429 };
    }
    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content?.trim();
    return text ? { ok: true, text } : { ok: false, quotaExhausted: false };
}

// مزوّد ثالث احتياطي — Cerebras (متوافق مع OpenAI). حصته اليومية كبيرة (مليون توكن) لكن معدلها بالدقيقة صغير،
// فبييجي كخط دفاع ثالث بعد Gemini وGroq مش بديل أساسي عنهم.
async function callCerebras(systemText, userText, history) {
    if (!process.env.CEREBRAS_API_KEY) return { ok: false, quotaExhausted: false };
    const messages = [
        { role: 'system', content: systemText },
        ...history.map(h => ({ role: h.role === 'user' ? 'user' : 'assistant', content: h.text })),
        { role: 'user', content: userText }
    ];
    const response = await fetch('https://api.cerebras.ai/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + process.env.CEREBRAS_API_KEY
        },
        body: JSON.stringify({
            model: 'gpt-oss-120b',
            messages,
            temperature: 0.6,
            max_tokens: 350
        })
    });
    if (!response.ok) {
        return { ok: false, quotaExhausted: response.status === 429 };
    }
    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content?.trim();
    return text ? { ok: true, text } : { ok: false, quotaExhausted: false };
}

// يسجّل عداد يومي خفيف جداً (كتابة increment وحيدة، بدون أي قراءة) — تغذي لوحة مراقبة الاستهلاك بالأدمن فقط
function _logDailyAiUsage(provider) {
    const dateStr = new Date().toISOString().slice(0, 10);
    const docId = `${dateStr}_${provider}`;
    db.collection('ai_daily_stats').doc(docId).set({
        date: dateStr,
        provider,
        count: admin.firestore.FieldValue.increment(1)
    }, { merge: true }).catch(() => {});
}

// خط دفاع ثاني بعد البرومبت — حتى لو النموذج خالف التعليمات:
// (أ) يشيل أي رموز Markdown متسربة (** # -) لأن واجهتنا بتعرض نص عادي بس
// (ب) لو الرد اتقطع في نص جملة، يقصّه عند آخر علامة نهاية جملة كاملة بدل ما يسيب جملة معلّقة
function _sanitizeAssistantText(text) {
    if (!text) return text;
    let cleaned = text
        .replace(/\*\*/g, '')
        .replace(/^#{1,6}\s*/gm, '')
        .replace(/^[-•]\s*/gm, '');

    cleaned = cleaned.trim();
    const enders = ['.', '؟', '!', '؛'];
    if (!enders.some(e => cleaned.endsWith(e)) && !cleaned.endsWith('\n')) {
        let lastIdx = -1;
        for (const e of enders) {
            const idx = cleaned.lastIndexOf(e);
            if (idx > lastIdx) lastIdx = idx;
        }
        // نقص بس لو هيفضل جزء معقول من الرد (مش هنبتره لحجم صغير جداً)
        if (lastIdx > 40) cleaned = cleaned.slice(0, lastIdx + 1);
    }
    return cleaned;
}

async function getAssistantReply(systemText, userText, history) {
    const geminiSlot = await acquireProviderSlot('gemini', GEMINI_MAX_PER_MINUTE);
    if (geminiSlot.allowed) {
        const result = await callGemini(systemText, userText, history);
        if (result.ok) { _logDailyAiUsage('gemini'); return { ok: true, text: result.text, provider: 'gemini' }; }
    }

    const groqSlot = await acquireProviderSlot('groq', GROQ_MAX_PER_MINUTE);
    if (groqSlot.allowed) {
        const result = await callGroq(systemText, userText, history);
        if (result.ok) { _logDailyAiUsage('groq'); return { ok: true, text: result.text, provider: 'groq' }; }
    }

    const cerebrasSlot = await acquireProviderSlot('cerebras', CEREBRAS_MAX_PER_MINUTE);
    if (cerebrasSlot.allowed) {
        const result = await callCerebras(systemText, userText, history);
        if (result.ok) { _logDailyAiUsage('cerebras'); return { ok: true, text: result.text, provider: 'cerebras' }; }
    }

    _logDailyAiUsage('busy');
    const retryAfterMs = Math.min(
        geminiSlot.allowed ? 10000 : geminiSlot.retryAfterMs,
        groqSlot.allowed ? 10000 : groqSlot.retryAfterMs,
        cerebrasSlot.allowed ? 10000 : cerebrasSlot.retryAfterMs
    );
    return { ok: false, retryAfterMs };
}

async function checkStudentQuota(uid, questionKey) {
    const ref = db.collection('review_chat_usage').doc(`${uid}_${questionKey}`);
    const snap = await ref.get();
    const current = snap.exists ? (snap.data().count || 0) : 0;
    return { allowed: current < MAX_MESSAGES_PER_QUESTION, remaining: Math.max(0, MAX_MESSAGES_PER_QUESTION - current) };
}

async function incrementStudentQuota(uid, questionKey) {
    const ref = db.collection('review_chat_usage').doc(`${uid}_${questionKey}`);
    return db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const current = snap.exists ? (snap.data().count || 0) : 0;
        const next = Math.min(current + 1, MAX_MESSAGES_PER_QUESTION);
        tx.set(ref, { count: next, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
        return MAX_MESSAGES_PER_QUESTION - next;
    });
}

// يبني تعليمات مساعد غير مقيّد — عنده كل السياق (السؤال، الخيارات، إجابة الطالب، الإجابة الصحيحة، الشرح)
function buildPrompt(subjectLabel, questionText, options, studentAnswer, correctAnswer, explanation, actionType, customMessage) {
    const optionsList = (options || []).map((o, idx) => `${idx + 1}. ${o}`).join('\n');

    const systemText = `أنت مساعد مذاكرة تعليمي لطالب جامعي في مادة: ${subjectLabel}، في صفحة مراجعة الأسئلة **بعد** تسليم الامتحان وتسجيل الدرجة نهائياً.
السؤال: "${questionText}"
الخيارات:
${optionsList || '(سؤال صح/خطأ أو بدون خيارات متعددة مذكورة)'}
إجابة الطالب: "${studentAnswer}"
الإجابة الصحيحة: "${correctAnswer}"
الشرح المتوفر بالنظام: "${explanation || 'لا يوجد شرح مسجّل'}"

تعليمات:
- الامتحان خلص والدرجة اتسجلت، فمن المقبول تماماً تناقش الإجابة الصحيحة بالتفصيل وتقول ليه إجابة الطالب كانت صح أو غلط.
- هدفك تعليمي بحت: افهيمه المفهوم كويس، وضّح أي لبس، واقترح أمثلة أو أسئلة تدريبية بإجاباتها كاملة لو طلب.
- ممنوع منعاً باتاً أي مقدمة أو عبارة تمهيدية قبل المحتوى الفعلي — لا تبدأ الرد بعبارات زي: "سأوضح لك"، "إليك سؤال تدريبي جديد"، "تمام"، "بالتأكيد"، "حسناً"، "إليك الشرح"، أو أي صيغة مشابهة. ابدأ من أول كلمة بالمحتوى المطلوب نفسه مباشرة (مثال: لو المطلوب شرح ليه الإجابة غلط، ابدأ فوراً بـ"الإجابة الصحيحة هي كذا لأن..." من غير أي تمهيد قبلها).
- ممنوع كمان تشرح خلفية عامة عن الموضوع قبل ما توصل للمطلوب (زي "لفهم السؤال بشكل كامل، يجب أولاً توضيح مفهوم كذا..."). جاوب على المطلوب بالتحديد فوراً، من غير تمهيد نظري.
- ممنوع منعاً باتاً أي تنسيق Markdown إطلاقاً: لا نجوم ** للخط العريض، لا علامات # للعناوين، لا شرطات - أو أرقام للنقاط الفرعية، لا فتح أقسام منفصلة زي "أولاً:" أو "لفهم السؤال:". اكتب فقرة نصية عادية متصلة بس، حتى لو المحتوى فيه أكتر من فكرة.
- الرد كله في حدود 3-4 جمل قصار بالمظبوط (تقريباً 50-70 كلمة)، مش أكتر خالص. لو حسيت إنك قربت من الحد وسط فكرة، اختصر فوراً واقفل الجملة، ولا تفتح فكرة جديدة أو مثال إضافي.
- اكتب بالعربية، وأكمل فكرتك للنهاية بجملة كاملة دايماً — ممنوع تقطع في نص الجملة.
- لو في محادثة سابقة معروضة تحت، اعتبرها سياق حقيقي مستمر وجاوب على أساسها.`;

    const userTextByAction = {
        explain: 'اشرحلي هذا السؤال بالتفصيل أكتر من الشرح المختصر المتاح — وضّح المفهوم كامل.',
        why: 'ليه إجابتي كانت صح أو غلط بالتحديد؟ اشرحلي منطق الإجابة الصحيحة مقارنة باللي اخترته.',
        similar: 'ادّيني سؤال تدريبي واحد جديد ومختلف (بسيناريو/أرقام مختلفة) بيقيس نفس المفهوم، مع إجابته الصحيحة وشرح مختصر.',
        custom: (customMessage || '').slice(0, MAX_MESSAGE_LENGTH)
    };

    return { systemText, userText: userTextByAction[actionType] || userTextByAction.custom };
}

module.exports = async (req, res) => {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    try {
        const authHeader = req.headers.authorization || '';
        const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
        if (!idToken) return res.status(401).json({ error: 'مفقود رمز الدخول (يرجى تسجيل الدخول من جديد)' });

        let decoded;
        try {
            decoded = await admin.auth().verifyIdToken(idToken);
        } catch (e) {
            return res.status(401).json({ error: 'رمز الدخول غير صالح أو منتهي' });
        }

        const {
            subject, questionUid, questionText, options,
            studentAnswer, correctAnswer, explanation,
            actionType, message, history
        } = req.body || {};

        if (!subject || !SUBJECT_LABELS[subject] || !questionText || !questionUid || !correctAnswer) {
            return res.status(400).json({ error: 'بيانات السؤال ناقصة' });
        }

        const safeActionType = ['explain', 'why', 'similar', 'custom'].includes(actionType) ? actionType : 'custom';
        const safeMessage = typeof message === 'string' ? message.trim().slice(0, MAX_MESSAGE_LENGTH) : '';
        if (safeActionType === 'custom' && !safeMessage) {
            return res.status(400).json({ error: 'اكتب سؤالك أولاً' });
        }

        const safeOptions = Array.isArray(options)
            ? options.slice(0, 6).map(o => String(o).slice(0, MAX_OPTION_LENGTH))
            : [];

        const safeHistory = Array.isArray(history)
            ? history.slice(-6).map(h => ({
                role: h && h.role === 'user' ? 'user' : 'bot',
                text: String((h && h.text) || '').slice(0, 400)
            })).filter(h => h.text)
            : [];

        // تحقق من رصيد الطالب لهذا السؤال (بدون خصم بعد)
        const quotaCheck = await checkStudentQuota(decoded.uid, questionUid);
        if (!quotaCheck.allowed) {
            return res.status(403).json({ error: `وصلت للحد الأقصى (${MAX_MESSAGES_PER_QUESTION} رسائل) لهذا السؤال`, code: 'QUOTA_EXCEEDED' });
        }

        const subjectLabel = SUBJECT_LABELS[subject];
        const { systemText, userText } = buildPrompt(
            subjectLabel,
            String(questionText).slice(0, MAX_QUESTION_TEXT_LENGTH),
            safeOptions,
            String(studentAnswer || '').slice(0, MAX_OPTION_LENGTH),
            String(correctAnswer).slice(0, MAX_OPTION_LENGTH),
            String(explanation || '').slice(0, 500),
            safeActionType,
            safeMessage
        );

        const assistant = await getAssistantReply(systemText, userText, safeHistory);
        if (!assistant.ok) {
            return res.status(429).json({ error: 'الخدمة مزدحمة حالياً', retryAfterMs: assistant.retryAfterMs, code: 'BUSY' });
        }
        assistant.text = _sanitizeAssistantText(assistant.text);

        const remaining = await incrementStudentQuota(decoded.uid, questionUid);

        db.collection('review_chat_logs').add({
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
