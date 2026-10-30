FROM oven/bun:1.3.14-alpine
WORKDIR /app
COPY config.json ./
COPY src ./src
COPY public ./public
COPY prompts ./prompts
COPY test ./test
ENV HOST=0.0.0.0 PORT=8787 DATA_DIR=/data
RUN mkdir -p /data && chown bun:bun /data
USER bun
EXPOSE 8787
CMD ["bun", "src/main.ts"]
