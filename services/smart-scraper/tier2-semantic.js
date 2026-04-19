// ─── proxy-engine/services/smart-scraper/tier2-semantic.js ───
// 🥈 第二階：語意化互動定位（Text Locator + Relative Anchor）
// 策略：永遠不使用脆弱的 CSS Selector。以文字內容為錨點進行點擊，
// 並以明確語意標籤（如 "Total", "Add to cart"）為基準搜索相鄰的價格節點。

'use strict';

// 常見的「加入購物車」按鈕文字（多語系覆蓋）
const ADD_TO_CART_TEXTS = [
    'Add to cart', 'Add to Cart', 'ADD TO CART',
    'Buy now', 'Buy Now', 'BUY NOW',
    'Purchase', '加入購物車', '立即購買', '购买',
    'In den Warenkorb', 'Ajouter au panier', 'カートに入れる',
];

// 常見的「總價/小計」標籤文字
const TOTAL_ANCHOR_TEXTS = [
    'Total', 'Subtotal', 'Summary', 'Price',
    '總計', '小計', '合計', 'Gesamt', 'Sous-total',
];

// 支援幣種符號
const CURRENCY_REGEX = /(?:NT\$|US\$|HK\$|[\$€¥£₩₹])\s?[\d,]+(?:\.\d{1,2})?|\d[\d,]+(?:\.\d{1,2})?\s?(?:TWD|JPY|USD|EUR|KRW)/g;

/**
 * 點擊指定規格選項（完全依賴文字定位，不用 CSS Selector）
 * @param {import('playwright').Page} page
 * @param {string[]} optionTexts 要點擊的選項文字陣列，例如 ['Black', '80%', 'ISO']
 */
async function clickOptionsByText(page, optionTexts = []) {
    for (const text of optionTexts) {
        console.log(`[Tier2] Clicking option: "${text}"`);
        try {
            // 優先使用 Playwright text locator（精準多語意匹配）
            const locator = page.locator(`text="${text}"`).first();
            const isVisible = await locator.isVisible({ timeout: 3000 }).catch(() => false);

            if (isVisible) {
                await locator.click({ timeout: 3000 });
                await page.waitForTimeout(800);
                console.log(`[Tier2] ✅ Clicked: "${text}"`);
                continue;
            }

            // Fallback：部分文字比對（contains）
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

/**
 * 以「Total / 加入購物車」為錨點，搜尋相鄰節點中的最終價格
 * @param {import('playwright').Page} page
 * @returns {Promise<{price: number, currency: string, raw: string}|null>}
 */
async function findPriceByAnchor(page) {
    // 策略 A：從 "Total" / "Subtotal" 標籤節點出發，找相鄰的價格文字
    for (const anchorText of TOTAL_ANCHOR_TEXTS) {
        try {
            const anchor = page.locator(`text="${anchorText}"`).first();
            if (!await anchor.isVisible({ timeout: 1500 }).catch(() => false)) continue;

            // 向上找父節點，再找兄弟節點中的貨幣文字
            const parentText = await anchor.evaluate((el) => {
                const parent = el.parentElement?.parentElement || el.parentElement;
                return parent ? parent.innerText : '';
            });

            const matches = parentText.match(CURRENCY_REGEX);
            if (matches && matches.length > 0) {
                const raw = matches[matches.length - 1]; // 取最後一個（通常是總價）
                const parsed = parsePriceRaw(raw);
                if (parsed) {
                    console.log(`[Tier2] ✅ Found price via anchor "${anchorText}": ${raw}`);
                    return parsed;
                }
            }
        } catch (e) {}
    }

    // 策略 B：從「加入購物車」按鈕的相鄰 DOM 中搜尋（限電商商品頁）
    for (const btnText of ADD_TO_CART_TEXTS) {
        try {
            const btn = page.locator(`button:has-text("${btnText}"), a:has-text("${btnText}")`).first();
            if (!await btn.isVisible({ timeout: 1500 }).catch(() => false)) continue;

            const nearbyText = await btn.evaluate((el) => {
                // 向上 3 層找父容器的全文
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
        } catch (e) {}
    }

    // 策略 C：全頁掃描，找所有符合貨幣格式的節點，選最常出現的值（頻率最高 = 最可信）
    const allPrices = await page.evaluate((regex) => {
        const pattern = new RegExp(regex, 'g');
        const all = document.body.innerText.match(pattern) || [];
        // 頻率統計
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

/**
 * 列出頁面上所有可見的互動選項（無需操作，單純嗅探）
 * 協助上層 orchestrator 決定有哪些規格可以展示
 * @param {import('playwright').Page} page
 * @returns {Promise<object>} { groupName: [option1, option2, ...] }
 */
async function sniffAvailableOptions(page) {
    return page.evaluate(() => {
        const result = {};

        /** 工具：標準化字串，去除多餘空白 */
        const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

        // --- 標準 ARIA radiogroup ---
        document.querySelectorAll('[role="radiogroup"]').forEach((group, i) => {
            const label = clean(
                group.getAttribute('aria-label') ||
                group.querySelector('legend, h2, h3, h4, label, p')?.innerText ||
                `Option_${i + 1}`
            );
            const options = Array.from(group.querySelectorAll('[role="radio"], [aria-checked], input[type="radio"]'))
                .map(o => clean(o.innerText || o.value || o.getAttribute('aria-label') || ''))
                .filter(Boolean);
            if (options.length >= 2) result[label] = options;
        });

        // --- <select> 下拉選單 ---
        document.querySelectorAll('select').forEach((sel, i) => {
            const label = clean(
                sel.previousElementSibling?.innerText ||
                document.querySelector(`label[for="${sel.id}"]`)?.innerText ||
                `Select_${i + 1}`
            );
            const options = Array.from(sel.options).map(o => clean(o.text)).filter(Boolean);
            if (options.length >= 2) result[label] = options;
        });

        // --- 通用按鈕群組（Wooting 風格：React 自製 swatch）---
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
                .filter(v => v && v.length < 50);

            if (values.length >= 2) {
                const key = `AutoGroup_${container.className.substring(0, 30) || container.id || Object.keys(result).length}`;
                if (!Object.values(result).some(existing => JSON.stringify(existing) === JSON.stringify(values))) {
                    result[key] = [...new Set(values)];
                }
            }
        });

        return result;
    });
}

// ──────────────────────────────────────────────
// 內部工具
// ──────────────────────────────────────────────

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
    else if (/\$/.test(raw)) currency = 'DETECT'; // 需由上層根據地區判斷

    return { price, currency, raw };
}

module.exports = { clickOptionsByText, findPriceByAnchor, sniffAvailableOptions };
