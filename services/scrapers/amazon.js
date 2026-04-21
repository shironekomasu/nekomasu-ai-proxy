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

        // 💡 黑魔法 2：加上 premium=true，強迫 ScraperAPI 使用「真實家庭住宅 IP」去撞 Amazon
        const proxyUrl = `http://api.scraperapi.com/?api_key=${SCRAPER_API_KEY}&url=${encodeURIComponent(cleanUrl)}&premium=true&country_code=${countryCode}`;

        console.log(`[Amazon Scraper] 🚀 發送高匿蹤請求...`);

        let response;
        try {
            // 給予 15 秒的時間，不行就馬上重試切換 IP
            response = await axios.get(proxyUrl, { timeout: 15000 });
        } catch (err) {
            if (err.code === 'ECONNABORTED' || err.message.includes('timeout')) {
                console.log(`[Amazon Scraper] ⏳ 節點回應太慢，自動切換高匿蹤 IP 重新撞擊...`);
                response = await axios.get(proxyUrl, { timeout: 15000 });
            } else {
                throw err;
            }
        }

        const html = response.data;
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

        // 💡 黑魔法 5：暴力破解 Amazon Twister (變體選項)
        const availableVariants = {};

        $('#twister > .a-section, #twisterContainer .a-section, #twister .a-row').each((i, el) => {
            // 找維度名稱 (例如 "Color:", "Size:")
            let dimName = $(el).find('label.a-form-label').text().replace(/:/g, '').trim();
            if (!dimName) dimName = $(el).find('.a-color-secondary').first().text().replace(/:/g, '').trim();

            if (dimName) {
                const options = [];

                // 類型 A: 按鈕清單 (尋找 <ul> <li>)
                $(el).find('ul li').each((j, li) => {
                    let optVal = $(li).attr('title'); // 通常長這樣："Click to select White"
                    if (optVal) {
                        optVal = optVal.replace(/^Click to select /i, '').trim();
                    } else {
                        // 備用方案：抓裡面的文字
                        optVal = $(li).find('.a-size-base').text().trim() || $(li).text().trim();
                    }

                    // 清洗文字，去掉換行符號
                    optVal = optVal.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();

                    // 過濾掉空值或太長的奇怪字串
                    if (optVal && !options.includes(optVal) && optVal.length < 30) {
                        options.push(optVal);
                    }
                });

                // 類型 B: 下拉選單 (尋找 <select> <option>)
                $(el).find('select option').each((j, opt) => {
                    const optVal = $(opt).text().trim();
                    if (optVal && optVal !== 'Select' && !options.includes(optVal) && optVal.length < 30) {
                        options.push(optVal);
                    }
                });

                if (options.length > 0) {
                    availableVariants[dimName] = options;
                }
            }
        });

        const needsVariant = Object.keys(availableVariants).length > 0;
        if (needsVariant) {
            console.log(`[Amazon Scraper] 📦 發現多規格商品！維度: ${Object.keys(availableVariants).join(', ')}`);
        }

        if (!title || price === 0) {
            throw new Error('解析失敗：可能被要求輸入驗證碼，或版面已變更');
        }

        console.log(`[Amazon Scraper] ✅ 成功取得資料: ${title.substring(0, 30)}... | 價格: ${price} ${currency}`);

        // 整理傳回結果
        return {
            productInfo: {
                source: 'amazon_proxy_scraper_v2',
                title: title,
                original_price: price,
                original_currency: currency,
                image: image || '',
                variants: [],
            },
            // 🚨 關鍵：告訴前端這個商品需要選規格！
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