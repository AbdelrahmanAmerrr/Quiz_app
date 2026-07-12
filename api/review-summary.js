// /api/review-summary.js
// Vercel Serverless Function — تحليل شامل لأداء الطالب بعد الامتحان: أضعف المفاهيم + توصية للمذاكرة.
//
// بيحلل كل الإجابات الخاطئة في محاولة الامتحان دفعة واحدة (نداء واحد بس مهما كان عدد الأسئلة الخطأ)،
// عكس شات المراجعة اللي بيشتغل سؤال بسؤال. نفس بنية الحماية التشغيلية (Gemini→Groq→Cerebras + حصة يومية للطالب).

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

const GEMINI_MAX_PER_MINUTE = 5;
const GROQ_MAX_PER_MINUTE = 25;
const CEREBRAS_MAX_PER_MINUTE = 4;
const MAX_WRONG_QUESTIONS = 30;       // حماية حجم الطلب — نادراً امتحان فيه أكتر من كده غلط
const MAX_SUMMARIES_PER_DAY = 3;      // لكل طالب لكل مادة يومياً
// ✅ [جديد] شرح مفهوم منفرد من نتيجة تحليل الأداء — أخف بكتير من التحليل الكامل، حصة يومية أكبر
const MAX_TOPIC_EXPLANATIONS_PER_DAY = 6;
const MAX_TOPIC_LABEL_LENGTH = 120;
// ✅ [FIX] نفس مشكلة القطع اللي اتصلحت في شات المراجعة — كانت هنا لسه بلا أي حماية خالص
const ANALYZE_MAX_TOKENS      = 900;  // رُفع من 700 — الـJSON محتاج مساحة أكتر لضمان إغلاقه صح
const EXPLAIN_TOPIC_MAX_TOKENS = 600;
const RETRY_TEXT_MAX_TOKENS    = 200; // سقف منخفض فعلي لإعادة المحاولة النصية — يجبر الإيجاز الحقيقي

const db = admin.firestore();

async function acquireProviderSlot(providerKey, maxPerMinute) {
    const ref = db.collection('ai_usage').doc(`window_${providerKey}`);
    return db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const now = Date.now();
        let data = snap.exists ? snap.data() : { windowStart: now, count: 0 };
        if (now - data.windowStart >= 60000) data = { windowStart: now, count: 0 };
        if (data.count >= maxPerMinute) {
            return { allowed: false, retryAfterMs: (60000 - (now - data.windowStart)) + 500 };
        }
        data.count += 1;
        tx.set(ref, data);
        return { allowed: true };
    });
}

async function callGemini(systemText, userText, maxTokens) {
    const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                system_instruction: { parts: [{ text: systemText }] },
                contents: [{ parts: [{ text: userText }] }],
                generationConfig: { temperature: 0.4, maxOutputTokens: maxTokens }
            })
        }
    );
    if (!response.ok) return { ok: false };
    const data = await response.json();
    const candidate = data?.candidates?.[0];
    const text = candidate?.content?.parts?.[0]?.text?.trim();
    const truncated = candidate?.finishReason === 'MAX_TOKENS';
    return text ? { ok: true, text, truncated } : { ok: false };
}

async function callGroq(systemText, userText, maxTokens) {
    if (!process.env.GROQ_API_KEY) return { ok: false };
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + process.env.GROQ_API_KEY },
        body: JSON.stringify({
            model: 'llama-3.3-70b-versatile',
            messages: [{ role: 'system', content: systemText }, { role: 'user', content: userText }],
            temperature: 0.4,
            max_tokens: maxTokens
        })
    });
    if (!response.ok) return { ok: false };
    const data = await response.json();
    const choice = data?.choices?.[0];
    const text = choice?.message?.content?.trim();
    const truncated = choice?.finish_reason === 'length';
    return text ? { ok: true, text, truncated } : { ok: false };
}

async function callCerebras(systemText, userText, maxTokens) {
    if (!process.env.CEREBRAS_API_KEY) return { ok: false };
    const response = await fetch('https://api.cerebras.ai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + process.env.CEREBRAS_API_KEY },
        body: JSON.stringify({
            model: 'gpt-oss-120b',
            messages: [{ role: 'system', content: systemText }, { role: 'user', content: userText }],
            temperature: 0.4,
            max_tokens: maxTokens
        })
    });
    if (!response.ok) return { ok: false };
    const data = await response.json();
    const choice = data?.choices?.[0];
    const text = choice?.message?.content?.trim();
    const truncated = choice?.finish_reason === 'length';
    return text ? { ok: true, text, truncated } : { ok: false };
}

