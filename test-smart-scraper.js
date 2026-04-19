// ─── proxy-engine/test-smart-scraper.js ───
// 驗證三階降維智能爬蟲的完整端對端測試
// 執行方式: node test-smart-scraper.js

'use strict';

const { smartScrape } = require('./services/smart-scraper');
const calculator = require('./services/calculator');

const TEST_CASES = [
    {
        name: 'Wooting 80HE Module + Keycaps (TWD, Shopify Headless)',
        url: 'https://wooting.io/configurator/wooting-80he?keycaps=45070587101407&product=module&switches=none',
        expectedCurrency: 'TWD',
        expectedPriceRange: [3000, 13000],
        options: []
    },
    {
        name: 'Wooting 80HE 基本款 (無 keycaps)',
        url: 'https://wooting.io/configurator/wooting-80he?keycaps=none',
        expectedCurrency: 'TWD',
        expectedPriceRange: [1000, 13000],
        options: []
    }
];

async function runTests() {
    console.log('\n🧪 ========================================');
    console.log('   三階降維智能爬蟲系統 - 端對端測試');
    console.log('==========================================\n');

    let passed = 0;
    let failed = 0;

    for (const tc of TEST_CASES) {
        console.log(`\n▶ 測試: ${tc.name}`);
        console.log(`  URL: ${tc.url}`);
        const start = Date.now();

        try {
            const { productInfo, availableVariants } = await smartScrape(tc.url, tc.options);

            if (!productInfo) {
                console.log(`  ❌ FAILED: productInfo 為 null`);
                failed++;
                continue;
            }

            // 驗算
            const pricing = await calculator.estimateTotal(
                productInfo.original_price,
                productInfo.original_currency,
                0.8,
                { l: 40, w: 15, h: 5 }
            );

            const elapsed = Date.now() - start;
            const priceOk = productInfo.original_price >= tc.expectedPriceRange[0]
                         && productInfo.original_price <= tc.expectedPriceRange[1];
            const currencyOk = productInfo.original_currency === tc.expectedCurrency;

            console.log(`\n  📦 商品標題   : ${productInfo.title}`);
            console.log(`  💴 原始售價   : ${productInfo.original_price} ${productInfo.original_currency}  ${priceOk ? '✅' : '❌ 超出預期範圍'}`);
            console.log(`  🌐 幣種識別   : ${productInfo.original_currency}  ${currencyOk ? '✅' : '❌ 幣種不符'}`);
            console.log(`  🏆 使用階段   : ${productInfo.source}`);
            console.log(`  🛒 最終估價   : NT$ ${pricing.total_twd.toLocaleString()}`);
            console.log(`  ⏱  耗時       : ${(elapsed / 1000).toFixed(1)}s`);
            console.log(`  📋 規格群組數 : ${Object.keys(availableVariants || {}).length}`);

            if (priceOk && currencyOk) {
                console.log(`  ✅ PASSED`);
                passed++;
            } else {
                console.log(`  ❌ FAILED`);
                failed++;
            }

        } catch (e) {
            console.log(`  ❌ ERROR: ${e.message}`);
            failed++;
        }
    }

    console.log(`\n==========================================`);
    console.log(`  測試結果: ${passed} 通過 / ${failed} 失敗`);
    console.log(`==========================================\n`);
    process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(e => {
    console.error('測試框架異常:', e);
    process.exit(1);
});
