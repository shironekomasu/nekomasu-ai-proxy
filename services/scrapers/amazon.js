// ─── proxy-engine/services/scrapers/amazon.js ───
const axios = require('axios');
const cheerio = require('cheerio');

/**
 * 💡 黑魔法 1：暴力清洗網址 (URL Cleansing)
 * 移除 Amazon 網址後方追蹤碼，降低被防爬蟲機制鎖定的機率。
 */
function cleanAmazonUrl(rawUrl) {
    const match = rawUrl.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i);
    if (match) {
        const parsed = new URL(rawUrl);
        return `https://${parsed.hostname}/dp/${match[1]}`;
    }
    return rawUrl;
}

/**
 * 💡 核心外掛：精準 JSON 括號配對解析器
 * 專門對付 Amazon 深層巢狀的 JSON，比 Regex 穩定 100 倍
 */
function extractAmazonJSON(htmlStr, keyword) {
    const regex = new RegExp(`"${keyword}"\\s*:\\s*(\\{|\\[)`);
    const match = htmlStr.match(regex);
    if (!match) return null;

    const startIndex = match.index + match[0].length - 1;
    const startChar = htmlStr[startIndex];
    const endChar = startChar === '{' ? '}' : ']';

    let count = 0;
    let inString = false;
    let escapeNext = false;

    for (let i = startIndex; i < htmlStr.length; i++) {
        const char = htmlStr[i];
        if (escapeNext) { escapeNext = false; continue; }
        if (char === '\\') { escapeNext = true; continue; }
        if (char === '"') { inString = !inString; continue; }

        if (!inString) {
            if (char === startChar) count++;
            else if (char === endChar) count--;

            if (count === 0) {
                try {
                    return JSON.parse(htmlStr.substring(startIndex, i + 1));
                } catch (e) {
                    return null;
                }
            }
        }
    }
    return null;
}

