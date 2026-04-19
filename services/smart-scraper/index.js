// ─── proxy-engine/services/smart-scraper/index.js ───
// 🤖 智能爬蟲 Orchestrator：三階降維打擊策略總協調器
'use strict';

const { chromium } = require('playwright');
const { addExtra } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { parseSSRState, interceptNetworkAPIs } = require('./tier1-intercept');
const { clickOptionsByText, findPriceByAnchor, sniffAvailableOptions } = require('./tier2-semantic');
const { runTier3 } = require('./tier3-ai');

// 套用 Stealth 防反爬蟲（addExtra + puppeteer-extra-plugin-stealth 相容 Playwright）
const playwrightStealth = addExtra(chromium);
playwrightStealth.use(StealthPlugin());

// ──────────────────────────────────────────────
// 幣種地區感知識別
// ──────────────────────────────────────────────
const DOMAIN_CURRENCY_MAP = {
    'wooting.io':        'TWD',   // 對台灣 IP 預設台幣
    'amazon.co.jp':      'JPY',
    'mercari.com':       'JPY',
    'rakuten.co.jp':     'JPY',
    'coupang.com':       'KRW',
    'amazon.de':         'EUR',
    'amazon.fr':         'EUR',
    'amazon.co.uk':      'GBP',
    'amazon.com':        'USD',
    'ebay.com':          'USD',
};

function inferCurrencyFromUrl(url) {
    try {
        const hostname = new URL(url).hostname;
        for (const [domain, currency] of Object.entries(DOMAIN_CURRENCY_MAP)) {
            if (hostname.includes(domain)) return currency;
        }
        // TLD fallback
        if (hostname.endsWith('.jp'))  return 'JPY';
        if (hostname.endsWith('.kr'))  return 'KRW';
        if (hostname.endsWith('.tw'))  return 'TWD';
        if (hostname.endsWith('.de') || hostname.endsWith('.fr') || hostname.endsWith('.nl')) return 'EUR';
    } catch {}
    return null;
}

/**
 * 正規化三個 Tier 可能返回的各種格式 → 統一的輸出物件
 */
function normalizeOutput(tierResult, url) {
    if (!tierResult?.product) return null;
    const p = tierResult.product;

    const detectedCurrency =
        (p.currency && !['UNKNOWN', 'DETECT'].includes(p.currency))
            ? p.currency
            : (inferCurrencyFromUrl(url) || 'USD');

    // Tier1 已經處理好了幣值單位，這裡不再重複除以 100
    const rawVariants = p.variants || [];
    const variants = rawVariants.map(v => ({
        name: v.spec ?? v.title ?? v.name ?? '',
        price: parseFloat(v.price ?? 0),
        currency: (v.currency && !['UNKNOWN', 'DETECT'].includes(v.currency)) ? v.currency : detectedCurrency,
        image: v.image || '',
    }));

    return {
        title:             p.title ?? p.product_name ?? p.name ?? '',
        original_price:    p.price || (variants[0]?.price || 0),
        original_currency: detectedCurrency,
        image:             p.image ?? p.featured_image ?? '',
        variants,
        source:            tierResult.source,
    };
}

