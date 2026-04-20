FROM node:20.10.0-bookworm

WORKDIR /app

# 複製 package.json 先安裝套件
COPY package*.json ./
RUN npm install

# 讓 Playwright 自動完整安裝它需要的系統依賴與 Chromium 瀏覽器
RUN npx playwright install --with-deps chromium

# 複製所有代碼
COPY . .

# 暴露服務埠號
EXPOSE 4000
CMD ["npm", "start"]
