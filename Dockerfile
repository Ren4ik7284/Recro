# Multi-stage Dockerfile for Recro (Fast Prebuilt Frontend + Native Rust Backend)
# Stage 1: Build Rust Axum Backend
FROM rust:bookworm AS backend-builder
WORKDIR /app/backend
COPY backend/ ./
ENV CARGO_BUILD_JOBS=1
RUN cargo build --release

# Stage 2: Minimal Production Runtime
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    ca-certificates \
    curl \
    xz-utils \
    && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp \
    && curl -sL "https://caddyserver.com/api/download?os=linux&arch=amd64" -o /usr/local/bin/caddy \
    && chmod +x /usr/local/bin/caddy \
    && (curl -sL https://get.tur.so/install.sh | bash || true) \
    && (mv /root/.turso/turso /usr/local/bin/turso 2>/dev/null || true) \
    && (chmod +x /usr/local/bin/turso 2>/dev/null || true) \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN mkdir -p /var/www/recro/frontend /var/www/recro/cache /app/data

# Copy prebuilt frontend (instant, no npm overhead)
COPY dist_frontend /var/www/recro/frontend

# Copy built backend binary from builder stage
COPY --from=backend-builder /app/backend/target/release/signal-audio-backend /app/signal-audio-backend
RUN chmod +x /app/signal-audio-backend

# Copy Caddyfile and entrypoint
COPY Caddyfile /etc/caddy/Caddyfile
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

ENV PORT=10000
ENV BACKEND_PORT=8085
ENV DATABASE_URL="sqlite:///app/data/signal.db?mode=rwc"
ENV CACHE_DIR="/var/www/recro/cache"
ENV GOOGLE_CLIENT_ID="248976454900-cs1ni5j4idhdgs5e8docklsruqlrio3v.apps.googleusercontent.com"

EXPOSE 10000

CMD ["/app/docker-entrypoint.sh"]
