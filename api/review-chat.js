// /api/review-chat.js
// Vercel Serverless Function — مساعد مذاكرة بالذكاء الاصطناعي في صفحة المراجعة (بعد تسليم الامتحان).
//
// بخلاف مساعد الامتحان الحي (اتحذف نهائياً)، هنا لا يوجد أي قيد على الإجابة —
// السؤال اتقيّم فعلاً والدرجة اتسجلت، فمفيش أي خطر غش. المساعد يقدر يشرح الإجابة الصحيحة
// بالتفصيل، يقول ليه اختيار الطالب كان صح أو غلط، ويقترح أسئلة تدريبية بإجاباتها كاملة.
//
// اللي فضل من التصميم القديم (لأسباب تشغيلية بحتة، مش أمنية):
// 1) Gemini أولاً، وتحويل تلقائي فوري لـ Groq لو مشغول/فشل — بدون ما الطالب يحس بأي توقف.
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
                generationConfig: { temperature: 0.6, maxOutputTokens: 700 }
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
- اكتب بالعربية، بوضوح وبإيجاز مناسب — لكن لازم تكمل فكرتك للنهاية بجملة كاملة، ممنوع تقطع الرد في نص الجملة حتى لو قصّرت المحتوى عشان كده.
- ابدأ ردك مباشرة بالمحتوى المطلوب، من غير أي ترحيب أو مقدمة إنشائية زي "أهلاً بك".
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