// ✅ [FIX] لو أول محاولة اتقطعت فعلياً، نعيد نداء واحد بس بطلب أقصر — مدرك لنوع الرد (JSON أو نص عادي)
// عشان طلب "اختصر" ميكسرش صيغة الـJSON لو المطلوب تحليل شامل
async function _callWithTruncationRetry(callFn, systemText, userText, maxTokens, isJsonMode) {
    const first = await callFn(systemText, userText, maxTokens);
    if (!first.ok || !first.truncated) return first;

    const stricterUserText = isJsonMode
        ? userText + '\n\n(تنبيه: ردك السابق اتقطع قبل ما يكتمل الـJSON. أعد نفس الطلب بالظبط، لكن اجعل عدد weakTopics أقل (2 بس) والعبارات والتوصية أقصر ما يمكن، مع الحفاظ التام على صيغة JSON صحيحة وكاملة ومغلقة بالكامل.)'
        : userText + '\n\n(تنبيه: ردك السابق كان طويل قوي واتقطع. اختصر جداً جداً هذه المرة مع الحفاظ على قفل الفكرة بنقطة واضحة.)';
    const retryMaxTokens = isJsonMode ? maxTokens : RETRY_TEXT_MAX_TOKENS;
    const retry = await callFn(systemText, stricterUserText, retryMaxTokens);
    return (retry.ok) ? retry : first;
}

function _logDailyAiUsage(provider) {
    const dateStr = new Date().toISOString().slice(0, 10);
    db.collection('ai_daily_stats').doc(`${dateStr}_${provider}`).set({
        date: dateStr, provider, count: admin.firestore.FieldValue.increment(1)
    }, { merge: true }).catch(() => {});
}

async function getAssistantReply(systemText, userText, maxTokens, isJsonMode) {
    const geminiSlot = await acquireProviderSlot('gemini', GEMINI_MAX_PER_MINUTE);
    if (geminiSlot.allowed) {
        const result = await _callWithTruncationRetry(callGemini, systemText, userText, maxTokens, isJsonMode);
        if (result.ok) { _logDailyAiUsage('gemini'); return { ok: true, text: result.text }; }
    }
    const groqSlot = await acquireProviderSlot('groq', GROQ_MAX_PER_MINUTE);
    if (groqSlot.allowed) {
        const result = await _callWithTruncationRetry(callGroq, systemText, userText, maxTokens, isJsonMode);
        if (result.ok) { _logDailyAiUsage('groq'); return { ok: true, text: result.text }; }
    }
    const cerebrasSlot = await acquireProviderSlot('cerebras', CEREBRAS_MAX_PER_MINUTE);
    if (cerebrasSlot.allowed) {
        const result = await _callWithTruncationRetry(callCerebras, systemText, userText, maxTokens, isJsonMode);
        if (result.ok) { _logDailyAiUsage('cerebras'); return { ok: true, text: result.text }; }
    }
    _logDailyAiUsage('busy');
    const retryAfterMs = Math.min(
        geminiSlot.allowed ? 10000 : geminiSlot.retryAfterMs,
        groqSlot.allowed ? 10000 : groqSlot.retryAfterMs,
        cerebrasSlot.allowed ? 10000 : cerebrasSlot.retryAfterMs
    );
    return { ok: false, retryAfterMs };
}

// يحاول تحليل رد النموذج كـJSON ملخص صالح
// ✅ [FIX] بقت أكثر تسامحاً: لو فيه نص زيادة قبل/بعد الـJSON (شائع مع بعض النماذج)، نستخرج الجزء بين أول { وآخر }
function _parseSummaryJson(rawText) {
    try {
        let cleaned = String(rawText || '').replace(/```json|```/g, '').trim();
        const firstBrace = cleaned.indexOf('{');
        const lastBrace  = cleaned.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace > firstBrace) {
            cleaned = cleaned.slice(firstBrace, lastBrace + 1);
        }
        const s = JSON.parse(cleaned);
        if (s && Array.isArray(s.weakTopics) && typeof s.recommendation === 'string' && s.weakTopics.length > 0) {
            return {
                weakTopics: s.weakTopics.slice(0, 6).map(t => String(t).trim().slice(0, 120)).filter(Boolean),
                recommendation: s.recommendation.trim().slice(0, 400)
            };
        }
    } catch (e) { /* رد مش JSON صالح */ }
    return null;
}

