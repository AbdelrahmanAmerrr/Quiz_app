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
// ✅ [FIX] الـJSON بتاع السؤال التدريبي (سؤال + 4 خيارات + شرح) أطول من رد نصي عادي —
// كان بياخد نفس حد الـ600 توكن بتاع المحادثة العادية فبيتقطع أحياناً قبل ما يقفل الـJSON صح
const CONVERSATION_MAX_TOKENS = 800; // ✅ [FIX] رفعناها من 600 لتقليل احتمال القطع من الأساس
const SIMILAR_QUESTION_MAX_TOKENS = 1000;
// ✅ [FIX] إعادة المحاولة النصية (مش JSON) كانت بتاخد نفس سقف الـ800 توكن الأصلي —
// يعني حتى لو النموذج ما التزمش بطلب "جملة واحدة"، كان لسه ممكن يتقطع تاني عند نفس السقف الكبير.
// سقف منخفض هنا بيجبر رد قصير فعلياً بغض النظر عن مدى التزام النموذج بالتعليمة النصية.
const RETRY_TEXT_MAX_TOKENS = 180;
// ✅ [FIX] رد قصير جداً بشكل مريب لموضوع نصي عادي (زي "إجابة الطالب صحي") غالباً فشل صامت —
// النموذج بيقفل عادي (finishReason مايقولش "قطع") لكن المحتوى نفسه ناقص/مبتور فعلياً.
// نتعامل معاه كقطع حتى لو الإشارة الرسمية ماجتش، عشان نديله فرصة إعادة محاولة بدل ما نسيبه يعدي زي ما هو.
const MIN_VALID_TEXT_LENGTH = 35;

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

async function callGemini(systemText, userText, history, temperature, maxTokens) {
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
                generationConfig: { temperature, maxOutputTokens: maxTokens }
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
    const candidate = data?.candidates?.[0];
    const text = candidate?.content?.parts?.[0]?.text?.trim();
    const truncated = candidate?.finishReason === 'MAX_TOKENS';
    return text ? { ok: true, text, truncated } : { ok: false, quotaExhausted: false };
}

async function callGroq(systemText, userText, history, temperature, maxTokens) {
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
            model: 'llama-3.3-70b-versatile',
            messages,
            temperature,
            max_tokens: maxTokens
        })
    });
    if (!response.ok) {
        return { ok: false, quotaExhausted: response.status === 429 };
    }
    const data = await response.json();
    const choice = data?.choices?.[0];
    const text = choice?.message?.content?.trim();
    const truncated = choice?.finish_reason === 'length';
    return text ? { ok: true, text, truncated } : { ok: false, quotaExhausted: false };
}

// مزوّد ثالث احتياطي — Cerebras (متوافق مع OpenAI). حصته اليومية كبيرة (مليون توكن) لكن معدلها بالدقيقة صغير،
// فبييجي كخط دفاع ثالث بعد Gemini وGroq مش بديل أساسي عنهم.
async function callCerebras(systemText, userText, history, temperature, maxTokens) {
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
            temperature,
            max_tokens: maxTokens
        })
    });
    if (!response.ok) {
        return { ok: false, quotaExhausted: response.status === 429 };
    }
    const data = await response.json();
    const choice = data?.choices?.[0];
    const text = choice?.message?.content?.trim();
    const truncated = choice?.finish_reason === 'length';
    return text ? { ok: true, text, truncated } : { ok: false, quotaExhausted: false };
}

