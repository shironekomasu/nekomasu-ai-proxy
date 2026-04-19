// ─── proxy-engine/services/extractor.js ───
require('dotenv').config();
const { GoogleGenerativeAI, SchemaType } = require('@google/generative-ai');

// AI Configuration
// For testing locally without an explicit .env key, try to use a fallback logic or throw.
const API_KEY = process.env.GEMINI_API_KEY || 'MISSING_API_KEY';
const genAI = new GoogleGenerativeAI(API_KEY);

const cheerio = require('cheerio');

class InformationExtractor {
    
    constructor() {
        // We use Gemini 1.5 Pro because it excels at massive context and unstructured HTML parsing.
        this.model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });
    }

    /**
     * @param {string} cleanHtml 
     * @param {object} seoMeta
     */
    async extractProductContext(cleanHtml, seoMeta = {}) {
        if (API_KEY === 'MISSING_API_KEY') {
            console.warn('[Extractor] No GEMINI_API_KEY provided. Using local heuristic parser for development.');
            
            // 使用 Cheerio 進行啟發式本地解析
            const $ = cheerio.load(cleanHtml);
            let title = seoMeta.ogTitle || $('h1').first().text().trim() || $('title').first().text().trim() || '無法擷取標題';
            // [Global] Try to use the DOM-extracted total price and og:currency first
            let priceJpy = 0;
            let detectedCurrency = seoMeta.ogCurrency || 'JPY';

            // Priority 1: Scraper already found a rendered total price in DOM (e.g., Wooting configurator)
            if (seoMeta.domTotalPrice) {
                const raw = parseFloat(seoMeta.domTotalPrice.replace(/[^0-9.]/g, ''));
                if (!isNaN(raw) && raw > 0) {
                    priceJpy = raw;
                    // If the currency is unknown but price looks like TWD range, assume TWD
                    if (!seoMeta.ogCurrency) detectedCurrency = (raw > 500 && raw < 200000) ? 'TWD' : 'USD';
                    console.log('[Extractor] Using DOM total price:', priceJpy, detectedCurrency);
                }
            }

            // Priority 2: og meta tags
            if (priceJpy === 0 && seoMeta.ogPrice) {
                priceJpy = parseFloat(seoMeta.ogPrice);
            }
            let mainImage = seoMeta.ogImage || $('img').first().attr('src') || '';

            // 嘗試從 JSON-LD 解析標準電商數據
            // detectedCurrency is already initialized above
            if (seoMeta.ldJson) {
                try {
                    // JSON-LD 可能是單一物件或陣列，嘗試做全域正則搜尋
                    const priceMatch = seoMeta.ldJson.match(/"price"\s*:\s*"?([0-9.]+)"?/);
                    const currencyMatch = seoMeta.ldJson.match(/"priceCurrency"\s*:\s*"?([A-Z]{3})"?/);
                    
                    if (priceMatch && priceMatch[1]) {
                        priceJpy = parseFloat(priceMatch[1]);
                        if (currencyMatch && currencyMatch[1]) detectedCurrency = currencyMatch[1];
                    }
                } catch(e) {}
            }

            // 若依然是 0，尋找包含各國貨幣符號的文字節點
            if (priceJpy === 0) {
                const plainText = $.text();
                // 擴充正則尋找 $、€、¥、円 等，特別增加對 NT$ 或是大額的防呆
                const priceMatches = [...plainText.matchAll(/(NT\$|TWD\s*\$?|US\$|[$€¥￥])\s*([0-9,.]+)|([0-9,.]+)\s*(?:円|YEN|税|TWD)/gi)];
                
                if (priceMatches.length > 0) {
                    const freqs = {};
                    let bestPrice = 0;
                    let bestCount = 0;

                    for (const match of priceMatches) {
                        const numRaw = match[2] || match[3];
                        const symbol = match[1] || '';

                        if (numRaw) {
                            const num = parseFloat(numRaw.replace(/,/g, ''));
                            // 價格區間過濾
                            if (!isNaN(num) && num >= 10 && num <= 500000) {
                                let key = num.toString();
                                freqs[key] = (freqs[key] || 0) + 1;
                                
                                if (freqs[key] > bestCount) {
                                    bestCount = freqs[key];
                                    bestPrice = num;
                                    
                                    const symUpper = symbol.toUpperCase();
                                    if (symUpper.includes('NT') || symUpper.includes('TWD') || match[0].toUpperCase().includes('TWD')) {
                                        detectedCurrency = 'TWD';
                                    } else if (symUpper.includes('US')) {
                                        detectedCurrency = 'USD';
                                    } else if (symUpper === '$') {
                                        // Heuristic: Keyboards/Models rarely cost >$2000 USD. If it is 6000+, it's TWD.
                                        detectedCurrency = num > 1000 ? 'TWD' : 'USD';
                                    } else if (symUpper === '€') {
                                        detectedCurrency = 'EUR';
                                    } else {
                                        detectedCurrency = 'JPY';
                                    }
                                }
                            }
                        }
                    }
                    if (bestPrice > 0) priceJpy = bestPrice;
                }
            }
            
            // [使用者指定規則] Wooting 等商品最高不超過 NT$13,000，超過一律視為幣種誤判
            if (priceJpy > 13000 && detectedCurrency === 'USD') {
                console.log('[Extractor] Price exceeds 13000 TWD threshold, overriding currency to TWD');
                detectedCurrency = 'TWD';
            }

            // 全域防呆：鍵盤/模型等周邊如果超過 1000 "美金"，絕對是系統錯誤判讀了 TWD，強制修正
            if (detectedCurrency === 'USD' && priceJpy > 1000) {
                detectedCurrency = 'TWD';
            }

            // [修改重點]：為了支援全世界代購，我們「原封不動」送出當時網頁的原始數字與幣種
            // 拔除了所有原先強制轉日本匯率的魔改 ( / 0.22, * 150 等 )

            return {
                title: title,
                original_price: priceJpy,
                original_currency: detectedCurrency,
                weight_kg: 0.5, // 本地爬蟲難以判斷重量，預設 0.5kg
                dimensions: { l: 20, w: 15, h: 10 },
                main_image_url: mainImage.startsWith('//') ? 'https:' + mainImage : mainImage
            };
        }

        console.log('[Extractor] Invoking Gemini 1.5 Pro to parse HTML...');

        // Define the strictly required JSON Schema for Gemini Output
        const schema = {
            type: SchemaType.OBJECT,
            properties: {
                title: { 
                    type: SchemaType.STRING, 
                    description: "商品名稱。若找無請回傳 '請提供完整標題'" 
                },
                original_price: { 
                    type: SchemaType.INTEGER, 
                    description: "售價。只需數字，若為 4,500 則轉為 4500。找無請回 0。" 
                },
                original_currency: { 
                    type: SchemaType.STRING, 
                    description: "此商品實際的結帳貨幣代碼。請回傳三碼大寫字母 (如 USD, JPY, EUR, TWD, KRW 等)。未標示則由商品來源國度推測。" 
                },
                weight_kg: { 
                    type: SchemaType.NUMBER, 
                    description: "以公斤(kg)為單位的重量推估。若無明確標示，請根據商品特性(如:模型,鞋子,衣服)給出估計值。例如 0.8" 
                },
                dimensions: {
                    type: SchemaType.OBJECT,
                    description: "推估之商品包裝材積大小(公分 cm)。若無標示請依常理估算。",
                    properties: {
                        l: { type: SchemaType.NUMBER, description: "長度 (cm)" },
                        w: { type: SchemaType.NUMBER, description: "寬度 (cm)" },
                        h: { type: SchemaType.NUMBER, description: "高度 (cm)" }
                    },
                    required: ["l", "w", "h"]
                },
                main_image_url: {
                    type: SchemaType.STRING,
                    description: "商品主要圖片的 URL 連結 (結尾通常為 .jpg, .png)。找無請留空。"
                }
            },
            required: ["title", "original_price", "original_currency", "weight_kg", "dimensions", "main_image_url"]
        };

        const prompt = `
            你是一個專業的跨國電商商品資訊萃取引擎。
            下方是一段從世界各國電商網站擷取的 HTML 程式碼。
            請你仔細分析這段 HTML，並嚴格遵循給定的 JSON 格式，擷取出商品的關鍵資訊。
            如果頁面中有明確的售價、重量與尺寸，請直接使用；
            如果資料部分缺失，請根據商品名稱與常理做最合理的【推估】(例如：如果商品是一本一般漫畫，重量大約 0.2kg，尺寸 18x12x2)。

            --- HTML CONTENT BEGIN ---
            ${cleanHtml}
            --- HTML CONTENT END ---
        `;

        try {
            const result = await this.model.generateContent({
                contents: [{ role: "user", parts: [{ text: prompt }] }],
                generationConfig: {
                    temperature: 0.1, // 低溫確保穩定輸出
                    responseMimeType: "application/json",
                    responseSchema: schema
                }
            });

            const textResponse = result.response.text();
            console.log('[Extractor] Gemini Response received.');
            
            return JSON.parse(textResponse);
        } catch (err) {
            console.error('[Extractor] Error extracting metadata with AI:', err);
            throw new Error('AI 分析頁面資料失敗。可能是頁面結構過少或解析限流。');
        }
    }
}

module.exports = new InformationExtractor();
