// ─── proxy-engine/services/smart-scraper/tier1-intercept.js ───
// 🏆 第一階：攔截底層狀態與 API (成本 $0)
// 策略：在任何 HTML 渲染前，優先從 SSR 狀態 (NEXT_DATA, Shopify, Nuxt)
// 以及 XHR/Fetch 網路攔截中提取結構化 JSON 資料。

'use strict';

/**
 * 解析 SSR 嵌入狀態（免費，不需 AI）
 * @param {string} html - 原始 HTML 字串
 * @returns {object|null} 解析出的商品資料，或 null
 */
function parseSSRState(html) {
    const results = {};

    // --- Next.js: <script id="__NEXT_DATA__"> ---
    const nextDataMatch = html.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
    if (nextDataMatch) {
        try {
            const nextData = JSON.parse(nextDataMatch[1]);
            results.source = 'next_data';
            results.raw = nextData;
            // 深層搜尋 price / variants
            results.product = deepFindProduct(nextData);
            if (results.product) {
                console.log('[Tier1] ✅ Found data in __NEXT_DATA__');
                return results;
            }
        } catch (e) {
            console.log('[Tier1] __NEXT_DATA__ parse failed:', e.message);
        }
    }

    // --- Nuxt.js: window.__NUXT__ / window.__NUXT_DATA__ ---
    const nuxtMatch = html.match(/window\.__NUXT(?:_DATA)?__\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/i);
    if (nuxtMatch) {
        try {
            // eslint-disable-next-line no-eval
            const nuxtData = (0, eval)('(' + nuxtMatch[1] + ')');
            results.source = 'nuxt';
            results.raw = nuxtData;
            results.product = deepFindProduct(nuxtData);
            if (results.product) {
                console.log('[Tier1] ✅ Found data in window.__NUXT__');
                return results;
            }
        } catch (e) {
            console.log('[Tier1] __NUXT__ parse failed:', e.message);
        }
    }

    // --- Shopify: window.ShopifyAnalytics / meta.product ---
    const shopifyMatch = html.match(/ShopifyAnalytics\.meta\s*=\s*(\{[\s\S]*?\});/i)
        || html.match(/window\.meta\s*=\s*(\{[\s\S]*?\});/i)
        || html.match(/var\s+meta\s*=\s*(\{[\s\S]*?\});/i);
    if (shopifyMatch) {
        try {
            const jsonStr = shopifyMatch[1];
            // 由於可能含有未加引號的鍵，嘗試用 Function 或 eval
            const shopifyMeta = (new Function('return ' + jsonStr))();
            results.source = 'shopify_meta';
            results.raw = shopifyMeta;
            
            // Shopify 有時候把 currency 放在 meta 最外層
            const currency = shopifyMeta.currency || shopifyMeta.priceCurrency;

            results.product = deepFindProduct(shopifyMeta);
            if (results.product) {
                if (currency && results.product.currency === 'UNKNOWN') {
                    results.product.currency = currency;
                }
                console.log('[Tier1] ✅ Found data in ShopifyAnalytics.meta');
                return results;
            }
        } catch (e) {
            console.log('[Tier1] ShopifyAnalytics parse failed:', e.message);
        }
    }

    // --- Schema.org JSON-LD (Product) ---
    const ldMatches = [...html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)];
    for (const m of ldMatches) {
        try {
            const ld = JSON.parse(m[1]);
            const item = Array.isArray(ld) ? ld.find(i => i['@type'] === 'Product') : (ld['@type'] === 'Product' ? ld : null);
            if (item) {
                console.log('[Tier1] ✅ Found Schema.org Product in JSON-LD');
                results.source = 'json_ld';
                results.product = normalizeJsonLdProduct(item);
                return results;
            }
        } catch (e) {}
    }

    // --- Generic: 任意 <script> 裡的 JSON 含有 price/variants 關鍵字 ---
    const scriptMatches = [...html.matchAll(/<script(?![^>]+src)[^>]*>([\s\S]*?)<\/script>/gi)];
    for (const m of scriptMatches) {
        const content = m[1].trim();
        if (!content.startsWith('{') && !content.startsWith('[')) continue;
        if (!content.match(/"price"|"variants"|"sku"/i)) continue;
        try {
            const data = JSON.parse(content);
            const product = deepFindProduct(data);
            if (product) {
                console.log('[Tier1] ✅ Found product data in generic <script> JSON');
                results.source = 'generic_script';
                results.product = product;
                return results;
            }
        } catch (e) {}
    }

    console.log('[Tier1] ❌ No SSR state found.');
    return null;
}

