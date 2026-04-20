// ─── proxy-engine/server.js ───
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// ── 智能爬蟲服務 ──
const { smartScrape } = require('./services/smart-scraper');
const calculator = require('./services/calculator');

const app = express();
const PORT = process.env.PORT || 4000;
const HOST = '0.0.0.0'; 

// 偵錯：啟動時檢查 API Key
if (!process.env.GEMINI_API_KEY) {
    console.warn('⚠️  警告: GEMINI_API_KEY 未設定，AI 功能將無法運作！');
} else {
    console.log('✅ GEMINI_API_KEY 已偵測');
}

app.use(cors({ origin: '*' }));
app.use(express.json());

// ─── 健康檢查 ───
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', service: 'proxy-engine-v2-gemini' });
});

// ─── 主估價 API (Scraper + Calculator) ───
app.post('/api/quote', async (req, res) => {
    try {
        const { url, selectedOptions } = req.body;
        if (!url) return res.status(400).json({ success: false, error: '缺少 url' });

        console.log(`\n🚀 [Quote] ${url}`);
        const { productInfo = null, availableVariants = null, seoMeta = {} } = (await smartScrape(url, selectedOptions || []) || {});

        if (!productInfo) {
            return res.json({ success: true, needsManualQuote: true, source_url: url });
        }

        const weight = productInfo.weight_kg || 0.5;
        const dims = productInfo.dimensions || { l: 30, w: 20, h: 10 };

        const pricing = await calculator.estimateTotal(
            productInfo.original_price,
            productInfo.original_currency,
            weight,
            dims
        );

        res.json({
            success: true,
            source_url: url,
            needsVariantSelection: !!(availableVariants && Object.keys(availableVariants).length > 0),
            availableVariants,
            product: {
                title: productInfo.title,
                original_price: productInfo.original_price,
                original_currency: productInfo.original_currency,
                image: productInfo.image || seoMeta?.ogImage || '',
                variants: productInfo.variants || [],
            },
            pricing
        });
    } catch (e) {
        console.error('=== [Quote Error] ===', e); // 增加詳細錯誤紀錄
        res.status(500).json({ success: false, error: e.message });
    }
});

// ─── AI 對話 API (Gemini Cloud) ───
app.post('/api/chat', async (req, res) => {
    try {
        const { messages } = req.body;
        if (!messages) return res.status(400).json({ error: 'Missing messages' });

        if (!process.env.GEMINI_API_KEY) throw new Error("缺少 GEMINI_API_KEY");

        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        
        let systemPrompt = "";
        const geminiContents = [];
        for (const msg of messages) {
            if (msg.role === 'system') systemPrompt += msg.content + "\n";
            else if (msg.role === 'user') geminiContents.push({ role: 'user', parts: [{ text: msg.content }] });
            else if (msg.role === 'assistant') geminiContents.push({ role: 'model', parts: [{ text: msg.content }] });
        }

        const model = genAI.getGenerativeModel({ 
            model: "gemini-2.5-flash",
            systemInstruction: systemPrompt || undefined,
            tools: [{
                functionDeclarations: [
                    {
                        name: "fetch_quote",
                        description: "抓取日本購物網站規格與售價",
                        parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] }
                    },
                    {
                        name: "present_checkout_option",
                        description: "顯示最終報價供客戶結帳",
                        parameters: { 
                            type: "object", 
                            properties: { 
                                title: { type: "string" }, 
                                price_twd: { type: "number" },
                                image_url: { type: "string" }
                            }, 
                            required: ["title", "price_twd"] 
                        }
                    }
                ]
            }]
        });

        const result = await model.generateContent({ contents: geminiContents });
        const response = result.response;
        const functionCalls = response.functionCalls();
        const text = response.text();

        let returnMessage = { role: "assistant", content: "" };
        if (functionCalls && functionCalls.length > 0) {
            returnMessage.tool_calls = functionCalls.map(fc => ({ function: { name: fc.name, arguments: fc.args } }));
        } else {
            returnMessage.content = text || "聽不懂，請再說一次";
        }

        res.json({ success: true, message: returnMessage });
    } catch (error) {
        console.error('=== [Chat Error] ===', error); // 增加詳細錯誤紀錄
        res.status(500).json({ success: false, error: error.message });
    }
});

app.listen(PORT, HOST, () => {
    console.log(`\n✅ NEKOMASU AI 伺服器已啟動: http://localhost:${PORT}`);
    console.log(`📡 AI 大腦: Gemini 2.0 Flash`);
});
