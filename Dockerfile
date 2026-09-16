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

# Install tzdata so node-cron evaluates schedules in the timezone we set
# via the TZ env var in docker-compose.yml. Without this, glibc falls back
# to UTC regardless of TZ. DEBIAN_FRONTEND=noninteractive and a default
# TZ suppress tzdata's interactive prompts during the build.
ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=Europe/Warsaw
RUN apt-get update \
 && apt-get install -y --no-install-recommends tzdata \
 && ln -snf /usr/share/zoneinfo/$TZ /etc/localtime \
 && echo $TZ > /etc/timezone \
 && rm -rf /var/lib/apt/lists/*

# Ensure the daemon's working directory (and the in-image /app/results
# path it writes to) is owned by pwuser. Otherwise the daemon, which runs
# as uid 1000, cannot create /app/results/<site>/<task>/ and every run
# fails with EACCES even though the Telegram notification still goes out.
RUN chown -R pwuser:pwuser /app

# Expose daemon port
EXPOSE 3847

# Default: run the daemon
CMD ["node", "dist/daemon/index.js"]
