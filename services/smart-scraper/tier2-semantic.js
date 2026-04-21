// ─── proxy-engine/services/smart-scraper/tier2-semantic.js ───
// 🥈 第二階：語意化互動定位

'use strict';

const ADD_TO_CART_TEXTS = [
    'Add to cart', 'Add to Cart', 'ADD TO CART',
    'Buy now', 'Buy Now', 'BUY NOW',
    'Purchase', '加入購物車', '立即購買', '购买',
    'In den Warenkorb', 'Ajouter au panier', 'カートに入れる',
];

const TOTAL_ANCHOR_TEXTS = [
    'Total', 'Subtotal', 'Summary', 'Price',
    '總計', '小計', '合計', 'Gesamt', 'Sous-total',
];

const CURRENCY_REGEX = /(?:NT\$|US\$|HK\$|[\$€¥£₩₹])\s?[\d,]+(?:\.\d{1,2})?|\d[\d,]+(?:\.\d{1,2})?\s?(?:TWD|JPY|USD|EUR|KRW)/g;

async function clickOptionsByText(page, optionTexts = []) {
    for (const text of optionTexts) {
        console.log(`[Tier2] Clicking option: "${text}"`);
        try {
            const locator = page.locator(`text="${text}"`).first();
            const isVisible = await locator.isVisible({ timeout: 3000 }).catch(() => false);
            if (isVisible) {
                await locator.click({ timeout: 3000 });
                await page.waitForTimeout(800);
                console.log(`[Tier2] ✅ Clicked: "${text}"`);
                continue;
            }

            const containsLocator = page.locator(`[role="radio"]:has-text("${text}"), button:has-text("${text}"), label:has-text("${text}")`).first();
            const containsVisible = await containsLocator.isVisible({ timeout: 2000 }).catch(() => false);
            if (containsVisible) {
                await containsLocator.click({ timeout: 2000 });
                await page.waitForTimeout(800);
                console.log(`[Tier2] ✅ Clicked (contains): "${text}"`);
                continue;
            }

            console.log(`[Tier2] ⚠️ Option not found: "${text}"`);
        } catch (e) {
            console.log(`[Tier2] ⚠️ Click failed for "${text}":`, e.message);
        }
    }
}

async function findPriceByAnchor(page) {
    for (const anchorText of TOTAL_ANCHOR_TEXTS) {
        try {
            const anchor = page.locator(`text="${anchorText}"`).first();
            if (!await anchor.isVisible({ timeout: 1500 }).catch(() => false)) continue;

            const parentText = await anchor.evaluate((el) => {
                const parent = el.parentElement?.parentElement || el.parentElement;
                return parent ? parent.innerText : '';
            });
            const matches = parentText.match(CURRENCY_REGEX);
            if (matches && matches.length > 0) {
                const raw = matches[matches.length - 1];
                const parsed = parsePriceRaw(raw);
                if (parsed) {
                    console.log(`[Tier2] ✅ Found price via anchor "${anchorText}": ${raw}`);
                    return parsed;
                }
            }
        } catch (e) { }
    }

    for (const btnText of ADD_TO_CART_TEXTS) {
        try {
            const btn = page.locator(`button:has-text("${btnText}"), a:has-text("${btnText}")`).first();
            if (!await btn.isVisible({ timeout: 1500 }).catch(() => false)) continue;

            const nearbyText = await btn.evaluate((el) => {
                let node = el;
                for (let i = 0; i < 3; i++) node = node.parentElement || node;
                return node ? node.innerText : '';
            });

            const matches = nearbyText.match(CURRENCY_REGEX);
            if (matches && matches.length > 0) {
                const raw = matches[matches.length - 1];
                const parsed = parsePriceRaw(raw);
                if (parsed) {
                    console.log(`[Tier2] ✅ Found price near "Add to Cart": ${raw}`);
                    return parsed;
                }
            }
        } catch (e) { }
    }

    const allPrices = await page.evaluate((regex) => {
        const pattern = new RegExp(regex, 'g');
        const all = document.body.innerText.match(pattern) || [];
        const freq = {};
        all.forEach(p => { freq[p] = (freq[p] || 0) + 1; });
        return Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 5);
    }, CURRENCY_REGEX.source);
    if (allPrices.length > 0) {
        const [topRaw] = allPrices[0];
        const parsed = parsePriceRaw(topRaw);
        if (parsed) {
            console.log(`[Tier2] ✅ Found price by frequency analysis: ${topRaw}`);
            return parsed;
        }
    }

    console.log('[Tier2] ❌ No price found via semantic anchors.');
    return null;
}