/**
 * XHR / Fetch 攔截器 - 在 Playwright 頁面中掛載，等待 API 回應
 */
async function interceptNetworkAPIs(page, targetUrl = '') {
    return new Promise((resolve) => {
        let targetSlug = '';
        try {
            const parts = new URL(targetUrl).pathname.split('/');
            targetSlug = parts.pop() || parts.pop();
        } catch(e) {}

        const timeout = setTimeout(() => resolve(null), 35000);
        const PRICE_KEYWORDS = /price|variant|sku|product|offer|cart/i;
        const EXCLUDE_KEYWORDS = /also-bought|recommendations|related|cross-sell|upsell|cart\.js/i;
        
        let bestProduct = null;
        let maxVariants = -1;

        page.on('response', async (response) => {
            try {
                const url = response.url();
                if (EXCLUDE_KEYWORDS.test(url)) return;
                if (targetSlug && url.includes('/products/') && !url.includes(targetSlug) && !url.includes('/all')) return;

                const contentType = response.headers()['content-type'] || '';
                if (!contentType.includes('application/json')) return;
                if (!PRICE_KEYWORDS.test(url)) return;
                if (response.status() !== 200) return;

                const body = await response.json().catch(() => null);
                if (!body) return;

                const product = deepFindProduct(body);
                if (product) {
                    const vCount = product.variants ? product.variants.length : 0;
                    if (vCount > maxVariants) {
                        maxVariants = vCount;
                        bestProduct = { source: 'xhr_intercept', url, product };
                        // 若抓到含有超過 1 個規格的資料庫，那絕對是真的主商品，直接採納以節省時間
                        if (vCount > 1) {
                            console.log(`[Tier1] ✅ XHR intercepted (Has ${vCount} variants!): ${url.substring(0, 80)}`);
                            clearTimeout(timeout);
                            resolve(bestProduct);
                        } else {
                            console.log(`[Tier1] ⏳ XHR intercepted (0 variants, waiting for better match...): ${url.substring(0, 80)}`);
                        }
                    }
                }
            } catch (e) {}
        });

        page.once('load', () => {
            setTimeout(() => {
                if (bestProduct && maxVariants <= 1) {
                    clearTimeout(timeout);
                    resolve(bestProduct);
                }
            }, 1500); // 網頁載入後多等一下 XHR
        });
    });
}

// ──────────────────────────────────────────────
// 內部工具函式
// ──────────────────────────────────────────────

/**
 * 遞迴深層搜尋物件/陣列，尋找含有 price 或 variants 的商品節點
 */
function deepFindProduct(obj, depth = 0) {
    if (depth > 8 || !obj || typeof obj !== 'object') return null;

    // 直接命中：判斷此層物件是否為商品
    if (isProductObject(obj)) return normalizeProduct(obj);

    // 遞迴搜尋
    const values = Array.isArray(obj) ? obj : Object.values(obj);
    for (const val of values) {
        if (typeof val === 'object' && val !== null) {
            const found = deepFindProduct(val, depth + 1);
            if (found) return found;
        }
    }

    return null;
}

function isProductObject(obj) {
    if (typeof obj !== 'object' || Array.isArray(obj)) return false;
    const keys = Object.keys(obj).map(k => k.toLowerCase());
    
    const hasName = keys.some(k => ['title', 'name', 'product_name', 'handle'].includes(k));
    const hasPrice = keys.some(k => ['price', 'current_price', 'sale_price', 'price_min'].includes(k));
    const hasVariants = keys.includes('variants') && Array.isArray(obj.variants || obj.Variants);
    
    return hasName && (hasPrice || hasVariants);
}