// لو أول محاولة اتقطعت فعلياً (مش تخمين — finishReason حقيقي من المزوّد نفسه)،
// نعيد نداء واحد بس لنفس المزوّد بطلب أقصر جداً عشان نضمن جملة كاملة بدل جملة مبتورة.
// ✅ [FIX] لما يكون المطلوب JSON (سؤال تدريبي)، ممنوع نطلب "اختصر لجملة واحدة" لأن ده بيكسر صيغة الـJSON —
// بدل كده نطلب تقصير حقول الـJSON نفسها مع الحفاظ على إغلاقه صح بالكامل.
async function _callWithTruncationRetry(callFn, systemText, userText, history, temperature, maxTokens, isJsonMode) {
    const first = await callFn(systemText, userText, history, temperature, maxTokens);
    if (!first.ok) return first;

    // ✅ [FIX] رد قصير جداً بشكل مريب لرد نصي عادي = فشل صامت، حتى لو finishReason مقالش "قطع" رسمياً
    const looksSuspiciouslyShort = !isJsonMode && first.text && first.text.trim().length < MIN_VALID_TEXT_LENGTH;
    if (!first.truncated && !looksSuspiciouslyShort) return first;

    const stricterUserText = isJsonMode
        ? userText + '\n\n(تنبيه: ردك السابق اتقطع قبل ما يكتمل الـJSON. أعد نفس الطلب بالظبط، لكن اجعل نص السؤال والشرح أقصر ما يمكن (أقل عدد كلمات ممكن)، مع الحفاظ التام على صيغة JSON صحيحة وكاملة ومغلقة بالكامل بلا أي قطع أو نص إضافي حواليها.)'
        : userText + '\n\n(تنبيه: ردك السابق كان ناقص أو قصير جداً بشكل غير مفيد. أعد المحاولة برد كامل ومفيد هذه المرة — جملة أو جملتين واضحتين على الأقل، تخلّص فكرة كاملة وتقفلها بنقطة.)';
    // ✅ [FIX] في وضع النص العادي، نفرض سقف توكنات منخفض فعلياً بدل ما نعتمد على التزام النموذج
    // بتعليمة "اختصر" وهو لسه شغال بنفس السقف الكبير القديم
    const retryMaxTokens = isJsonMode ? maxTokens : RETRY_TEXT_MAX_TOKENS;
    const retry = await callFn(systemText, stricterUserText, history, temperature, retryMaxTokens);
    return (retry.ok) ? retry : first;
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
// (ج) [FIX] لو بعد كل ده الرد فضل قصير جداً (قطع مبكر جداً، مش مجرد جملة أخيرة ناقصة)، نرفضه تماماً
// بدل ما نسيب جزء بلا معنى زي "إجابة الطالب صحي" يوصل للطالب أو يتخزن في الكاش المشترك
const MIN_VALID_REPLY_LENGTH = 30; // بالحروف تقريباً — أقل من كده يبقى الرد مش مفيد أصلاً
function _sanitizeAssistantText(text) {
    if (!text) return null;
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
        if (lastIdx > 40) {
            cleaned = cleaned.slice(0, lastIdx + 1);
        } else {
            // مفيش أي علامة ترقيم في الرد كله — نقطع عند آخر مسافة (آخر كلمة مكتملة) ونضيف "..."
            const lastSpace = cleaned.lastIndexOf(' ');
            if (lastSpace > 20) {
                cleaned = cleaned.slice(0, lastSpace).trim() + '...';
            }
        }
    }

    // ✅ [FIX] رد قصير جداً بعد كل المعالجة = فشل توليد حقيقي، مش رد صالح مختصر — نرفضه بدل ما نعرضه
    if (cleaned.replace(/\.\.\.$/, '').trim().length < MIN_VALID_REPLY_LENGTH) return null;

    return cleaned;
}

// يحاول تحليل رد النموذج كـJSON سؤال تدريبي صالح — يرجع null لو الشكل مش سليم (يتعامل معاه كنص عادي وقتها)
function _parseQuizJson(rawText) {
    try {
        const cleaned = String(rawText || '').replace(/```json|```/g, '').trim();
        const q = JSON.parse(cleaned);
        if (
            q && typeof q.question === 'string' && q.question.trim() &&
            Array.isArray(q.options) && q.options.length >= 2 && q.options.length <= 4 &&
            typeof q.answer === 'string' &&
            q.options.map(o => String(o).trim()).includes(q.answer.trim())
        ) {
            return {
                question: q.question.trim().slice(0, 500),
                options: q.options.map(o => String(o).trim().slice(0, 200)),
                answer: q.answer.trim(),
                explanation: typeof q.explanation === 'string' ? q.explanation.trim().slice(0, 400) : ''
            };
        }
    } catch (e) { /* رد مش JSON صالح — نرجع null ونتعامل معاه كنص عادي */ }
    return null;
}

