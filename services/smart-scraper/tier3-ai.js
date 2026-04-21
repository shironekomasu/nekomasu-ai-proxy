// ─── proxy-engine/services/smart-scraper/tier3-ai.js ───
// 🥉 第三階：AI 降噪解析

'use strict';
const TurndownService = require('turndown');

const turndown = new TurndownService({
    headingStyle: 'atx',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
});

turndown.remove(['script', 'style', 'link', 'meta', 'noscript', 'iframe', 'svg', 'path', 'head', 'nav', 'footer', 'aside', 'header']);

turndown.addRule('strip-attributes', {
    filter: (node) => node.nodeType === 1,
    replacement: (content) => content,
});

function htmlToMarkdown(html, maxLength = 6000) {
    try {
        const md = turndown.turndown(html);
        const cleaned = md.replace(/\n{3,}/g, '\n\n').trim();
        if (cleaned.length <= maxLength) return cleaned;
        return cleaned.substring(0, maxLength) + '\n\n...[已截斷]';
    } catch (e) {
        return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').substring(0, maxLength);
    }
}

async function callGeminiStructured(markdown, targetUrl = '') {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey || apiKey === 'MISSING_API_KEY') return null;

    try {
        const { GoogleGenerativeAI, SchemaType } = require('@google/generative-ai');
        const genAI = new GoogleGenerativeAI(apiKey);
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

        // 🌟 恢復純淨的提示詞
        const prompt = `【重要規則】：請絕對不要將「行銷活動、促銷標籤、滿減優惠、日期區間、免運說明」（例如帶有 [折扣]、[滿額]、[加碼] 等字眼的文字）當作商品規格 (variants)。真正的規格通常是顏色、尺寸、軸體、容量等。如果判斷該網頁實際上是「單一商品」，沒有真正的可選規格，請務必將 variants 陣列保持為空 []，不要硬湊。

從以下電商網頁 Markdown 提取商品名稱與所有規格組合及其售價。
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

async function runTier3(html, targetUrl = '') {
    console.log('[Tier3] 🔄 Starting AI fallback analysis...');
    const markdown = htmlToMarkdown(html);
    console.log(`[Tier3] HTML→Markdown: ${html.length} chars → ${markdown.length} chars (${Math.round(markdown.length / html.length * 100)}% reduction)`);

    const geminiResult = await callGeminiStructured(markdown, targetUrl);
    if (geminiResult) return geminiResult;

    console.log('[Tier3] ❌ All AI fallbacks failed.');
    return null;
}

module.exports = { htmlToMarkdown, runTier3 };