async function sniffAvailableOptions(page) {
    return page.evaluate(() => {
        const result = {};

        const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

        // 🌟 只擋通用電商行銷字眼
        const isPromoText = (text) => /(折扣|滿.*折|加碼|說明|最高折|優惠|贈品|免運)/i.test(text);

        // --- 標準 ARIA radiogroup ---
        document.querySelectorAll('[role="radiogroup"]').forEach((group, i) => {
            const label = clean(
                group.getAttribute('aria-label') ||
                group.querySelector('legend, h2, h3, h4, label, p')?.innerText ||
                `Option_${i + 1}`
            );
            if (/(qty|quantity|數量)/i.test(label)) return;

            const options = Array.from(group.querySelectorAll('[role="radio"], [aria-checked], input[type="radio"]'))
                .map(o => clean(o.innerText || o.value || o.getAttribute('aria-label') || ''))
                .filter(v => v && !isPromoText(v) && !/^\d+$/.test(v));
            if (options.length >= 2) result[label] = options;
        });

        // --- <select> 下拉選單 ---
        document.querySelectorAll('select').forEach((sel, i) => {
            const label = clean(
                sel.previousElementSibling?.innerText ||
                document.querySelector(`label[for="${sel.id}"]`)?.innerText ||
                sel.getAttribute('name') ||
                sel.getAttribute('aria-label') ||
                `Select_${i + 1}`
            );
            if (/(qty|quantity|數量)/i.test(label)) return;

            const options = Array.from(sel.options)
                .map(o => clean(o.text))
                .filter(v => v && !isPromoText(v) && !/^\d+$/.test(v));
            if (options.length >= 2) result[label] = options;
        });

        // --- 通用按鈕群組（React 自製 swatch）---
        document.querySelectorAll('div, ul, nav').forEach((container) => {
            const interactables = Array.from(container.children).filter(c =>
                c.tagName === 'BUTTON' ||
                c.getAttribute('role') === 'radio' ||
                c.classList.contains('cursor-pointer') ||
                window.getComputedStyle(c).cursor === 'pointer'
            );
            if (interactables.length < 2 || interactables.length > 20) return;

            const values = interactables
                .map(b => clean(b.innerText))
                .filter(v => v && v.length < 50 && !isPromoText(v) && !/^\d+$/.test(v));

            if (values.length >= 2) {
                const key = `AutoGroup_${container.className.substring(0, 30) || container.id || Object.keys(result).length}`;
                if (/(qty|quantity|數量)/i.test(key)) return;

                if (!Object.values(result).some(existing => JSON.stringify(existing) === JSON.stringify(values))) {
                    result[key] = [...new Set(values)];
                }
            }
        });

        return result;
    });
}

function parsePriceRaw(raw) {
    if (!raw) return null;
    const numStr = raw.replace(/[^0-9.]/g, '');
    const price = parseFloat(numStr);
    if (isNaN(price) || price <= 0) return null;

    let currency = 'UNKNOWN';
    if (/NT\$|TWD/.test(raw)) currency = 'TWD';
    else if (/US\$|USD/.test(raw)) currency = 'USD';
    else if (/¥|JPY|円/.test(raw)) currency = 'JPY';
    else if (/€|EUR/.test(raw)) currency = 'EUR';
    else if (/£|GBP/.test(raw)) currency = 'GBP';
    else if (/₩|KRW/.test(raw)) currency = 'KRW';
    else if (/\$/.test(raw)) currency = 'DETECT';

    return { price, currency, raw };
}

module.exports = { clickOptionsByText, findPriceByAnchor, sniffAvailableOptions };