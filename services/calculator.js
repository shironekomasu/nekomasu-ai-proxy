// ─── proxy-engine/services/calculator.js ───
const axios = require('axios');

class PricingCalculator {
    constructor() {
        this.cache = {}; // 將存儲多國貨幣快取，如 cache['USD'], cache['JPY']
        // 預設參數 (Phase 1 Stub)
        this.baseRateStr = '0.22';
        this.exchangeMarkup = 1.05; // 銀行即期加上 5% 轉換手續費
        this.airFreightRate = 250; // 空運費每公斤 (不足 1kg 以 1kg 計)
        this.baseProxyFee = 150; // 最低代購服務費
    }

    async getLiveRate(sourceCurrencyCode) {
        const currency = (sourceCurrencyCode || 'JPY').toUpperCase();
        
        // 特殊預設：如果本來就是台幣，匯率為 1
        if (currency === 'TWD') return 1;

        const now = Date.now();
        // 1 小時快取
        if (this.cache[currency] && now - this.cache[currency].lastFetch < 3600000) {
            return this.cache[currency].rate;
        }

        try {
            // 使用免費的公開匯率 API
            const res = await axios.get(`https://open.er-api.com/v6/latest/${currency}`);
            if (res.data && res.data.rates && res.data.rates.TWD) {
                this.cache[currency] = {
                    rate: res.data.rates.TWD,
                    lastFetch: now
                };
                console.log(`[Calculator] Fetched live ${currency}->TWD rate: ${res.data.rates.TWD}`);
                return res.data.rates.TWD;
            }
        } catch (err) {
            console.warn(`[Calculator] Failed to fetch live rate for ${currency}, using base fallback.`);
        }

        // 若失敗且為日幣，提供預設值
        return currency === 'JPY' ? 0.22 : 1; 
    }

    calculateVolumetricWeight(dimensions) {
        if (!dimensions || !dimensions.l || !dimensions.w || !dimensions.h) return 0;
        // 材積重量 (kg) = 長(cm) * 寬(cm) * 高(cm) / 6000
        return (dimensions.l * dimensions.w * dimensions.h) / 6000;
    }

    async estimateTotal(originalPrice, originalCurrency, weightKg, dimensionsCm) {
        const currency = (originalCurrency || 'JPY').toUpperCase();
        
        // 特殊處理：如果是原廠台幣計價，則不加轉換手續費
        const rate = await this.getLiveRate(currency);
        const applyRate = currency === 'TWD' ? 1 : rate * this.exchangeMarkup;

        // 1. 商品台幣基本金額
        const itemPricTwd = Math.ceil(originalPrice * applyRate);

        // 2. 運費評估 (實重與材積重取其大者)
        let calcWeight = weightKg || 0;
        if (dimensionsCm) {
            const volWeight = this.calculateVolumetricWeight(dimensionsCm);
            calcWeight = Math.max(calcWeight, volWeight);
        }
        
        // 若完全抓不到重量，預設以 1kg 估計
        if (calcWeight === 0) calcWeight = 1;
        
        // 無條件進位至下一公斤
        const billableWeight = Math.ceil(calcWeight);
        const shippingFee = billableWeight * this.airFreightRate;

        // 3. 代購服務費 (10% or base 150)
        let proxyFee = Math.ceil(itemPricTwd * 0.1);
        if (proxyFee < this.baseProxyFee) proxyFee = this.baseProxyFee;

        // 總計
        const total = itemPricTwd + shippingFee + proxyFee;

        return {
            rate_used: applyRate.toFixed(4),
            item_price_twd: itemPricTwd,
            weight_used_kg: billableWeight,
            shipping_fee_twd: shippingFee,
            proxy_fee_twd: proxyFee,
            total_twd: total
        };
    }
}

module.exports = new PricingCalculator();
