# Production Runtime Dockerfile for Recro (Fast 30s Deploy on Render)
FROM ubuntu:24.04

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    ca-certificates \
    curl \
    && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp \
    && curl -sL "https://caddyserver.com/api/download?os=linux&arch=amd64" -o /usr/local/bin/caddy \
    && chmod +x /usr/local/bin/caddy \
    && (curl -sL https://get.tur.so/install.sh | bash) \
    && (mv /root/.turso/turso /usr/local/bin/turso 2>/dev/null || true) \
    && (chmod +x /usr/local/bin/turso 2>/dev/null || true) \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN mkdir -p /var/www/recro/frontend /var/www/recro/cache /app/data

# Copy prebuilt frontend & prebuilt backend binary (zero compilation time on Render)
COPY dist_frontend /var/www/recro/frontend
COPY dist_bin/signal-audio-backend /app/signal-audio-backend
RUN chmod +x /app/signal-audio-backend

# Copy Caddyfile and entrypoint
COPY Caddyfile /etc/caddy/Caddyfile
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

ENV PORT=10000
ENV BACKEND_PORT=8085
ENV DATABASE_URL="sqlite:///app/data/signal.db?mode=rwc"
ENV CACHE_DIR="/var/www/recro/cache"
ENV TURSO_DATABASE_URL="https://signal-db-ren4ik7284.aws-ap-northeast-1.turso.io"
ENV TURSO_AUTH_TOKEN="eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3OTE3MzcwNTUsImlkIjoiMDFhMTJiZDktOGMwMS03ZGU4LTgwZTgtNDNlY2Q2OTgyYTRkIiwia2lkIjoiaGx5SzdZOGZGRGExV1c2cWVkUkFhbENjNzh6bjE4Wm9ZdXNodDhwZ3JxNCIsInJpZCI6IjRhNzU1NmM4LWE4YTgtNDdhYy1hMzllLWFkODgxZTU2ZGMxOSJ9.nFOhRjf8ExJnRMT1QMOsb3lxiY9LiHk4FDa0Go6mdz4OpKF0ZHQsHuNC4de8PoTmOI6mqvRBbLBL8FzGJbSbBw"
ENV TURSO_API_TOKEN="eyJhbGciOiJSUzI1NiIsImNhdCI6ImNsX0I3ZDRQRDIyMkFBQSIsImtpZCI6Imluc18yYzA4R3ZNeEhYMlNCc3l0d2padm95cEdJeDUiLCJ0eXAiOiJKV1QifQ.eyJleHAiOjE3OTIzNDE2MzMsImlhdCI6MTc5MTczNjgzMywiaXNzIjoiaHR0cHM6Ly9jbGVyay50dXJzby50ZWNoIiwianRpIjoiMzFmM2ViZTQxZWI5MWRkYzk2ZmMiLCJuYmYiOjE3OTE3MzY4MjgsInN1YiI6InVzZXJfM0tZWnZHYzNYZlp0R1Y3ZmoxVE8wU0NNWlcyIn0.nmelz6JEY_Ib15PpJlyrkzrB4YUsmToYUDWgXbz1XpztE-2ClglBj6BJjGSH7HGLPkElY0bOMejfi3yXfOJwX-CUf2RYRjSf0U55_dA9U2-lvTc1PLWmW7enlfjQZgboXSez-pHxGv1QvVlTSq0Zyeav_1piUPzOEj2XzbYo7IoDTm6hyikUd_qwmZzT67uGIPwX1hh6haVA6Tdc1XNWH3vaCaV2c5TohbEa4JHJ8sdhyvxb8xQtiJB9v7Q5_T7WrBgwKO02F6SD9YoB9QKKVB309b6soyCkZ4WtsUA5BSJQkVcnAb8lT52RFKYTFsDVhdXBnIrEZb2IFZxVcbWmUA"

EXPOSE 10000

CMD ["/app/docker-entrypoint.sh"]