async function getAssistantReply(systemText, userText, history, temperature, maxTokens, isJsonMode) {
    const geminiSlot = await acquireProviderSlot('gemini', GEMINI_MAX_PER_MINUTE);
    if (geminiSlot.allowed) {
        const result = await _callWithTruncationRetry(callGemini, systemText, userText, history, temperature, maxTokens, isJsonMode);
        if (result.ok) { _logDailyAiUsage('gemini'); return { ok: true, text: result.text, provider: 'gemini' }; }
    }

    const groqSlot = await acquireProviderSlot('groq', GROQ_MAX_PER_MINUTE);
    if (groqSlot.allowed) {
        const result = await _callWithTruncationRetry(callGroq, systemText, userText, history, temperature, maxTokens, isJsonMode);
        if (result.ok) { _logDailyAiUsage('groq'); return { ok: true, text: result.text, provider: 'groq' }; }
    }

    const cerebrasSlot = await acquireProviderSlot('cerebras', CEREBRAS_MAX_PER_MINUTE);
    if (cerebrasSlot.allowed) {
        const result = await _callWithTruncationRetry(callCerebras, systemText, userText, history, temperature, maxTokens, isJsonMode);
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

// ✅ [تحسين] كاش تلقائي بالكامل للشروحات الشائعة — بدون أي تدخل إداري.
// السؤال مشترك بين كل الطلاب، فأول رد "اشرحلي"/"ليه إجابتي" بيتخزن، وأي طالب تاني يسأل نفس الشيء
// ياخد نفس الرد فوراً من غير أي نداء AI جديد ومن غير ما يتخصم من رصيده.
// الحماية من التسرب لو الأدمن عدّل السؤال بعدين: نقارن questionText/correctAnswer المخزّنين باللي جايين دلوقتي —
// لو مختلفين، الكاش بيتجاهل نفسه تلقائياً ويتبني من جديد، بدون أي زرار مسح يدوي.
function _buildExplanationCacheKey(actionType, questionUid, studentAnswer) {
    if (actionType === 'explain') return `${questionUid}_explain`;
    if (actionType === 'why') {
        const normalizedAnswer = String(studentAnswer || 'لم_يجب').trim().slice(0, 100);
        return `${questionUid}_why_${normalizedAnswer}`;
    }
    return null; // similar وcustom مايتخزنوش — لازم يفضلوا متنوعين/شخصيين
}

async function _getCachedExplanation(cacheKey, questionText, correctAnswer) {
    if (!cacheKey) return null;
    try {
        const snap = await db.collection('aiExplanationCache').doc(cacheKey).get();
        if (!snap.exists) return null;
        const data = snap.data();
        // فحص التزامن الذاتي: لو السؤال اتعدّل بعد ما اتخزن الكاش، نتجاهله ونولّد من جديد
        if (data.questionText !== questionText || data.correctAnswer !== correctAnswer) return null;
        return data.reply || null;
    } catch (e) { return null; }
}

function _saveExplanationToCache(cacheKey, questionText, correctAnswer, reply) {
    if (!cacheKey) return;
    db.collection('aiExplanationCache').doc(cacheKey).set({
        questionText, correctAnswer, reply,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
    }).catch(() => {});
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
function buildPrompt(subjectLabel, questionText, options, studentAnswer, correctAnswer, explanation, actionType, customMessage, socialContext) {
    if (actionType === 'similar') {
        return _buildSimilarQuestionPrompt(subjectLabel, questionText, options);
    }
    return _buildConversationPrompt(subjectLabel, questionText, options, studentAnswer, correctAnswer, explanation, actionType, customMessage, socialContext);
}

// برومبت مخصص لتوليد سؤال تدريبي واحد كـJSON منظم — عشان يتعرض ككارد تفاعلي حقيقي بدل نص عادي
function _buildSimilarQuestionPrompt(subjectLabel, questionText, options) {
    const isTrueFalse = Array.isArray(options) && options.length === 2;
    const systemText = `أنت مساعد توليد أسئلة تدريبية لمادة: ${subjectLabel}.
السؤال الأصلي (للسياق فقط — اعمل سؤال مختلف تماماً بيقيس نفس المفهوم، بدون أي علاقة نصية مباشرة به): "${questionText}"

القواعد الإلزامية:
- اعمل سؤال تدريبي واحد بس، جديد ومختلف تماماً (سيناريو/أرقام/تفاصيل مختلفة كلياً) عن السؤال الأصلي، لكن بيقيس نفس المفهوم العام بالظبط.
${isTrueFalse
    ? '- ده سؤال صح/خطأ: أعطِ بالضبط خيارين لا غير: ["صح", "خطأ"].'
    : '- أعطِ بالضبط 4 خيارات، واحد منهم صحيح فقط، والباقي معقولة وقريبة الطول من الصحيح.'}
- answer يجب أن يطابق نص أحد الخيارات حرفياً تماماً (نفس الحروف والمسافات).
- explanation: شرح مختصر جداً (جملة أو اتنين) لسبب صحة الإجابة.
- أعد الإجابة بصيغة JSON فقط، بدون أي نص أو شرح قبله أو بعده، وبدون علامات backticks ولا كلمة json، بالضبط بهذا الشكل:
{"question":"...","options":["...","..."],"answer":"...","explanation":"..."}`;

    return { systemText, userText: 'ولّد السؤال التدريبي الآن.' };
}

function _buildConversationPrompt(subjectLabel, questionText, options, studentAnswer, correctAnswer, explanation, actionType, customMessage, socialContext) {
    const optionsList = (options || []).map((o, idx) => `${idx + 1}. ${o}`).join('\n');

    const systemText = `أنت مساعد مذاكرة تعليمي لطالب جامعي في مادة: ${subjectLabel}، في صفحة مراجعة الأسئلة **بعد** تسليم الامتحان وتسجيل الدرجة نهائياً.
السؤال: "${questionText}"
الخيارات:
${optionsList || '(سؤال صح/خطأ أو بدون خيارات متعددة مذكورة)'}
إجابة الطالب: "${studentAnswer}"
الإجابة الصحيحة: "${correctAnswer}"
الشرح المتوفر بالنظام: "${explanation || 'لا يوجد شرح مسجّل'}"
${socialContext ? `\n${socialContext}\n` : ''}
تعليمات:
- الامتحان خلص والدرجة اتسجلت، فمن المقبول تماماً تناقش الإجابة الصحيحة بالتفصيل وتقول ليه إجابة الطالب كانت صح أو غلط.
- هدفك تعليمي بحت: افهيمه المفهوم كويس، وضّح أي لبس، واقترح أمثلة أو أسئلة تدريبية بإجاباتها كاملة لو طلب.
- ممنوع منعاً باتاً أي مقدمة أو عبارة تمهيدية قبل المحتوى الفعلي — لا تبدأ الرد بعبارات زي: "سأوضح لك"، "إليك سؤال تدريبي جديد"، "تمام"، "بالتأكيد"، "حسناً"، "إليك الشرح"، أو أي صيغة مشابهة. ابدأ من أول كلمة بالمحتوى المطلوب نفسه مباشرة (مثال: لو المطلوب شرح ليه الإجابة غلط، ابدأ فوراً بـ"الإجابة الصحيحة هي كذا لأن..." من غير أي تمهيد قبلها).
- ممنوع كمان تشرح خلفية عامة عن الموضوع قبل ما توصل للمطلوب (زي "لفهم السؤال بشكل كامل، يجب أولاً توضيح مفهوم كذا..."). جاوب على المطلوب بالتحديد فوراً، من غير تمهيد نظري.
- ممنوع منعاً باتاً أي تنسيق Markdown إطلاقاً: لا نجوم ** للخط العريض، لا علامات # للعناوين، لا شرطات - أو أرقام للنقاط الفرعية، لا فتح أقسام منفصلة زي "أولاً:" أو "لفهم السؤال:". اكتب فقرة نصية عادية متصلة بس، حتى لو المحتوى فيه أكتر من فكرة.
- الرد كله في حدود 3-4 جمل قصار بالمظبوط (تقريباً 50-70 كلمة)، مش أكتر خالص. لو حسيت إنك قربت من الحد وسط فكرة، اختصر فوراً واقفل الجملة، ولا تفتح فكرة جديدة أو مثال إضافي.
- اكتب بالعربية، وأكمل فكرتك للنهاية بجملة كاملة دايماً — ممنوع تقطع في نص الجملة.
- مهم جداً: ممنوع تختلق أي معلومة أو رقم أو قاعدة مش متأكد منها بثقة. لو مش متأكد 100% من تفصيلة معينة، قول بصراحة "مش متأكد من التفصيلة دي بالظبط" بدل ما تختلق إجابة تبان واثقة وهي غلط — الدقة أهم من الثقة الظاهرية.
- لو في محادثة سابقة معروضة تحت، اعتبرها سياق حقيقي مستمر وجاوب على أساسها.

أمثلة على الأسلوب المطلوب بالظبط لكل نوع طلب (بدون مقدمة، بدون تنسيق، جمل قصار مباشرة — دي أمثلة أسلوب بس، لا تكررها حرفياً):

مثال لطلب "ليه إجابتي غلط": لو الطالب اختار "التخزين المؤقت" والصحيحة "الذاكرة الافتراضية"، رد مثالي:
"الإجابة الصحيحة هي الذاكرة الافتراضية لأنها الآلية اللي بتسمح للنظام يستخدم جزء من القرص الصلب كامتداد للرام وقت الحاجة. التخزين المؤقت (Cache) وظيفته مختلف تماماً — بيسرّع الوصول لبيانات مستخدمة كتير، مش بيوسّع سعة الذاكرة."

مثال لطلب "اشرحلي أكتر": لو السؤال عن الفرق بين التشفير المتماثل وغير المتماثل، رد مثالي:
"التشفير المتماثل بيستخدم نفس المفتاح للتشفير وفك التشفير، وده بيخليه أسرع بس أقل أماناً في مشاركة المفتاح. التشفير غير المتماثل بيستخدم زوج مفاتيح (عام وخاص)، فمفيش حاجة تتبعت من غير تشفير حتى المفتاح نفسه، لكنه أبطأ في المعالجة."

مثال لطلب "سؤال تدريبي شبيه": لو الأصلي عن حساب مساحة مستطيل، رد مثالي:
"سؤال تدريبي: مستطيل طوله 12 متر وعرضه 5 أمتار، ما مساحته؟ الإجابة: 60 متر مربع، لأن مساحة المستطيل = الطول × العرض = 12 × 5."`;

    const userTextByAction = {
        explain: 'اشرحلي هذا السؤال بالتفصيل أكتر من الشرح المختصر المتاح — وضّح المفهوم كامل.',
        why: 'ليه إجابتي كانت صح أو غلط بالتحديد؟ اشرحلي منطق الإجابة الصحيحة مقارنة باللي اخترته.',
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

        // ✅ [تحسين] مسار التقييم (👍/👎) — منفصل تماماً عن مسار توليد الردود.
        // بيسجّل التقييم، ولو سلبي على رد كان مخزّن في الكاش المشترك، يمسحه فوراً عشان محدش تاني ياخد نفس الرد الضعيف.
        if (req.body && req.body.mode === 'feedback') {
            const { subject: fbSubject, questionUid: fbQuestionUid, actionType: fbActionType, studentAnswer: fbStudentAnswer, rating, replyText } = req.body;
            const safeRating = rating === 'up' ? 'up' : 'down';

            await db.collection('review_chat_feedback').add({
                uid: decoded.uid,
                subject: fbSubject || null,
                questionUid: fbQuestionUid || null,
                reply: String(replyText || '').slice(0, 1000),
                rating: safeRating,
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            }).catch(() => {});

            if (safeRating === 'down' && fbQuestionUid) {
                const cacheKey = _buildExplanationCacheKey(fbActionType, fbQuestionUid, String(fbStudentAnswer || '').slice(0, 100));
                if (cacheKey) {
                    await db.collection('aiExplanationCache').doc(cacheKey).delete().catch(() => {});
                }
            }

            return res.status(200).json({ ok: true });
        }

        // ✅ [تحسين] مسح كامل لكاش الشروحات المشترك — أداة أمان يدوية للأدمن،
        // مفيدة لو فيه شك في ردود قديمة اتخزنت قبل تقوية فلتر الجودة
        if (req.body && req.body.mode === 'clearExplanationCache') {
            const adminDoc = await db.collection('admins').doc(decoded.uid).get();
            if (!adminDoc.exists) return res.status(403).json({ error: 'هذا الحساب لا يملك صلاحية أدمن' });

            const snap = await db.collection('aiExplanationCache').get();
            let docs = snap.docs;
            let deleted = 0;
            while (docs.length) {
                const chunk = docs.splice(0, 400);
                const batch = db.batch();
                chunk.forEach(d => batch.delete(d.ref));
                await batch.commit();
                deleted += chunk.length;
            }
            return res.status(200).json({ ok: true, deleted });
        }

        const {
            subject, questionUid, questionText, options,
            studentAnswer, correctAnswer, explanation,
            actionType, message, history,
            correctCount, wrongCount
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

        const safeQuestionText  = String(questionText).slice(0, MAX_QUESTION_TEXT_LENGTH);
        const safeCorrectAnswer = String(correctAnswer).slice(0, MAX_OPTION_LENGTH);
        const safeStudentAnswer = String(studentAnswer || '').slice(0, MAX_OPTION_LENGTH);

        // ✅ [تحسين] فحص الكاش الأول — قبل حتى فحص رصيد الرسائل، عشان لو فيه رد جاهز
        // الطالب ياخده فوراً حتى لو خلّص رصيده اليومي على السؤال ده (مش نداء AI حقيقي، مايستهلكش رصيد)
        // بس لو أول رسالة على السؤال ده (من غير سياق محادثة سابقة) — رد جوه محادثة متعددة الأدوار شخصي، مش قابل لإعادة الاستخدام
        const cacheKey = (safeHistory.length === 0) ? _buildExplanationCacheKey(safeActionType, questionUid, safeStudentAnswer) : null;
        const cachedReply = await _getCachedExplanation(cacheKey, safeQuestionText, safeCorrectAnswer);
        if (cachedReply) {
            const quotaNow = await checkStudentQuota(decoded.uid, questionUid);
            return res.status(200).json({ reply: cachedReply, remaining: quotaNow.remaining, cached: true });
        }

        // تحقق من رصيد الطالب لهذا السؤال (بدون خصم بعد)
        const quotaCheck = await checkStudentQuota(decoded.uid, questionUid);
        if (!quotaCheck.allowed) {
            return res.status(403).json({ error: `وصلت للحد الأقصى (${MAX_MESSAGES_PER_QUESTION} رسائل) لهذا السؤال`, code: 'QUOTA_EXCEEDED' });
        }

        const subjectLabel = SUBJECT_LABELS[subject];
        // ✅ [تحسين] سياق اجتماعي — نديه للنموذج بس لو العيّنة كافية (5 محاولات فأكتر) ونسبة الخطأ عالية فعلاً (40%+)
        // عشان نتجنب جملة غريبة زي "أغلب زمايلك غلطوا" في سؤال كل الناس عارفاه أو عيّنة صغيرة مش دالة
        const safeCorrectCount = Math.max(0, parseInt(correctCount, 10) || 0);
        const safeWrongCount   = Math.max(0, parseInt(wrongCount, 10) || 0);
        const totalAttempts    = safeCorrectCount + safeWrongCount;
        const wrongRate         = totalAttempts > 0 ? (safeWrongCount / totalAttempts) : 0;
        const socialContext = (totalAttempts >= 5 && wrongRate >= 0.4)
            ? `ملاحظة سياقية (استخدمها بس لو مناسبة طبيعياً، متقولهاش زي جملة منفصلة قسرية): حوالي ${Math.round(wrongRate * 100)}% من الطلاب اللي حلوا السؤال ده غلطوا فيه برضه — يعني السؤال فعلاً بيلخبط كتير، ومش عيب إن الطالب غلط فيه.`
            : '';

        const { systemText, userText } = buildPrompt(
            subjectLabel,
            safeQuestionText,
            safeOptions,
            safeStudentAnswer,
            safeCorrectAnswer,
            String(explanation || '').slice(0, 500),
            safeActionType,
            safeMessage,
            socialContext
        );

        // دقة أعلى (حرارة أقل) للشرح والتصحيح الواقعي، تنوع أكتر (حرارة أعلى) للأسئلة التدريبية الجديدة
        const temperatureByAction = { explain: 0.4, why: 0.35, similar: 0.75, custom: 0.5 };
        const temperature = temperatureByAction[safeActionType] ?? 0.5;

        // مهمة توليد JSON منفصلة تماماً عن سياق المحادثة النصية — تمرير المحادثة السابقة هنا هيلخبط الموديل
        const historyForThisCall = safeActionType === 'similar' ? [] : safeHistory;
        const isJsonMode = safeActionType === 'similar';
        const maxTokens = isJsonMode ? SIMILAR_QUESTION_MAX_TOKENS : CONVERSATION_MAX_TOKENS;

        const assistant = await getAssistantReply(systemText, userText, historyForThisCall, temperature, maxTokens, isJsonMode);
        if (!assistant.ok) {
            return res.status(429).json({ error: 'الخدمة مزدحمة حالياً', retryAfterMs: assistant.retryAfterMs, code: 'BUSY' });
        }

        let responsePayload;
        if (safeActionType === 'similar') {
            const quiz = _parseQuizJson(assistant.text);
            // ✅ [FIX] شبكة أمان: لو تعذّر تحليل الـJSON (حتى بعد رفع حد التوكنات وإعادة المحاولة)،
            // ممنوع منعاً باتاً إرسال النص الخام كـ"رد عادي" — كان ده سبب ظهور JSON خام للطالب في الشات.
            responsePayload = quiz
                ? { quiz }
                : { reply: 'تعذّر توليد سؤال تدريبي منظم هذه المرة، جرّب تضغط الزرار تاني.' };
        } else {
            const sanitized = _sanitizeAssistantText(assistant.text);
            // ✅ [FIX] لو الرد اتقطع بدري جداً وفضل قصير جداً حتى بعد كل المعالجة، نرفضه برسالة ودية
            // بدل ما نعرض جزء بلا معنى — ومهم جداً: منعاً باتاً نخزّنه في الكاش المشترك
            responsePayload = { reply: sanitized || 'الرد طلع قصير وغير مكتمل هذه المرة، جرّب تضغط الزرار تاني.' };
            // ✅ [تحسين] تخزين الرد في الكاش المشترك — أي طالب تاني يسأل نفس السؤال بنفس الطريقة ياخده فوراً
            if (cacheKey && sanitized) _saveExplanationToCache(cacheKey, safeQuestionText, safeCorrectAnswer, sanitized);
        }

        const remaining = await incrementStudentQuota(decoded.uid, questionUid);

        db.collection('review_chat_logs').add({
            uid: decoded.uid,
            subject,
            questionUid,
            actionType: safeActionType,
            message: safeMessage,
            reply: responsePayload.quiz ? JSON.stringify(responsePayload.quiz) : responsePayload.reply,
            provider: assistant.provider,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        }).catch(() => {});

        return res.status(200).json({ ...responsePayload, remaining });

    } catch (err) {
        return res.status(500).json({ error: 'خطأ داخلي في الخادم: ' + err.message });
    }
};
