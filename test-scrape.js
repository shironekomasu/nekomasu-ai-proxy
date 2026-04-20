require('dotenv').config();
const { smartScrape } = require('./services/smart-scraper');

(async () => {
    try {
        const result = await smartScrape('https://store.vspo.jp/products/en-teamjacket-sticketset');
        console.log("SUCCESS:", JSON.stringify(result, null, 2));
    } catch (e) {
        console.error("FAILED:", e);
    }
    process.exit(0);
})();
