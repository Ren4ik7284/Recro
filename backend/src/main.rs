mod auth;
mod config;
mod db;
mod handlers;
mod models;
mod security;
mod soundcloud;
pub mod spotify_charts;
pub mod turso;
mod ytdlp;

use axum::routing::{get, post};
use axum::Router;
use soundcloud::SoundCloudClient;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tower_http::cors::{AllowHeaders, AllowOrigin, CorsLayer};
use tower_http::limit::RequestBodyLimitLayer;
use tower_http::services::{ServeDir, ServeFile};

use config::{ensure_cookies_on_start, init_cookies_from_env};
use db::{init_db, DbPool};
use handlers::auth::{get_auth_config, get_me, google_login, login, logout, register, update_profile};
use handlers::cover::{health_check, proxy_cover};
use handlers::history::{clear_history, get_history, record_play};
use handlers::library::{get_library, save_library};
use handlers::search::{extract_info, get_recommendations, get_similar_tracks, get_top_artists, search_music};
use handlers::lyrics::{get_lyrics, get_track_meta, save_track_meta, LyricsCache};
use handlers::stats::get_wrapped;
use handlers::stream::stream_audio;

pub type LoginAttempts = Arc<Mutex<HashMap<String, (u32, Instant)>>>;
pub type EndpointRateLimits = Arc<Mutex<HashMap<String, (u32, Instant)>>>;
pub type StreamCache = Arc<Mutex<HashMap<String, (String, Instant)>>>;
pub type ActiveTranscodes = Arc<Mutex<std::collections::HashSet<String>>>;
pub type SearchCache = Arc<Mutex<HashMap<String, (Vec<crate::models::SearchTrack>, Instant)>>>;
pub type CoverCache = Arc<Mutex<HashMap<String, (axum::body::Bytes, axum::http::HeaderValue, Instant)>>>;

pub type SyncChannel = tokio::sync::broadcast::Sender<String>;

#[derive(Clone)]
pub struct AppState {
    pub pool: DbPool,
    pub login_attempts: LoginAttempts,
    pub endpoint_rate_limits: EndpointRateLimits,
    pub heavy_process_semaphore: Arc<tokio::sync::Semaphore>,
    pub stream_semaphore: Arc<tokio::sync::Semaphore>,
    pub stream_cache: StreamCache,
    pub active_transcodes: ActiveTranscodes,
    pub lyrics_cache: LyricsCache,
    pub search_cache: SearchCache,
    pub cover_cache: CoverCache,
    pub soundcloud: Arc<SoundCloudClient>,
    pub sync_channel: SyncChannel,
    pub http_client: reqwest::Client,
}

