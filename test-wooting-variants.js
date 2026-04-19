const scraper = require('./services/scraper');
const cheerio = require('cheerio');

async function test() {
    try {
        const url = 'https://wooting.io/configurator/wooting-80he?keycaps=none';
        console.log('Scraping...');
        const scrapeResult = await scraper.scrapeTarget(url);
        
        const $ = cheerio.load(scrapeResult.cleanHtml);
        let foundJSON = false;
        $('script[type="application/json"], script[id="__NEXT_DATA__"]').each((i, el) => {
            console.log('--- FOUND SCRIPT ---');
            console.log($(el).text().substring(0, 1000));
            foundJSON = true;
        });
        
        if (!foundJSON) {
            console.log('No JSON data found in script tags. Dumping all text looking for prices:');
            const text = $.text();
            console.log(text.match(/[$€¥￥]\s*[0-9,.]+/g));
        }
        
    } catch(err) {
        console.error(err);
    }
}
test();
