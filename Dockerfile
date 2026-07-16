# Use official Playwright image with browsers pre-installed
FROM mcr.microsoft.com/playwright:v1.58.2-jammy

WORKDIR /app

# Copy package files first for layer caching
COPY package.json package-lock.json ./

# Install dependencies (browsers already present in base image)
RUN npm ci

# Copy source and build
COPY . .
RUN npm run build

# Ensure Playwright browsers match installed version (safety net)
RUN npx playwright install chromium --with-deps

# Create sessions directory. We run the daemon as uid 1000 (pwuser from
# the base image) so that auth-token and state are owned by the host user
# and visible to the host-side CLI.
RUN mkdir -p /home/pwuser/.local-auto/sessions \
 && chown -R pwuser:pwuser /home/pwuser

# Expose daemon port
EXPOSE 3847

# Default: run the daemon
CMD ["node", "dist/daemon/index.js"]
