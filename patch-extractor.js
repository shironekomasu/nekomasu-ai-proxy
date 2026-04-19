const fs = require('fs');
let content = fs.readFileSync('services/extractor.js', 'utf8');

// Replace the seoMeta block to also consume domTotalPrice and ogCurrency
const oldBlock = `            let priceJpy = seoMeta.ogPrice ? parseInt(seoMeta.ogPrice, 10) : 0;`;
const newBlock = `            // [Global] Try to use the DOM-extracted total price and og:currency first
            let priceJpy = 0;
            let detectedCurrency = seoMeta.ogCurrency || 'JPY';

            // Priority 1: Scraper already found a rendered total price in DOM (e.g., Wooting configurator)
            if (seoMeta.domTotalPrice) {
                const raw = parseFloat(seoMeta.domTotalPrice.replace(/[^0-9.]/g, ''));
                if (!isNaN(raw) && raw > 0) {
                    priceJpy = raw;
                    // If the currency is unknown but price looks like TWD range, assume TWD
                    if (!seoMeta.ogCurrency) detectedCurrency = (raw > 500 && raw < 200000) ? 'TWD' : 'USD';
                    console.log('[Extractor] Using DOM total price:', priceJpy, detectedCurrency);
                }
            }

            // Priority 2: og meta tags
            if (priceJpy === 0 && seoMeta.ogPrice) {
                priceJpy = parseFloat(seoMeta.ogPrice);
            }`;

if (content.includes(oldBlock)) {
    content = content.replace(oldBlock, newBlock);
    // Now remove the duplicate detectedCurrency declaration below (it will conflict)
    content = content.replace(`            let detectedCurrency = 'JPY';`, `            // detectedCurrency is already initialized above`);
    console.log('Replaced ogPrice block successfully');
} else {
    console.log('WARNING: ogPrice block not found!');
    console.log('Context:', content.substring(content.indexOf('ogPrice'), content.indexOf('ogPrice') + 200));
}

// Add global 13000 TWD sanity cap
const capTarget = `            // 全域防呆：鍵盤/模型等周邊如果超過 1000 "美金"，絕對是系統錯誤判讀了 TWD，強制修正`;
const newCap = `            // [使用者指定規則] Wooting 等商品最高不超過 NT$13,000，超過一律視為幣種誤判
            if (priceJpy > 13000 && detectedCurrency === 'USD') {
                console.log('[Extractor] Price exceeds 13000 TWD threshold, overriding currency to TWD');
                detectedCurrency = 'TWD';
            }

            // 全域防呆：鍵盤/模型等周邊如果超過 1000 "美金"，絕對是系統錯誤判讀了 TWD，強制修正`;

content = content.replace(capTarget, newCap);

fs.writeFileSync('services/extractor.js', content, 'utf8');
console.log('extractor.js patched. Length:', content.length);
