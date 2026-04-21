// ─── proxy-engine/services/scrapers/amazon.js ───
const axios = require('axios');
const cheerio = require('cheerio');

async function scrape(url, selectedOptions = []) {
    console.log(`[Amazon Scraper] ⚡ 透過 Proxy API 抓取: ${url}`);

    try {
        // 🚨 秘密武器：將原本直接打 Amazon 的網址，交給 ScraperAPI 代發
        const SCRAPER_API_KEY = process.env.SCRAPER_API_KEY || '你的免費API_KEY';
        const proxyUrl = `http://api.scraperapi.com/?api_key=${SCRAPER_API_KEY}&url=${encodeURIComponent(url)}`;

        // 加入「超時自動換節點重試」機制
        let response;
        try {
            // 第一次嘗試：給 15 秒。如果分到慢的 IP 就快刀斬亂麻
            response = await axios.get(proxyUrl, { timeout: 15000 });
        } catch (err) {
            // 如果是超時錯誤，立刻觸發重試
            if (err.code === 'ECONNABORTED' || err.message.includes('timeout')) {
                console.log(`[Amazon Scraper] ⏳ 代理節點回應太慢，自動切換 IP 重新發送請求...`);
                // 第二次嘗試：再給 15 秒，ScraperAPI 會自動分派一個全新的乾淨 IP
                response = await axios.get(proxyUrl, { timeout: 15000 });
            } else {
                throw err; // 如果是 401 或其他錯誤，直接拋出
            }
        }

        const html = response.data;
        const $ = cheerio.load(html);

        // --- 以下的解析邏輯完全不變 ---
        const title = $('#productTitle').text().trim() || $('#title').text().trim();
        let priceRaw =
            $('.priceToPay span.a-offscreen').first().text().trim() ||
            $('#corePriceDisplay_desktop_feature_div .a-price-whole').first().text().trim() ||
            $('#priceblock_ourprice').text().trim() ||
            $('.a-color-price').first().text().trim();

        let price = 0;
        if (priceRaw) price = parseFloat(priceRaw.replace(/[^0-9.]/g, ''));

        let currency = 'USD';
        if (/NT\$|TWD|NTD/.test(priceRaw)) currency = 'TWD';
        else if (/¥|JPY|円/.test(priceRaw)) currency = 'JPY';
        else if (url.includes('amazon.co.jp')) currency = 'JPY';

        let image = $('#landingImage').attr('data-old-hires') || $('#landingImage').attr('src');
        if (!image) {
            const imgMatch = html.match(/"large":"(https:\/\/[^"]+)"/);
            if (imgMatch) image = imgMatch[1];
        }

        if (!title || price === 0) throw new Error('解析失敗 (可能版面變更或依然被擋)');

        console.log(`[Amazon Scraper] ✅ 成功取得資料: ${title.substring(0, 30)}... | 價格: ${price} ${currency}`);

        return {
            productInfo: {
                source: 'amazon_proxy_scraper',
                title: title,
                original_price: price,
                original_currency: currency,
                image: image || '',
                variants: [],
            },
            availableVariants: {},
            seoMeta: {}
        };

    } catch (error) {
        // 攔截並印出 Axios 的狀態碼，方便知道是不是 Proxy 也被擋了
        const status = error.response ? error.response.status : 'N/A';
        console.warn(`[Amazon Scraper] ⚠️ 抓取失敗 (Status: ${status}): ${error.message}`);
        throw error; // 退回給 Router 的 Playwright 處理
    }
}

module.exports = { scrape };