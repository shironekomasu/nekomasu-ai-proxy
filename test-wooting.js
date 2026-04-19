const scraper = require('./services/scraper');
const extractor = require('./services/extractor');

async function test() {
    try {
        const url = 'https://wooting.io/configurator/wooting-80he?keycaps=none';
        console.log('Scraping...');
        const scrapeResult = await scraper.scrapeTarget(url);
        
        console.log('--- Clean HTML Snippet (first 2000 chars) ---');
        console.log(scrapeResult.cleanHtml.substring(0, 2000));
        
        console.log('Extracting...');
        const data = await extractor.extractProductContext(scrapeResult.cleanHtml, scrapeResult.seoMeta);
        console.log('Data:', data);
    } catch(err) {
        console.error(err);
    }
}
test();
