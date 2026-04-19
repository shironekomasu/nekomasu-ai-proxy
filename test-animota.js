const scraper = require('./services/scraper');
const extractor = require('./services/extractor');

async function test() {
    try {
        const url = 'https://animota.net/products/animota-e-pre5699?variant=47893472477432';
        console.log('Scraping...');
        const scrapeResult = await scraper.scrapeTarget(url);
        console.log('Extracting...');
        const data = await extractor.extractProductContext(scrapeResult.cleanHtml, scrapeResult.seoMeta);
        console.log('Data:', data);
        await scraper.close();
    } catch(err) {
        console.error(err);
    }
}
test();
