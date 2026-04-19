# 使用 Playwright 官方提供的 Linux 環境，內建所有瀏覽器依賴
FROM mcr.microsoft.com/playwright:v1.40.0-focal

# 設定工作目錄
WORKDIR /app

# 複製 package.json 與 package-lock.json
COPY package*.json ./

# 安裝 Node 套件
RUN npm install

# 複製所有代碼
COPY . .

# 暴露連接埠
EXPOSE 4000

# 啟動伺服器
CMD ["npm", "start"]
