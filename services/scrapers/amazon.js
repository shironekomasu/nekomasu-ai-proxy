// ─── proxy-engine/services/scrapers/amazon.js ───
const axios = require('axios');
const cheerio = require('cheerio');

/**
 * 💡 黑魔法 1：暴力清洗網址 (URL Cleansing)
 * Amazon 網址只要有 /dp/ 後面的 10 碼 ASIN (商品編號) 就能訪問。
 * 我們把後面幾百個字的追蹤碼全部砍掉，這樣 Amazon 就無法追蹤這是不是機器人！
 */
function cleanAmazonUrl(rawUrl) {
    const match = rawUrl.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i);
    if (match) {
        const parsed = new URL(rawUrl);
        return `https://${parsed.hostname}/dp/${match[1]}`;
    }
    return rawUrl; // 如果找不到 ASIN，才用原網址
}

async function scrape(url, selectedOptions = []) {
    const cleanUrl = cleanAmazonUrl(url);
    console.log(`[Amazon Scraper] ⚡ 暴力瘦身網址: ${cleanUrl}`);

    try {
        const SCRAPER_API_KEY = process.env.SCRAPER_API_KEY;
        if (!SCRAPER_API_KEY) throw new Error('Missing Proxy API Key');

        // 判斷國家代碼，讓 Proxy 派發當地的 IP，成功率大增
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
            // 如果 DOM 被改了，用 title 標籤暴力拆解
            title = $('title').text().replace('Amazon.com:', '').replace('Amazon.co.jp:', '').trim();
        }

        // 💡 黑魔法 3：多重暴力萃取價格 (Amazon DOM 結構極度多變)
        let priceRaw =
            $('.priceToPay span.a-offscreen').first().text().trim() ||
            $('#corePriceDisplay_desktop_feature_div .a-price-whole').first().text().trim() ||
            $('#corePrice_feature_div .a-offscreen').first().text().trim() ||
            $('#priceblock_ourprice').text().trim() ||
            $('#priceblock_dealprice').text().trim() ||
            $('.a-color-price').first().text().trim();

        let price = 0;

        if (priceRaw) {
            // 清理文字，只保留數字和少數小數點
            price = parseFloat(priceRaw.replace(/[^0-9.]/g, ''));
        }

        // 💡 黑魔法 4：如果 DOM 抓不到價格，直接用 Regex 掃描網頁底層的隱藏變數庫
        if (price === 0) {
            const priceMatch = html.match(/"priceAmount":\s*([\d.]+)/) ||
                html.match(/"price":\s*([\d.]+)/) ||
                html.match(/data-asin-price="([\d.]+)"/);
            if (priceMatch) {
                price = parseFloat(priceMatch[1]);
                console.log(`[Amazon Scraper] ⚠️ DOM 解析失敗，透過底層 Regex 暴力抓出價格: ${price}`);
            }
        }

        // 判斷幣種 (優先從網頁顯示判斷，否則從網址推斷)
        let currency = 'USD';
        if (/NT\$|TWD|NTD/.test(priceRaw)) currency = 'TWD';
        else if (/¥|JPY|円/.test(priceRaw) || cleanUrl.includes('.co.jp')) currency = 'JPY';
        else if (/€|EUR/.test(priceRaw) || cleanUrl.includes('.de')) currency = 'EUR';
        else if (/£|GBP/.test(priceRaw) || cleanUrl.includes('.co.uk')) currency = 'GBP';

        // 萃取圖片
        let image = $('#landingImage').attr('data-old-hires') || $('#landingImage').attr('src');
        if (!image) {
            // 暴力搜尋底層的圖片陣列
            const imgMatch = html.match(/"large":"(https:\/\/[^"]+)"/);
            if (imgMatch) image = imgMatch[1];
        }

        if (!title || price === 0) {
            throw new Error('解析失敗：可能被要求輸入驗證碼，或版面已變更');
        }

        console.log(`[Amazon Scraper] ✅ 成功取得資料: ${title.substring(0, 30)}... | 價格: ${price} ${currency}`);

        // 💡 黑魔法 5：終極 Twister 解析器 (無差別 DOM 掃描 + ASIN 智能合併)
        let exactVariants = [];
        let availableVariants = {};
        const hostname = new URL(cleanUrl).hostname;

        // 引擎 A: 隱藏腳本攔截 (攔截 Amazon 底層的 ASIN 陣列)
        try {
            let scriptData = '';
            $('script').each((i, el) => {
                const text = $(el).html();
                if (text && text.includes('dimensionValuesDisplayData')) {
                    scriptData += text;
                }
            });

            if (scriptData) {
                // 使用更具包容性的 Regex 來擷取整個 JSON 物件
                const dimDisplayMatch = scriptData.match(/"dimensionsDisplay"\s*:\s*(\[[^\]]+\])/);
                const varValuesMatch = scriptData.match(/"variationValues"\s*:\s*(\{.*?\})\s*,\s*"/);
                const dimValuesMatch = scriptData.match(/"dimensionValuesDisplayData"\s*:\s*(\{.*?\})\s*,\s*"/);

                if (dimDisplayMatch && varValuesMatch && dimValuesMatch) {
                    const dimensions = JSON.parse(dimDisplayMatch[1]);
                    const varValues = JSON.parse(varValuesMatch[1]);
                    const dimToAsin = JSON.parse(dimValuesMatch[1]);

                    for (const key in varValues) {
                        const cleanKey = key.replace(/_name$/, '').toUpperCase();
                        availableVariants[cleanKey] = varValues[key];
                    }

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
                                price: price,
                                currency: currency,
                                image: image
                            });
                        }
                    }
                    console.log(`[Amazon Scraper] 🎯 JSON 解碼成功，找到 ${exactVariants.length} 個真實 ASIN！`);
                }
            }
        } catch (e) {
            console.warn('[Amazon Scraper] JSON 矩陣解析失敗，啟動無差別掃描');
        }

        // 引擎 B: 終極 DOM 掃描 (如果 JSON 沒抓到，直接強拆所有變體區塊)
        if (exactVariants.length === 0) {
            // 涵蓋 PC 版、Mobile 版、以及同捆包(Bundle)的常見變體容器
            const variantContainers = $('#twister_feature_div, #twister, #twisterContainer, #mobileTwisterContainer, [id^="variation_"]');

            variantContainers.each((i, container) => {
                let dimName = $(container).find('label.a-form-label, .a-color-secondary').first().text().replace(/:/g, '').trim();
                if (!dimName) {
                    const id = $(container).attr('id') || '';
                    if (id.includes('color')) dimName = 'Color';
                    else if (id.includes('size')) dimName = 'Size';
                    else if (id.includes('style')) dimName = 'Style';
                    else dimName = 'Option';
                }

                const options = [];

                // 掃描所有可能的按鈕 (li, div 等等)
                $(container).find('li, .twister-item, .swatchAvailable').each((j, el) => {
                    let optVal = $(el).attr('title') || $(el).attr('data-csa-c-item-title') || $(el).find('.a-size-base, .twisterTextDiv').text() || $(el).find('img').attr('alt') || $(el).text();
                    optVal = optVal.replace(/^Click to select /i, '').replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();

                    // 無差別尋找 ASIN 網址
                    let targetAsin = $(el).attr('data-defaultasin') || $(el).attr('data-csa-c-item-id');

                    if (!targetAsin) {
                        const dpUrl = $(el).attr('data-dp-url') || $(el).find('a').attr('href') || '';
                        const urlMatch = dpUrl.match(/\/dp\/([A-Z0-9]{10})/);
                        if (urlMatch) targetAsin = urlMatch[1];
                    }

                    if (optVal && optVal !== 'Select' && optVal !== '-1' && optVal.length < 40) {
                        options.push(optVal);

                        if (targetAsin && targetAsin.length === 10) {
                            exactVariants.push({
                                sku: targetAsin,
                                spec: optVal,
                                url: `https://${hostname}/dp/${targetAsin}`,
                                price: price,
                                currency: currency,
                                image: $(el).find('img').attr('src') || image // 順便抓變體的小圖
                            });
                        }
                    }
                });

                // 掃描下拉選單 (select)
                $(container).find('select option').each((j, opt) => {
                    let optVal = $(opt).text().replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
                    let valAttr = $(opt).attr('value');

                    let targetAsin = (valAttr && (valAttr.match(/([A-Z0-9]{10})/) || [])[1]);

                    if (optVal && optVal !== 'Select' && optVal !== '-1' && optVal.length < 40) {
                        options.push(optVal);
                        if (targetAsin && targetAsin.length === 10) {
                            exactVariants.push({
                                sku: targetAsin,
                                spec: optVal,
                                url: `https://${hostname}/dp/${targetAsin}`,
                                price: price,
                                currency: currency,
                                image: image
                            });
                        }
                    }
                });

                if (options.length > 0) {
                    availableVariants[dimName] = [...new Set(options)];
                }
            });

            if (exactVariants.length > 0) {
                console.log(`[Amazon Scraper] 🎯 DOM 終極強拆成功，共搜集到 ${exactVariants.length} 個屬性標籤！`);
            }
        }

        // 🚨 關鍵防護：將散落的屬性智能合併 (例如把「White」和「256GB」合併成「White / 256GB」)
        const uniqueMap = new Map();
        for (const v of exactVariants) {
            if (uniqueMap.has(v.sku)) {
                const existing = uniqueMap.get(v.sku);
                // 避免重複加入相同的字眼
                if (!existing.spec.includes(v.spec)) {
                    existing.spec = existing.spec + ' / ' + v.spec;
                }
                // 如果有找到小圖，優先使用小圖
                if (v.image && v.image !== image) existing.image = v.image;
            } else {
                uniqueMap.set(v.sku, v);
            }
        }
        exactVariants = Array.from(uniqueMap.values());

        // 清理空屬性
        for (const key in availableVariants) {
            if (!availableVariants[key] || availableVariants[key].length === 0) {
                delete availableVariants[key];
            }
        }

        const needsVariant = Object.keys(availableVariants).length > 0 || exactVariants.length > 0;
        if (needsVariant) {
            console.log(`[Amazon Scraper] 📦 發現多規格商品！最終整理出 ${exactVariants.length} 個獨立 ASIN。`);
        }

        if (!title || price === 0) {
            throw new Error('解析失敗：可能被要求輸入驗證碼，或版面已變更');
        }

        console.log(`[Amazon Scraper] ✅ 成功取得資料: ${title.substring(0, 30)}... | 價格: ${price} ${currency}`);

        // 整理傳回結果
        return {
            productInfo: {
                source: 'amazon_proxy_scraper_v4',
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
        throw error;
    }
}

module.exports = { scrape };