// ──────────────────────────────────────────────
// 主入口
// ──────────────────────────────────────────────
async function smartScrape(url, selectedOptions = []) {
    console.log(`\n🤖 [SmartScraper] Starting: ${url}`);
    const t0 = Date.now();

    let browser;
    try {
        browser = await playwrightStealth.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        });

        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            locale: 'zh-TW',
            timezoneId: 'Asia/Taipei',
        });
        const page = await context.newPage();

        // 阻擋字型 / 媒體，保留圖片 URL 以備後用
        await page.route('**/*', (route) => {
            const type = route.request().resourceType();
            ['font', 'media'].includes(type) ? route.abort() : route.continue();
        });

        // ── Tier 1A：掛 XHR 攔截（在 goto 前掛 listener）
        let xhrResult = null;
        const xhrPromise = interceptNetworkAPIs(page, url).then(r => { xhrResult = r; });

        let scrapeUrl = url;
        const inferredTargetCurr = inferCurrencyFromUrl(url);
        if (inferredTargetCurr && !url.includes('currency=')) {
            scrapeUrl += (url.includes('?') ? '&' : '?') + 'currency=' + inferredTargetCurr;
            console.log(`[SmartScraper] 🌐 Forced Local Currency: ${scrapeUrl}`);
        }

        // ── 導覽（等 networkidle 讓 SPA / GraphQL 完成所有請求）
        console.log('[SmartScraper] Navigating to page...');
        try {
            await page.goto(scrapeUrl, { waitUntil: 'networkidle', timeout: 35000 });
        } catch (e) {
            console.log(`[SmartScraper] ⚠️ page.goto networkidle timeout or error: ${e.message.split('\n')[0]}`);
            // 由於部分含有長連結 websocket或 analytics 的網站無法到達 networkidle 狀態
            // 只要 HTML 載入一半，或 XHR 已經攔截完成，我們依舊可以繼續執行
        }
        const html = await page.content(); // Keep original HTML for SSR parser

        // ── 去除不相干的區域（如：相關文章、推薦商品、輪播），避免 Tier2/3 爬到無關變數 ──
        await page.evaluate(() => {
            const selectors = [
                'footer', 'header', 'nav', 'aside',
                '[class*="related" i]', '[id*="related" i]',
                '[class*="recommend" i]', '[id*="recommend" i]',
                '[class*="carousel" i]', '[id*="carousel" i]',
                '[class*="sidebar" i]', '[id*="sidebar" i]'
            ];
            try {
                document.querySelectorAll(selectors.join(',')).forEach(el => el.remove());
            } catch(e) {}
        });
        const prunedHtml = await page.content();

        // ── Tier 1B：SSR 靜態解析
        const ssrResult = parseSSRState(html);
        const ssrNorm = ssrResult?.product ? normalizeOutput(ssrResult, url) : null;
        const xhrNorm = xhrResult?.product ? normalizeOutput(xhrResult, url) : null;

        let productInfo = null;

        if (ssrNorm && xhrNorm) {
            console.log(`[Tier1 Arbiter] ssrNorm variants: ${ssrNorm.variants.length}, xhrNorm variants: ${xhrNorm.variants.length}`);
            // 比較兩者，若 XHR 有相等或更多規格，以 XHR 為主（Shopify JSON API 含有圖片 id 對應，比普通 JSON-LD 或 meta 豐富）
            if (xhrNorm.variants.length >= ssrNorm.variants.length) {
                productInfo = xhrNorm;
                console.log(`✅ [Tier1-XHR] (Overrides SSR due to richer variant data) ${Date.now() - t0}ms`);
            } else {
                productInfo = ssrNorm;
                console.log(`✅ [Tier1-SSR] ${Date.now() - t0}ms`);
            }
        } else if (ssrNorm) {
            productInfo = ssrNorm;
            console.log(`✅ [Tier1-SSR] ${Date.now() - t0}ms`);
        } else if (xhrNorm) {
            productInfo = xhrNorm;
            console.log(`✅ [Tier1-XHR] ${Date.now() - t0}ms`);
        }

        // ── Tier 2A：點擊規格（無論哪個 Tier 都可能需要）
        if (selectedOptions.length > 0) {
            await clickOptionsByText(page, selectedOptions);
        }

        // ── 嗅探可用規格（卡片展示用）
        const availableVariants = await sniffAvailableOptions(page);

        // ── Tier 2B：語意錨點找價格
        if (!productInfo) {
            const anchor = await findPriceByAnchor(page);
            if (anchor) {
                const currency = (anchor.currency === 'DETECT' || anchor.currency === 'UNKNOWN')
                    ? (inferCurrencyFromUrl(url) || 'TWD')
                    : anchor.currency;
                productInfo = {
                    title:             await page.title(),
                    original_price:    anchor.price,
                    original_currency: currency,
                    image:             await page.$eval('meta[property="og:image"]', e => e.content).catch(() => ''),
                    variants:          [],
                    source:            'tier2_anchor',
                };
                console.log(`✅ [Tier2] ${Date.now() - t0}ms`);
            }
        }

        // ── Tier 3：AI HTML→Markdown→LLM
        if (!productInfo) {
            const t3 = await runTier3(prunedHtml, url);
            if (t3?.product) {
                productInfo = normalizeOutput(t3, url);
                console.log(`✅ [Tier3] ${Date.now() - t0}ms`);
            }
        }

        const seoMeta = await page.evaluate(() => ({
            ogTitle:    document.querySelector('meta[property="og:title"]')?.content,
            ogImage:    document.querySelector('meta[property="og:image"]')?.content,
            ogCurrency: document.querySelector('meta[property="product:price:currency"]')?.content,
        }));

        if (productInfo) {
            if (!productInfo.title  && seoMeta.ogTitle) productInfo.title = seoMeta.ogTitle;
            if (!productInfo.image  && seoMeta.ogImage) productInfo.image = seoMeta.ogImage;
        }

        console.log(`🏁 [SmartScraper] Done ${Date.now() - t0}ms | tier=${productInfo?.source || 'FAILED'}`);
        return { productInfo, availableVariants, html, seoMeta };

    } finally {
        if (browser) await browser.close().catch(() => {});
    }
}

module.exports = { smartScrape };
