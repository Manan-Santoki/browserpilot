# Playwright's image already carries Chromium and every system library it needs.
FROM mcr.microsoft.com/playwright:v1.62.0-noble

# The Playwright image ships without unzip, which bun's installer requires.
RUN apt-get update \
  && apt-get install -y --no-install-recommends unzip \
  && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .

ENV BP_PORT=8787
EXPOSE 8787
CMD ["bun", "run", "src/server.ts"]