// ✅ [FIX] ترجيع حصة الطالب لو فشل التوليد فعلياً بعد ما كانت اتخصمت مقدماً —
// عشان فشل تقني ميكلفش الطالب واحدة من تحليلاته/شروحاته المحدودة يومياً
function _refundQuota(collectionName, uid, subject) {
    const dateStr = new Date().toISOString().slice(0, 10);
    db.collection(collectionName).doc(`${uid}_${subject}_${dateStr}`).set({
        count: admin.firestore.FieldValue.increment(-1)
    }, { merge: true }).catch(() => {});
}

async function checkAndConsumeSummaryQuota(uid, subject) {
    const dateStr = new Date().toISOString().slice(0, 10);
    const ref = db.collection('review_summary_usage').doc(`${uid}_${subject}_${dateStr}`);
    return db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const current = snap.exists ? (snap.data().count || 0) : 0;
        if (current >= MAX_SUMMARIES_PER_DAY) return { allowed: false };
        tx.set(ref, { count: current + 1, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
        return { allowed: true };
    });
}

// ✅ [جديد] حصة يومية منفصلة لشرح المفاهيم المنفردة — أخف من التحليل الكامل فحصتها أكبر
async function checkAndConsumeTopicExplainQuota(uid, subject) {
    const dateStr = new Date().toISOString().slice(0, 10);
    const ref = db.collection('topic_explain_usage').doc(`${uid}_${subject}_${dateStr}`);
    return db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const current = snap.exists ? (snap.data().count || 0) : 0;
        if (current >= MAX_TOPIC_EXPLANATIONS_PER_DAY) return { allowed: false };
        tx.set(ref, { count: current + 1, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
        return { allowed: true };
    });
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

        const { subject, wrongQuestions, mode, topic } = req.body || {};
        if (!subject || !SUBJECT_LABELS[subject]) {
            return res.status(400).json({ error: 'بيانات ناقصة — المادة مطلوبة' });
        }

        const subjectLabel = SUBJECT_LABELS[subject];

        // ✅ [جديد] مسار شرح مفهوم منفرد — مستقل تماماً عن التحليل الكامل، وله حصته اليومية الخاصة
        if (mode === 'explainTopic') {
            const safeTopic = typeof topic === 'string' ? topic.trim().slice(0, MAX_TOPIC_LABEL_LENGTH) : '';
            if (!safeTopic || !Array.isArray(wrongQuestions) || wrongQuestions.length === 0) {
                return res.status(400).json({ error: 'بيانات ناقصة — المفهوم والأسئلة المرتبطة به مطلوبة' });
            }

            const quota = await checkAndConsumeTopicExplainQuota(decoded.uid, subject);
            if (!quota.allowed) {
                return res.status(403).json({ error: `وصلت للحد الأقصى (${MAX_TOPIC_EXPLANATIONS_PER_DAY} شروحات) لهذه المادة اليوم`, code: 'QUOTA_EXCEEDED' });
            }

            const safeQuestions = wrongQuestions.slice(0, MAX_WRONG_QUESTIONS).map(q => ({
                question:      String(q.question || '').slice(0, 300),
                studentAnswer: String(q.studentAnswer || '').slice(0, 150),
                correctAnswer: String(q.correctAnswer || '').slice(0, 150)
            }));
            const questionsList = safeQuestions.map((q, i) =>
                `${i + 1}. السؤال: ${q.question} | إجابة الطالب: ${q.studentAnswer} | الصحيحة: ${q.correctAnswer}`
            ).join('\n');

            const systemText = `أنت مساعد مذاكرة لطالب جامعي في مادة: ${subjectLabel}.
الطالب غلط في أسئلة تتعلق بمفهوم "${safeTopic}" في امتحان أخير. دي الأسئلة اللي غلط فيها:
${questionsList}

المطلوب: اشرح مفهوم "${safeTopic}" تحديداً بوضوح ومباشرة، مستخدماً الأسئلة اللي فوق كأمثلة توضيحية لربط الشرح بواقع أخطائه (من غير ما تكرر نص الأسئلة حرفياً).
- ابدأ من أول كلمة بالشرح مباشرة، من غير أي مقدمة زي "سأشرح لك" أو "بالتأكيد".
- الرد كله في حدود 5-7 جمل قصار بالمظبوط، مش أكتر.
- ممنوع أي تنسيق Markdown (لا ** ولا # ولا شرطات).
- رد نصي عادي بس، من غير أي JSON أو علامات تنسيق.`;

            const assistant = await getAssistantReply(systemText, `اشرح مفهوم "${safeTopic}" الآن.`, EXPLAIN_TOPIC_MAX_TOKENS, false);
            if (!assistant.ok) {
                _refundQuota('topic_explain_usage', decoded.uid, subject);
                return res.status(429).json({ error: 'الخدمة مزدحمة حالياً', retryAfterMs: assistant.retryAfterMs, code: 'BUSY' });
            }

            return res.status(200).json({ explanation: assistant.text.trim() });
        }

        // ── المسار الأصلي: تحليل شامل لكل الإجابات الخاطئة ──
        if (!Array.isArray(wrongQuestions) || wrongQuestions.length === 0) {
            return res.status(400).json({ error: 'بيانات ناقصة — محتاج على الأقل سؤال واحد خطأ لتحليله' });
        }

        const quota = await checkAndConsumeSummaryQuota(decoded.uid, subject);
        if (!quota.allowed) {
            return res.status(403).json({ error: `وصلت للحد الأقصى (${MAX_SUMMARIES_PER_DAY} تحليلات) لهذه المادة اليوم`, code: 'QUOTA_EXCEEDED' });
        }

        const safeQuestions = wrongQuestions.slice(0, MAX_WRONG_QUESTIONS).map(q => ({
            question: String(q.question || '').slice(0, 300),
            studentAnswer: String(q.studentAnswer || '').slice(0, 150),
            correctAnswer: String(q.correctAnswer || '').slice(0, 150)
        }));

        const questionsList = safeQuestions.map((q, i) =>
            `${i + 1}. السؤال: ${q.question} | إجابة الطالب: ${q.studentAnswer} | الصحيحة: ${q.correctAnswer}`
        ).join('\n');

        const systemText = `أنت محلل أداء تعليمي لطالب جامعي في مادة: ${subjectLabel}.
دي كل الأسئلة اللي الطالب أجاب عليها غلط في امتحان واحد:
${questionsList}

المطلوب: حلل الأنماط في الأخطاء دي وحدد أهم المفاهيم الضعيفة (مش سؤال سؤال، لكن مواضيع/مفاهيم متكررة تظهر من مجموع الأخطاء)، مع توصية عملية مختصرة للمذاكرة.
- ممنوع أي تنسيق Markdown (لا ** ولا # ولا شرطات).
- weakTopics: من 2 إلى 5 عناصر بس، كل عنصر عبارة قصيرة (4-8 كلمات) تسمي مفهوم أو موضوع ضعيف، مش جملة كاملة.
- recommendation: توصية عملية واحدة مختصرة (جملتين بالكتير) تقول للطالب يركز على إيه بالتحديد الأسبوع الجاي.
- أعد الإجابة بصيغة JSON فقط بدون أي نص حواليها وبدون backticks، بالضبط بهذا الشكل:
{"weakTopics":["...","..."],"recommendation":"..."}`;

        const assistant = await getAssistantReply(systemText, 'حلل أخطائي الآن.', ANALYZE_MAX_TOKENS, true);
        if (!assistant.ok) {
            _refundQuota('review_summary_usage', decoded.uid, subject);
            return res.status(429).json({ error: 'الخدمة مزدحمة حالياً', retryAfterMs: assistant.retryAfterMs, code: 'BUSY' });
        }

        const summary = _parseSummaryJson(assistant.text);
        if (!summary) {
            _refundQuota('review_summary_usage', decoded.uid, subject);
            return res.status(502).json({ error: 'تعذّر تحليل الرد، جرّب تاني بعد شوية' });
        }

        return res.status(200).json({ summary });

    } catch (err) {
        return res.status(500).json({ error: 'خطأ داخلي في الخادم: ' + err.message });
    }
};
