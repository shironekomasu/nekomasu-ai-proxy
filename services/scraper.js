// ─── proxy-engine/services/scraper.js ───
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const cheerio = require('cheerio');

// Plugin: 防止反爬蟲機制 (例如 Cloudflare, Amazon Bot Detection)
puppeteer.use(StealthPlugin());

class WebScraper {
    constructor() {
        this.browser = null;
    }

    async init() {
        return await puppeteer.launch({
            headless: false, // 關閉無頭模式，讓用戶看到爬蟲過程
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled',
                '--disable-dev-shm-usage',
                '--window-size=1920,1080'
            ]
        });
    }

    async close() {
        // Obsolete, handled per-request now
    }

    /**
     * @param {string} url 
     * @param {string[]} selectedOptions 客戶希望選擇的規格 (例如 ["黑色", "青軸"])
     */
    async scrapeTarget(url, selectedOptions = []) {
        console.log(`[Scraper] Launching browser instance for: ${url}`);
        const browser = await this.init();
        const page = await browser.newPage();
        
        // 偽裝語系與視窗
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'ja-JP,ja;q=0.9,zh-TW;q=0.8,zh;q=0.7,en-US;q=0.6,en;q=0.5'
        });

        // 屏蔽多餘資源，加速載入
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            const type = req.resourceType();
            // 對於價格估計，我們只需要 HTML, Script(有些需渲染JS) 與基本圖片(主圖)
            // 屏蔽字型與多媒體
            if (['font', 'media', 'stylesheet'].includes(type)) {
                req.abort();
            } else {
                req.continue();
            }
        });

        console.log(`[Scraper] Navigating to: ${url}`);
        
        try {
            await page.goto(url, { waitUntil: 'networkidle2', timeout: 35000 });
            
            // 嘗試等待可能的價格元素 (針對 Amazon 或 Mercari 的防呆) 
            // 這裡採用通用的等候策略，讓動態框架能生成基本結構
            await new Promise(r => setTimeout(r, 1500)); // 等 React 渲染完成

            // 若有使用者指定的選項，預先模擬點擊
            if (selectedOptions && Array.isArray(selectedOptions) && selectedOptions.length > 0) {
                console.log(`[Scraper] Simulating clicks for options:`, selectedOptions);
                for (const option of selectedOptions) {
                    await page.evaluate((optText) => {
                        // 暴力尋找包含該文字的按鈕、label 或具備游標 pointer 的 DIV
                        const elems = Array.from(document.querySelectorAll('button, label, [role="radio"], .swatch-element, .cursor-pointer'));
                        const target = elems.find(e => {
                            const text = e.innerText || e.textContent || '';
                            return text.trim() === optText || text.includes(optText);
                        });
                        if (target) {
                            if (target.tagName.toLowerCase() === 'option') {
                                target.parentElement.value = target.value;
                                target.parentElement.dispatchEvent(new Event('change', { bubbles: true }));
                            } else {
                                target.click();
                            }
                        }
                    }, option);
                    // 等待動畫或價格刷新
                    await new Promise(r => setTimeout(r, 1000));
                }
            }

            // 提取網頁中的「變體/規格選項」(Phase 1 Sniffing)
            const availableVariants = await page.evaluate(() => {
                const optionsMap = {};
                // 找尋常見的 <select>
                document.querySelectorAll('select').forEach((s, idx) => {
                    const name = s.getAttribute('name') || s.previousElementSibling?.innerText || `Option_${idx+1}`;
                    const vals = Array.from(s.options).map(o => o.innerText.trim()).filter(v => !!v);
                    if (vals.length > 1) optionsMap[name.trim()] = vals;
                });
                
                // 找尋 Shopify 常見的 Fieldset Radio
                document.querySelectorAll('fieldset, [role="radiogroup"], .swatches').forEach((fs, idx) => {
                    const name = fs.querySelector('legend')?.innerText || fs.getAttribute('aria-label') || `Group_${idx+1}`;
                    const vals = Array.from(fs.querySelectorAll('label, input[type="radio"], button, .swatch-element'))
                                      .map(el => (el.innerText || el.value || '').trim())
                                      .filter(v => !!v && v !== 'on');
                    if (vals.length > 1) optionsMap[name.trim()] = [...new Set(vals)]; // unique
                });

                // 通用 Button / Flex 排版推測 (針對如 Wooting 無語意化標籤的網站)
                document.querySelectorAll('div').forEach((div, idx) => {
                    const btns = Array.from(div.children).filter(c => 
                        c.tagName.toLowerCase() === 'button' || 
                        c.getAttribute('role') === 'radio' || 
                        c.classList.contains('cursor-pointer') ||
                        (c.tagName.toLowerCase() === 'div' && window.getComputedStyle(c).cursor === 'pointer')
                    );
                    
                    if (btns.length >= 2 && btns.length <= 15) {
                        const vals = btns.map(b => b.innerText.replace(/\n.+/, '').trim()).filter(v => !!v && v.length < 40);
                        if (vals.length >= 2) {
                            optionsMap[`AutoGroup_${idx+1}`] = [...new Set(vals)];
                        }
                    }
                });
                
                return Object.keys(optionsMap).length > 0 ? optionsMap : null;
            });

            // 提取 SEO Metadata + 應此這類動態total價格
            const seoMeta = await page.evaluate(() => {
                const getMeta = (prop) => document.querySelector(`meta[property="${prop}"]`)?.content 
                            || document.querySelector(`meta[name="${prop}"]`)?.content;
                const getLdJson = () => {
                    const el = document.querySelector('script[type="application/ld+json"]');
                    return el ? el.innerText : null;
                };

                // [新增]：對於 Wooting Configurator 等 SPA計算筆，直接抓取 DOM 中的「總價」元素
                // 該元素是送出小購物車列表左邊或容掽各個 component 價格未加總的最大 span
                const allPriceSpans = Array.from(document.querySelectorAll('span, h2, h3'))
                    .filter(e => e.children.length === 0 && e.innerText)
                    .map(e => e.innerText.trim())
                    .filter(t => t.match(/^[\$¥€]?\s?[0-9][0-9,]+\.[0-9]{2}$/));
                
                // 將所有價格設法辨別，最大的一筆通常是總價
                const maxPrice = allPriceSpans.length > 0
                    ? allPriceSpans.reduce((a,b) => {
                        const av = parseFloat(a.replace(/[^0-9.]/g, ''));
                        const bv = parseFloat(b.replace(/[^0-9.]/g, ''));
                        return av > bv ? a : b;
                    })
                    : null;

                return {
                    ogImage: getMeta('og:image') || getMeta('twitter:image'),
                    ogTitle: getMeta('og:title'),
                    ogPrice: getMeta('product:price:amount'),
                    ogCurrency: getMeta('product:price:currency'),
                    ldJson: getLdJson(),
                    domTotalPrice: maxPrice  // 新增！直接從 DOM 拔出的總價
                };
            });

            // 取得完整 HTML
            const html = await page.content();
            
            // 完成後關閉瀏覽器實體確保系統穩定 (避免後端 500 報錯掛點)
            await browser.close().catch(e => console.warn('Browser close warning:', e));

            return {
                cleanHtml: this.cleanupHtml(html),
                seoMeta: seoMeta,
                variants: availableVariants
            };

        } catch (err) {
            if (browser) await browser.close().catch(()=>null);
            console.error('[Scraper] Error scraping URL:', err);
            throw new Error('無法抓取該網址，請確認網址有效且該網站未完全封鎖自動化請求。');
        }
    }

    cleanupHtml(rawHtml) {
        const $ = cheerio.load(rawHtml);
        
        // 移除對 AI 萃取無用的標籤，大幅省下 Token
        $('script, style, link, meta, noscript, iframe, svg, path, header, footer, nav, aside').remove();
        
        // 去除多餘空白與屬性 (只保留 class 跟 src 幫助定位，id 也留著)
        $('*').each(function() {
            Object.keys(this.attribs || {}).forEach(attr => {
                if (!['id', 'class', 'src', 'href'].includes(attr)) {
                    $(this).removeAttr(attr);
                }
            });
        });

        // 取得純化的 DOM 結構字串
        let cleanHtml = $.html();
        
        // 去除多餘空白與屬性
        cleanHtml = cleanHtml.replace(/\s+/g, ' ').trim();
        
        return cleanHtml;
    }
}

module.exports = new WebScraper();