#[tokio::main]
async fn main() {
    init_cookies_from_env();
    turso::init_turso();
    tokio::spawn(ensure_cookies_on_start());
    tokio::spawn(spotify_charts::start_spotify_charts_worker());

    let soundcloud = SoundCloudClient::new();
    let (sync_channel, _) = tokio::sync::broadcast::channel::<String>(512);

    let http_client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .connect_timeout(std::time::Duration::from_secs(5))
        .pool_idle_timeout(std::time::Duration::from_secs(90))
        .pool_max_idle_per_host(20)
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36")
        .build()
        .unwrap_or_default();

    let pool = match init_db().await {
        Ok(p) => p,
        Err(e) => {
            eprintln!("Failed to initialize database: {}", e);
            return;
        }
    };

    turso::sync_down_on_boot(&pool).await;

    let state = AppState {
        pool,
        login_attempts: Arc::new(Mutex::new(HashMap::new())),
        endpoint_rate_limits: Arc::new(Mutex::new(HashMap::new())),
        heavy_process_semaphore: Arc::new(tokio::sync::Semaphore::new(24)),
        stream_semaphore: Arc::new(tokio::sync::Semaphore::new(48)),
        stream_cache: Arc::new(Mutex::new(HashMap::new())),
        active_transcodes: Arc::new(Mutex::new(std::collections::HashSet::new())),
        lyrics_cache: Arc::new(Mutex::new(HashMap::new())),
        search_cache: Arc::new(Mutex::new(HashMap::new())),
        cover_cache: Arc::new(Mutex::new(HashMap::new())),
        soundcloud,
        sync_channel,
        http_client,
    };

    let exposed_headers = [
        axum::http::header::CONTENT_LENGTH,
        axum::http::header::ACCEPT_RANGES,
        axum::http::header::CONTENT_RANGE,
        axum::http::HeaderName::from_static("x-audio-codec"),
        axum::http::HeaderName::from_static("x-audio-bitrate"),
        axum::http::HeaderName::from_static("x-audio-quality"),
    ];

    let allowed_methods = [
        axum::http::Method::GET,
        axum::http::Method::POST,
        axum::http::Method::PUT,
        axum::http::Method::DELETE,
        axum::http::Method::OPTIONS,
        axum::http::Method::HEAD,
        axum::http::Method::PATCH,
    ];

    let cors = if let Ok(origins_str) = std::env::var("ALLOWED_ORIGINS") {
        let allowed: Vec<axum::http::HeaderValue> = origins_str
            .split(',')
            .filter_map(|s| s.trim().parse().ok())
            .collect();
        if allowed.is_empty() {
            CorsLayer::new()
                .allow_origin(AllowOrigin::mirror_request())
                .allow_credentials(true)
                .allow_methods(allowed_methods)
                .allow_headers(AllowHeaders::mirror_request())
                .expose_headers(exposed_headers)
        } else {
            CorsLayer::new()
                .allow_origin(allowed)
                .allow_credentials(true)
                .allow_methods(allowed_methods)
                .allow_headers(AllowHeaders::mirror_request())
                .expose_headers(exposed_headers)
        }
    } else {
        CorsLayer::new()
            .allow_origin(AllowOrigin::mirror_request())
            .allow_credentials(true)
            .allow_methods(allowed_methods)
            .allow_headers(AllowHeaders::mirror_request())
            .expose_headers(exposed_headers)
    };

    let static_dir_path = std::env::var("STATIC_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| {
            if std::path::Path::new("dist_frontend").exists() {
                std::path::PathBuf::from("dist_frontend")
            } else if std::path::Path::new("../dist_frontend").exists() {
                std::path::PathBuf::from("../dist_frontend")
            } else {
                std::path::PathBuf::from("/home/ren4ik7284/music-player/dist_frontend")
            }
        });

    let mut app = Router::new()
        .route("/api/health", get(health_check))
        .route("/api/auth/register", post(register))
        .route("/api/auth/login", post(login))
        .route("/api/auth/logout", post(logout))
        .route("/api/auth/me", get(get_me))
        .route("/api/auth/profile", post(update_profile))
        .route("/api/auth/config", get(get_auth_config))
        .route("/api/auth/google", post(google_login))
        .route("/api/sync", get(get_library).post(save_library))
        .route("/api/sync/events", get(handlers::library::sync_events))
        .route("/api/history", get(get_history).post(record_play).delete(clear_history))
        .route("/api/stats/wrapped", get(get_wrapped))
        .route("/api/cover", get(proxy_cover))
        .route("/api/resolve-media", get(handlers::cover::resolve_media))
        .route("/api/home", get(handlers::charts::get_home_explore))
        .route("/api/charts", get(handlers::charts::list_charts))
        .route("/api/charts/{id}", get(handlers::charts::get_chart_by_id))
        .route("/api/search", get(search_music))
        .route("/api/top-artists", get(get_top_artists))
        .route("/api/new-releases", get(handlers::search::get_new_releases))
        .route("/api/recommendations", get(get_recommendations))
        .route("/api/similar-tracks", get(get_similar_tracks))
        .route("/api/extract", get(extract_info))
        .route("/api/stream", get(stream_audio))
        .route("/api/lyrics", get(get_lyrics))
        .route("/api/track/meta", get(get_track_meta).post(save_track_meta))
        .route("/api/background/upload", post(handlers::background::upload_background))
        .layer(axum::middleware::from_fn(security_headers_middleware))
        .layer(RequestBodyLimitLayer::new(60 * 1024 * 1024))
        .layer(cors)
        .with_state(state);

    if static_dir_path.exists() {
        let index_file = static_dir_path.join("index.html");
        if index_file.exists() {
            println!("Serving static frontend from {}", static_dir_path.display());
            app = app.fallback_service(
                ServeDir::new(&static_dir_path).not_found_service(ServeFile::new(index_file)),
            );
        }
    }

    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8085);

    let host = std::env::var("HOST").unwrap_or_else(|_| "0.0.0.0".to_string());
    let ip: std::net::IpAddr = host.parse().unwrap_or(std::net::IpAddr::V4(std::net::Ipv4Addr::UNSPECIFIED));
    let addr = SocketAddr::from((ip, port));
    println!("Server running on http://{}:{}", ip, port);

    // Start background auto-refresher for all charts, viral trends and popular catalogs
    handlers::charts::spawn_charts_background_refresher();

    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("Failed to bind port {}: {}", port, e);
            return;
        }
    };

    if let Err(e) = axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>()).await {
        eprintln!("Server error: {}", e);
    }
}

async fn security_headers_middleware(
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers.insert(
        axum::http::header::HeaderName::from_static("x-content-type-options"),
        axum::http::HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        axum::http::header::HeaderName::from_static("x-frame-options"),
        axum::http::HeaderValue::from_static("DENY"),
    );
    headers.insert(
        axum::http::header::HeaderName::from_static("referrer-policy"),
        axum::http::HeaderValue::from_static("strict-origin-when-cross-origin"),
    );
    response
}
