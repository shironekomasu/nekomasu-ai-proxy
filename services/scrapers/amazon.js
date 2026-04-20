// ─── proxy-engine/services/scrapers/amazon.js ───
const axios = require('axios');
const cheerio = require('cheerio');

async function scrape(url, selectedOptions = []) {
    console.log(`[Amazon Scraper] ⚡ 走 API 極速路線抓取: ${url}`);

    try {
        // 1. 發送高度偽裝的 Axios 請求 (模擬真實瀏覽器)
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9,zh-TW;q=0.8,zh;q=0.7',
                'Accept-Encoding': 'gzip, deflate, br',
                'Connection': 'keep-alive',
                'Upgrade-Insecure-Requests': '1',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'none',
                'Sec-Fetch-User': '?1',
                'Cache-Control': 'max-age=0',
            },
            timeout: 15000 // 15 秒 Timeout
        });

        const html = response.data;
        const $ = cheerio.load(html);

        // 2. 檢查是否撞到 Amazon 的反爬蟲驗證碼 (CAPTCHA) 或機器人阻擋牆
        if ($('title').text().includes('Robot Check') || $('form[action="/errors/validateCaptcha"]').length > 0) {
            console.warn(`[Amazon Scraper] 🚨 被 Amazon 驗證碼牆擋住了！`);
            throw new Error('Amazon CAPTCHA blocked');
            // 拋出錯誤後，Router 會自動切換回通用爬蟲 (Playwright Stealth) 進行救援
        }

        // 3. 萃取商品標題
        const title = $('#productTitle').text().trim() || $('#title').text().trim();

        // 4. 萃取商品價格 (Amazon 的價格 DOM 結構非常多變，需要多重 Fallback)
        let priceRaw =
            $('.priceToPay span.a-offscreen').first().text().trim() ||
            $('#corePriceDisplay_desktop_feature_div .a-price-whole').first().text().trim() ||
            $('#priceblock_ourprice').text().trim() ||
            $('#priceblock_dealprice').text().trim() ||
            $('.a-color-price').first().text().trim();

        let price = 0;
        if (priceRaw) {
            // 清理文字，只保留數字和少數小數點
            price = parseFloat(priceRaw.replace(/[^0-9.]/g, ''));
        }

        // 5. 判斷幣種 (從網址判斷最準確)
        let currency = 'USD';
        if (url.includes('amazon.co.jp')) currency = 'JPY';
        else if (url.includes('amazon.de') || url.includes('amazon.fr') || url.includes('amazon.nl')) currency = 'EUR';
        else if (url.includes('amazon.co.uk')) currency = 'GBP';

        // 6. 萃取主圖 (優先抓取 Amazon 的高畫質原圖)
        let image = $('#landingImage').attr('data-old-hires') || $('#landingImage').attr('src');
        if (!image) {
            // 有時候圖片是寫在 Javascript 的動態物件裡，用正則硬洗出來
            const imgMatch = html.match(/"large":"(https:\/\/[^"]+)"/);
            if (imgMatch) image = imgMatch[1];
        }

        // 若標題或價格抓不到，判定解析失敗，退回給 Playwright 處理
        if (!title || price === 0) {
            throw new Error('無法精準萃取標題或價格 (版面可能已變更)');
        }

        console.log(`[Amazon Scraper] ✅ 成功取得資料: ${title.substring(0, 30)}... | 價格: ${price} ${currency}`);

        return {
            productInfo: {
                source: 'amazon_api_scraper',
                title: title,
                original_price: price,
                original_currency: currency,
                image: image || '',
                variants: [], // API 極速版專注於當前選中的規格網址
            },
            availableVariants: {},
            seoMeta: {}
        };

    } catch (error) {
        console.warn(`[Amazon Scraper] ⚠️ API 抓取失敗: ${error.message}，準備退回通用 AI 爬蟲...`);
        throw error; // 這裡把錯誤丟出去，scraper-router.js 的 try-catch 就會接手，完美觸發 Fallback
    }
}

module.exports = { scrape };