function normalizeProduct(obj) {
    // 嘗試找到最具代表性的價格欄位 (含稅、最終、最低)
    const priceRaw = obj.price ?? obj.current_price ?? obj.sale_price ?? obj.price_min ?? obj.finalPrice ?? 0;
    const priceNum = typeof priceRaw === 'string'
        ? parseFloat(priceRaw.replace(/[^0-9.]/g, ''))
        : (typeof priceRaw === 'number' && priceRaw > 100 ? priceRaw / 100 : priceRaw); // Shopify 用分為單位

    const currency = obj.currency ?? obj.priceCurrency ?? obj.price_currency ?? 'UNKNOWN';
    const title = obj.title ?? obj.name ?? obj.product_name ?? '';
    const image = obj.featured_image ?? obj.image?.src ?? obj.image ?? obj.thumbnail ?? '';

    const imagesList = Array.isArray(obj.images) ? obj.images : [];
    
    // 建立合法屬性註冊表 (提取自母商品定義)
    let validOptionValues = null;
    if (Array.isArray(obj.options) && obj.options.length > 0) {
        validOptionValues = new Set();
        obj.options.forEach(opt => {
            if (typeof opt === 'string') {
                validOptionValues.add(opt);
            } else if (opt && Array.isArray(opt.values)) {
                opt.values.forEach(v => validOptionValues.add(v));
            }
        });
        if (validOptionValues.size === 0) validOptionValues = null;
    }

    const variants = (() => {
        const variantArr = obj.variants ?? (Array.isArray(obj.options) && obj.options[0]?.price ? obj.options : null) ?? null;
        if (!Array.isArray(variantArr)) return [];

        return variantArr
            .filter(v => {
                const title = (v.title ?? v.name ?? v.option1 ?? '').trim();
                if (title === 'Default Title') return false;

                // 強制攔截：如果完全符合 `[包含行銷字眼]` 的嚴格中括號格式，無條件視為外掛假變數
                const isPromoBracket = /^\[.*(折扣|滿.*折|加碼|說明|最高折|優惠|贈品).*\]$/i.test(title);
                if (isPromoBracket) return false;

                // 結構比對：如果變數中攜帶的 option (1/2/3) 並未註冊在母商品的 UI 屬性中，視為隱藏變數
                if (validOptionValues) {
                    if (v.option1 && !validOptionValues.has(v.option1)) return false;
                    if (v.option2 && !validOptionValues.has(v.option2)) return false;
                    if (v.option3 && !validOptionValues.has(v.option3)) return false;
                } else {
                    // 備用防線
                    if (/^\[.*\]$/.test(title) && title.includes('/')) return false;
                }
                
                return true;
            })
            .slice(0, 100)
            .map(v => {
                let varImage = v.featured_image?.src ?? v.image?.src ?? v.image ?? '';
                if (!varImage && v.image_id) {
                    const matchedImg = imagesList.find(img => img.id === v.image_id);
                    if (matchedImg) varImage = matchedImg.src;
                }
                return {
                    spec: v.title ?? v.name ?? v.option1 ?? '',
                    price: typeof v.price === 'number' ? (v.price > 10000 && v.price % 100 === 0 ? v.price / 100 : v.price) : parseFloat(v.price ?? 0),
                    currency,
                    sku: v.sku ?? v.id ?? '',
                    available: v.available ?? true,
                    image: varImage,
                };
            });
    })();

    return { title, price: priceNum, currency, image, variants };
}

function normalizeJsonLdProduct(ld) {
    const offer = Array.isArray(ld.offers) ? ld.offers[0] : ld.offers;
    const price = parseFloat(offer?.price ?? 0);
    const currency = offer?.priceCurrency ?? 'UNKNOWN';
    return {
        title: ld.name ?? '',
        price,
        currency,
        image: ld.image ?? '',
        variants: [],
    };
}

module.exports = { parseSSRState, interceptNetworkAPIs };
