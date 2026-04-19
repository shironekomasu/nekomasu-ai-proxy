FROM mcr.microsoft.com/playwright:v1.59.0-jammy

# Create app directory
WORKDIR /app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install app dependencies
RUN npm install

# Bundle app source
COPY . .

# Setting up PORT configuration
ENV PORT=4000
EXPOSE 4000

# Start the application
CMD [ "node", "server.js" ]