async function scrape(url, selectedOptions = []) {
    const cleanUrl = cleanAmazonUrl(url);
    console.log(`[Amazon Scraper] ⚡ 暴力瘦身網址: ${cleanUrl}`);

    try {
        const SCRAPER_API_KEY = process.env.SCRAPER_API_KEY;
        if (!SCRAPER_API_KEY) throw new Error('Missing Proxy API Key');

        let countryCode = 'us';
        if (cleanUrl.includes('.co.jp')) countryCode = 'jp';
        else if (cleanUrl.includes('.de')) countryCode = 'de';
        else if (cleanUrl.includes('.co.uk')) countryCode = 'gb';

        // 💡 黑魔法 2：加上 premium=true (強制住宅IP) 與 render=true (模擬瀏覽器)
        const proxyUrl = `http://api.scraperapi.com/?api_key=${SCRAPER_API_KEY}&url=${encodeURIComponent(cleanUrl)}&premium=true&country_code=${countryCode}&render=true`;

        let html = '';
        let response;

        // 💡 黑魔法加強：驗證碼辨識與 3 連擊自動換 IP 系統
        for (let i = 1; i <= 3; i++) {
            try {
                console.log(`[Amazon Scraper] 🚀 發送高匿蹤請求 (第 ${i}/3 次嘗試)...`);
                // 每次給 25 秒，不浪費時間在死胡同裡
                response = await axios.get(proxyUrl, { timeout: 25000 });
                html = response.data;

                // 🚨 驗證碼雷達：快速掃描網頁原始碼，確認是不是被擋在 CAPTCHA 牆外
                const isCaptcha = html.includes('Type the characters you see in this image') ||
                    html.includes('api-services-support@amazon.com') ||
                    (!html.includes('productTitle') && !html.includes('title'));

                if (isCaptcha) {
                    console.warn(`[Amazon Scraper] ⚠️ 第 ${i} 次撞到驗證碼牆 (CAPTCHA)，自動切換全新 IP 重新撞擊...`);
                    if (i === 3) throw new Error('連續 3 次被 Amazon 驗證碼阻擋，代理節點全滅');
                    continue; // 觸發下一次迴圈 (ScraperAPI 會自動換 IP)
                }

                console.log(`[Amazon Scraper] 🔓 成功繞過防護牆，開始解析商品資料...`);
                break; // 成功繞過，跳出迴圈

            } catch (err) {
                if (err.code === 'ECONNABORTED' || err.message.includes('timeout')) {
                    console.warn(`[Amazon Scraper] ⏳ 第 ${i} 次連線太慢，自動切換 IP...`);
                    if (i === 3) throw new Error('連續 3 次 Proxy 節點超時');
                } else {
                    if (i === 3) throw err; // 其他嚴重錯誤直接拋出
                }
            }
        }

        const $ = cheerio.load(html);

        // 1. 萃取標題
        let title = $('#productTitle').text().trim() || $('#title').text().trim();
        if (!title) {
            title = $('title').text().replace('Amazon.com:', '').replace('Amazon.co.jp:', '').trim();
        }

        // 2. 暴力萃取價格
        let priceRaw =
            $('.priceToPay span.a-offscreen').first().text().trim() ||
            $('#corePriceDisplay_desktop_feature_div .a-price-whole').first().text().trim() ||
            $('#corePrice_feature_div .a-offscreen').first().text().trim() ||
            $('#priceblock_ourprice').text().trim() ||
            $('#priceblock_dealprice').text().trim() ||
            $('.a-color-price').first().text().trim();

        let price = 0;
        if (priceRaw) {
            price = parseFloat(priceRaw.replace(/[^0-9.]/g, ''));
        }

        if (price === 0) {
            const priceMatch = html.match(/"priceAmount":\s*([\d.]+)/) ||
                html.match(/"price":\s*([\d.]+)/) ||
                html.match(/data-asin-price="([\d.]+)"/);
            if (priceMatch) {
                price = parseFloat(priceMatch[1]);
                console.log(`[Amazon Scraper] ⚠️ DOM 解析失敗，透過底層 Regex 暴力抓出價格: ${price}`);
            }
        }

        let currency = 'USD';
        if (/NT\$|TWD|NTD/.test(priceRaw)) currency = 'TWD';
        else if (/¥|JPY|円/.test(priceRaw) || cleanUrl.includes('.co.jp')) currency = 'JPY';
        else if (/€|EUR/.test(priceRaw) || cleanUrl.includes('.de')) currency = 'EUR';
        else if (/£|GBP/.test(priceRaw) || cleanUrl.includes('.co.uk')) currency = 'GBP';

        // 3. 萃取首圖
        let image = $('#landingImage').attr('data-old-hires') || $('#landingImage').attr('src');
        if (!image) {
            const imgMatch = html.match(/"large":"(https:\/\/[^"]+)"/);
            if (imgMatch) image = imgMatch[1];
        }

        // 💡 黑魔法 5：終極 Twister 解析器
        let exactVariants = [];
        let availableVariants = {};
        const hostname = new URL(cleanUrl).hostname;

        // 引擎 A: JSON 外科手術切除術 (一次性抓出所有隱藏組合)
        try {
            const dimensions = extractAmazonJSON(html, 'dimensionsDisplay');
            const varValues = extractAmazonJSON(html, 'variationValues');
            const dimToAsin = extractAmazonJSON(html, 'dimensionValuesDisplayData');

            if (dimensions && varValues && dimToAsin) {
                // 整理可選維度給前端
                for (const key in varValues) {
                    const cleanKey = key.replace(/_name$/, '').toUpperCase();
                    availableVariants[cleanKey] = varValues[key];
                }

                // 展開所有 ASIN
                for (const [asin, comboIndices] of Object.entries(dimToAsin)) {
                    let specParts = [];
                    dimensions.forEach((dimKey, i) => {
                        const valIndex = parseInt(comboIndices[i], 10);
                        if (varValues[dimKey] && varValues[dimKey][valIndex]) {
                            specParts.push(varValues[dimKey][valIndex]);
                        }
                    });

                    if (specParts.length > 0) {
                        exactVariants.push({
                            sku: asin,
                            spec: specParts.join(' / '),
                            url: `https://${hostname}/dp/${asin}`,
                            price: price, // 基礎參考價
                            currency: currency,
                            image: image
                        });
                    }
                }
                console.log(`[Amazon Scraper] 🎯 JSON 手術成功！完美提取出 ${exactVariants.length} 個隱藏的 ASIN 組合！`);
            }
        } catch (e) {
            console.warn('[Amazon Scraper] JSON 提取失敗:', e.message);
        }

        // 引擎 B: 備用 DOM 掃描 (萬一 JSON 不存在，才使用掃描實體按鈕)
        if (exactVariants.length === 0) {
            console.log(`[Amazon Scraper] ⚠️ 啟動引擎 B: DOM 實體按鈕掃描...`);
            const variantContainers = $('#twister_feature_div, #twister, #twisterContainer, #mobileTwisterContainer, [id^="variation_"]');

            variantContainers.each((i, container) => {
                let dimName = $(container).find('label.a-form-label, .a-color-secondary').first().text().replace(/:/g, '').trim();
                if (!dimName) dimName = 'Option';

                const options = [];
                $(container).find('li, .twister-item, select option').each((j, el) => {
                    let optVal = $(el).attr('title') || $(el).text();
                    optVal = optVal.replace(/^Click to select /i, '').replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
                    let targetAsin = $(el).attr('data-defaultasin') || $(el).attr('value') || '';
                    if (targetAsin.length !== 10) targetAsin = ($(el).attr('data-dp-url') || '').match(/\/dp\/([A-Z0-9]{10})/) ? RegExp.$1 : null;

                    if (optVal && optVal !== 'Select' && optVal !== '-1' && optVal.length < 40) {
                        options.push(optVal);
                        if (targetAsin) {
                            exactVariants.push({
                                sku: targetAsin, spec: optVal, url: `https://${hostname}/dp/${targetAsin}`, price, currency, image
                            });
                        }
                    }
                });
                if (options.length > 0) availableVariants[dimName] = [...new Set(options)];
            });

            // 智能合併
            const uniqueMap = new Map();
            for (const v of exactVariants) {
                if (uniqueMap.has(v.sku)) {
                    if (!uniqueMap.get(v.sku).spec.includes(v.spec)) uniqueMap.get(v.sku).spec += ' / ' + v.spec;
                } else uniqueMap.set(v.sku, v);
            }
            exactVariants = Array.from(uniqueMap.values());
            console.log(`[Amazon Scraper] 🎯 DOM 備用掃描完成，找出 ${exactVariants.length} 個 ASIN。`);
        }

        const needsVariant = Object.keys(availableVariants).length > 0 || exactVariants.length > 0;

        if (!title || price === 0) {
            throw new Error('解析失敗：可能被要求輸入驗證碼，或版面已變更');
        }

        console.log(`[Amazon Scraper] ✅ 成功取得資料: ${title.substring(0, 30)}... | 價格: ${price} ${currency}`);

        return {
            productInfo: {
                source: 'amazon_proxy_scraper_v5',
                title: title,
                original_price: price,
                original_currency: currency,
                image: image || '',
                variants: exactVariants,
            },
            needsVariantSelection: needsVariant,
            availableVariants: availableVariants,
            seoMeta: {}
        };

    } catch (error) {
        const status = error.response ? error.response.status : 'N/A';
        console.warn(`[Amazon Scraper] ⚠️ 抓取失敗 (Status: ${status}): ${error.message}`);
        throw error; // 退回給 Router
    }
}

module.exports = { scrape };