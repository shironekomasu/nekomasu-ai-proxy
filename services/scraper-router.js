const { smartScrape: genericScrape } = require('./smart-scraper');
const amazonScraper = require('./scrapers/amazon');

const DOMAIN_STRATEGIES = {
    'amazon.com': amazonScraper,
    'amazon.co.jp': amazonScraper,
};

async function routeScrape(url, selectedOptions) {
    try {
        const parsedUrl = new URL(url);
        let hostname = parsedUrl.hostname;
        
        // Remove "www." if present
        if (hostname.startsWith('www.')) {
            hostname = hostname.substring(4);
        }

        const strategy = DOMAIN_STRATEGIES[hostname];

        if (strategy) {
            console.log(`[Router] 發現專屬爬蟲策略: ${hostname}`);
            return await strategy.scrape(url, selectedOptions);
        }

        console.log(`[Router] 套用通用 AI 爬蟲策略: ${hostname}`);
        const result = await genericScrape(url, selectedOptions);

        // 異常偵測 (Anomaly Detection)
        if (result && result.productInfo) {
            const variantCount = Array.isArray(result.productInfo.variants) 
                ? result.productInfo.variants.length 
                : 0;
            const price = result.productInfo.price !== undefined 
                ? result.productInfo.price 
                : result.productInfo.original_price;
            
            if (variantCount > 20 || price === 0) {
                console.log(`[Anomaly Report] ⚠️ 此網站需要開發專屬爬蟲: ${url}`);
            }
        }

        return result;

    } catch (e) {
        console.error(`[Router Error] 解析或調度時發生錯誤: ${e.message}`);
        // 回退至通用模組
        return await genericScrape(url, selectedOptions);
    }
}

module.exports = { routeScrape };
