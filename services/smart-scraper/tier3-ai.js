// ─── proxy-engine/services/smart-scraper/tier3-ai.js ───
// 🥉 第三階：AI 降噪解析（終極 Fallback）
// 策略：只有前兩階完全失敗時才觸發。
// HTML → Markdown 壓縮去噪 → LLM (平價快速模型) Structured JSON Output

'use strict';

const TurndownService = require('turndown');

// 初始化 Turndown（HTML → Markdown 轉換器）
const turndown = new TurndownService({
    headingStyle: 'atx',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
});

// 移除對 LLM 毫無意義的標籤
turndown.remove(['script', 'style', 'link', 'meta', 'noscript', 'iframe', 'svg', 'path', 'head', 'nav', 'footer', 'aside', 'header']);

// 剝除所有 HTML 屬性，只留純文字結構
turndown.addRule('strip-attributes', {
    filter: (node) => node.nodeType === 1, // ELEMENT_NODE
    replacement: (content) => content,
});

/**
 * 將 HTML 轉為乾淨的 Markdown，大幅降低 Token 消耗
 * @param {string} html
 * @param {number} maxLength - 最大字元數（Token 預算控制）
 * @returns {string}
 */
function htmlToMarkdown(html, maxLength = 6000) {
    try {
        const md = turndown.turndown(html);
        // 折疊多餘空行
        const cleaned = md.replace(/\n{3,}/g, '\n\n').trim();
        if (cleaned.length <= maxLength) return cleaned;
        // 超出預算：只取最前面的部分（通常商品資訊在前）
        return cleaned.substring(0, maxLength) + '\n\n...[已截斷]';
    } catch (e) {
        // 若 HTML 過於複雜，退化為純文字
        return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').substring(0, maxLength);
    }
}

/**
 * 呼叫 Gemini Flash（有 API Key 時的高品質 fallback）
 * @param {string} markdown
 * @param {string} targetUrl
 * @returns {Promise<object|null>}
 */
async function callGeminiStructured(markdown, targetUrl = '') {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey || apiKey === 'MISSING_API_KEY') return null;

    try {
        const { GoogleGenerativeAI, SchemaType } = require('@google/generative-ai');
        const genAI = new GoogleGenerativeAI(apiKey);
        // 使用 Flash 而非 Pro：更快更便宜，結構化輸出綽綽有餘
        const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

        const schema = {
            type: SchemaType.OBJECT,
            properties: {
                product_name: { type: SchemaType.STRING },
                variants: {
                    type: SchemaType.ARRAY,
                    items: {
                        type: SchemaType.OBJECT,
                        properties: {
                            spec: { type: SchemaType.STRING, description: '規格描述，如顏色、材質、版型' },
                            price: { type: SchemaType.NUMBER, description: '純數字售價' },
                            currency: { type: SchemaType.STRING, description: 'ISO 4217 貨幣代碼' },
                        },
                        required: ['spec', 'price', 'currency']
                    }
                }
            },
            required: ['product_name', 'variants']
        };

        const prompt = `從以下電商網頁 Markdown 提取商品名稱與所有規格組合及其售價。
來源：${targetUrl}

--- MARKDOWN BEGIN ---
${markdown}
--- MARKDOWN END ---`;

        const result = await model.generateContent({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: {
                temperature: 0.1,
                responseMimeType: 'application/json',
                responseSchema: schema
            }
        });

        const parsed = JSON.parse(result.response.text());
        console.log('[Tier3] ✅ Gemini Flash structured output received.');
        return { source: 'gemini_flash_tier3', product: parsed };

    } catch (e) {
        console.warn('[Tier3] Gemini Flash call failed:', e.message);
        return null;
    }
}

/**
 * Tier 3 主入口：HTML → Markdown → LLM
 * @param {string} html - 完整頁面 HTML
 * @param {string} targetUrl
 * @returns {Promise<object|null>}
 */
async function runTier3(html, targetUrl = '') {
    console.log('[Tier3] 🔄 Starting AI fallback analysis...');
    const markdown = htmlToMarkdown(html);
    console.log(`[Tier3] HTML→Markdown: ${html.length} chars → ${markdown.length} chars (${Math.round(markdown.length / html.length * 100)}% reduction)`);

    // 優先 Gemini（有 key 時品質更好）
    const geminiResult = await callGeminiStructured(markdown, targetUrl);
    if (geminiResult) return geminiResult;

    console.log('[Tier3] ❌ All AI fallbacks failed.');
    return null;
}

module.exports = { htmlToMarkdown, runTier3 };
