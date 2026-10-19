use axum::{
    body::Bytes,
    extract::{Query, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};

use crate::models::CoverParams;
use crate::security::check_url_ssrf;
use crate::AppState as BackendState;

#[derive(Deserialize)]
pub struct ResolveMediaParams {
    pub url: String,
}

#[derive(Serialize)]
pub struct ResolveMediaResponse {
    pub success: bool,
    pub media_url: String,
    pub media_type: String, // "video" or "image"
    pub original_url: String,
    pub title: Option<String>,
}

pub async fn resolve_media(
    Query(params): Query<ResolveMediaParams>,
) -> Result<Json<ResolveMediaResponse>, (StatusCode, String)> {
    let raw_target = params.url.trim();
    if raw_target.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "URL is empty".to_string()));
    }

    if check_url_ssrf(raw_target).await.is_err() {
        return Err((StatusCode::BAD_REQUEST, "Invalid or prohibited URL".to_string()));
    }

    let lower = raw_target.to_lowercase();

    // 1. Прямые ссылки на видео
    if lower.ends_with(".mp4") || lower.ends_with(".webm") || lower.ends_with(".mov") || lower.ends_with(".m4v") {
        return Ok(Json(ResolveMediaResponse {
            success: true,
            media_url: raw_target.to_string(),
            media_type: "video".to_string(),
            original_url: raw_target.to_string(),
            title: Some("Direct Video".to_string()),
        }));
    }

    // 2. Прямые ссылки на изображения/GIF
    if lower.ends_with(".gif") || lower.ends_with(".webp") || lower.ends_with(".png") || lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        return Ok(Json(ResolveMediaResponse {
            success: true,
            media_url: raw_target.to_string(),
            media_type: "image".to_string(),
            original_url: raw_target.to_string(),
            title: Some("Direct Image/GIF".to_string()),
        }));
    }

    // 3. Pinterest (pin.it или pinterest.com)
    let is_pinterest = lower.contains("pin.it") || lower.contains("pinterest.");
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .user_agent("facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)")
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let mut target_url = raw_target.to_string();

    // Если это короткая ссылка pin.it, следуем за редиректом
    if lower.contains("pin.it") {
        let no_redirect_client = reqwest::Client::builder()
            .timeout(Duration::from_secs(8))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

        if let Ok(resp) = no_redirect_client.get(raw_target).send().await {
            if let Some(loc) = resp.headers().get(reqwest::header::LOCATION) {
                if let Ok(loc_str) = loc.to_str() {
                    target_url = loc_str.to_string();
                }
            }
        }
    }

    // Извлекаем pin ID если есть (например из /pin/1058838562413046444/)
    let pin_id_opt = if let Some(pos) = target_url.find("/pin/") {
        let slice = &target_url[pos + 5..];
        let id_part: String = slice.chars().take_while(|c| c.is_ascii_digit()).collect();
        if !id_part.is_empty() {
            Some(id_part)
        } else {
            None
        }
    } else {
        None
    };

    let fetch_url = if let Some(ref pin_id) = pin_id_opt {
        format!("https://www.pinterest.com/pin/{}/", pin_id)
    } else {
        target_url.clone()
    };

    let page_resp = client.get(&fetch_url).send().await
        .map_err(|e| (StatusCode::BAD_GATEWAY, format!("Failed to fetch target URL: {}", e)))?;

    let body = page_resp.text().await.unwrap_or_default();

    // Проверяем наличие mp4 (видео обои Pinterest)
    if is_pinterest || body.contains(".mp4") {
        if let Some(pos) = body.find("https://v1.pinimg.com/videos/iht/") {
            let slice = &body[pos..];
            if let Some(end) = slice.find(".mp4") {
                let mp4_url = &slice[..end + 4];
                return Ok(Json(ResolveMediaResponse {
                    success: true,
                    media_url: mp4_url.to_string(),
                    media_type: "video".to_string(),
                    original_url: raw_target.to_string(),
                    title: Some("Pinterest Animated Wallpaper".to_string()),
                }));
            }
        }

        // Любой .mp4 в теле
        if let Some(pos) = body.find("https://") {
            let mut search_slice = &body[pos..];
            while let Some(mp4_idx) = search_slice.find(".mp4") {
                let candidate = &search_slice[..mp4_idx + 4];
                if let Some(http_pos) = candidate.rfind("https://") {
                    let mp4_url = &candidate[http_pos..];
                    if !mp4_url.contains(' ') && !mp4_url.contains('"') && !mp4_url.contains('\\') {
                        return Ok(Json(ResolveMediaResponse {
                            success: true,
                            media_url: mp4_url.to_string(),
                            media_type: "video".to_string(),
                            original_url: raw_target.to_string(),
                            title: Some("Video Background".to_string()),
                        }));
                    }
                }
                search_slice = &search_slice[mp4_idx + 4..];
            }
        }
    }

    // Проверяем OpenGraph og:video
    if let Some(pos) = body.find("property=\"og:video\"") {
        let snippet = &body[pos.saturating_sub(100)..std::cmp::min(body.len(), pos + 250)];
        if let Some(c_pos) = snippet.find("content=\"") {
            let after = &snippet[c_pos + 9..];
            if let Some(end) = after.find('"') {
                let video_url = &after[..end];
                if video_url.starts_with("http") {
                    return Ok(Json(ResolveMediaResponse {
                        success: true,
                        media_url: video_url.to_string(),
                        media_type: "video".to_string(),
                        original_url: raw_target.to_string(),
                        title: Some("Video Wallpaper".to_string()),
                    }));
                }
            }
        }
    }

    // Проверяем high-res Pinterest image (originals)
    if let Some(pos) = body.find("https://i.pinimg.com/originals/") {
        let slice = &body[pos..];
        if let Some(end) = slice.find('"') {
            let img_url = &slice[..end];
            return Ok(Json(ResolveMediaResponse {
                success: true,
                media_url: img_url.to_string(),
                media_type: "image".to_string(),
                original_url: raw_target.to_string(),
                title: Some("Pinterest Image".to_string()),
            }));
        }
    }

    // Проверяем og:image
    if let Some(pos) = body.find("property=\"og:image\"") {
        let snippet = &body[pos.saturating_sub(100)..std::cmp::min(body.len(), pos + 250)];
        if let Some(c_pos) = snippet.find("content=\"") {
            let after = &snippet[c_pos + 9..];
            if let Some(end) = after.find('"') {
                let img_url = &after[..end];
                if img_url.starts_with("http") {
                    return Ok(Json(ResolveMediaResponse {
                        success: true,
                        media_url: img_url.to_string(),
                        media_type: "image".to_string(),
                        original_url: raw_target.to_string(),
                        title: Some("Web Image".to_string()),
                    }));
                }
            }
        }
    }

    // Фолбек на переданный URL
    Ok(Json(ResolveMediaResponse {
        success: true,
        media_url: raw_target.to_string(),
        media_type: if lower.contains("video") || lower.contains(".mp4") { "video".to_string() } else { "image".to_string() },
        original_url: raw_target.to_string(),
        title: Some("Custom Media".to_string()),
    }))
}

pub async fn health_check() -> &'static str {
    "Recro // Rust Engine Online"
}

fn quick_xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn generate_svg_cover(title: &str, artist: &str) -> String {
    let mut hash: u64 = 5381;
    for b in format!("{} {}", artist, title).bytes() {
        hash = (hash << 5).wrapping_add(hash).wrapping_add(b as u64);
    }

    let palettes = [
        ("#6366f1", "#ec4899"), // Indigo -> Pink
        ("#8b5cf6", "#06b6d4"), // Violet -> Cyan
        ("#3b82f6", "#10b981"), // Blue -> Emerald
        ("#f43f5e", "#fb923c"), // Rose -> Orange
        ("#a855f7", "#ec4899"), // Purple -> Pink
        ("#06b6d4", "#3b82f6"), // Cyan -> Blue
        ("#e11d48", "#9333ea"), // Crimson -> Purple
    ];
    let (c1, c2) = palettes[(hash as usize) % palettes.len()];

    let display_artist = if artist.trim().is_empty() {
        "SIGNAL"
    } else {
        artist.trim()
    };
    let display_title = if title.trim().is_empty() {
        "AUDIO"
    } else {
        title.trim()
    };

    let initials = display_artist
        .split_whitespace()
        .filter_map(|w| w.chars().next())
        .take(2)
        .collect::<String>()
        .to_uppercase();
    let initials = if initials.is_empty() {
        "SG".to_string()
    } else {
        initials
    };

    format!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" width="500" height="500" viewBox="0 0 500 500">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#070a13"/>
      <stop offset="50%" stop-color="#0f172a"/>
      <stop offset="100%" stop-color="#020617"/>
    </linearGradient>
    <linearGradient id="accent" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="{c1}"/>
      <stop offset="100%" stop-color="{c2}"/>
    </linearGradient>
    <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="40" result="blur"/>
    </filter>
  </defs>
  <rect width="500" height="500" rx="24" fill="url(#bg)"/>
  <circle cx="250" cy="210" r="130" fill="url(#accent)" opacity="0.30" filter="url(#glow)"/>
  <circle cx="250" cy="210" r="100" fill="none" stroke="url(#accent)" stroke-width="2.5" opacity="0.45"/>
  <circle cx="250" cy="210" r="70" fill="none" stroke="url(#accent)" stroke-width="1.5" stroke-dasharray="5 7" opacity="0.55"/>
  <circle cx="250" cy="210" r="42" fill="#090d16" stroke="url(#accent)" stroke-width="2.5"/>
  <text x="250" y="222" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="28" font-weight="800" fill="#ffffff" letter-spacing="2">{initials}</text>
  <text x="250" y="375" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="22" font-weight="700" fill="#f8fafc" letter-spacing="0.5">{title_esc}</text>
  <text x="250" y="410" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="16" font-weight="500" fill="#94a3b8" letter-spacing="0.5">{artist_esc}</text>
</svg>"##,
        c1 = c1,
        c2 = c2,
        initials = quick_xml_escape(&initials),
        title_esc = quick_xml_escape(display_title),
        artist_esc = quick_xml_escape(display_artist),
    )
}

pub async fn proxy_cover(
    State(state): State<BackendState>,
    Query(params): Query<CoverParams>,
) -> Result<Response, StatusCode> {
    let raw_target = params.url.as_deref().unwrap_or("").trim();
    let title = params.title.as_deref().unwrap_or("").trim();
    let artist = params.artist.as_deref().unwrap_or("").trim();

    // Cache key incorporates URL or Title+Artist
    let cache_key = if !raw_target.is_empty() {
        raw_target.to_string()
    } else {
        format!("meta:{}:{}", artist, title)
    };

    // 1. In-Memory RAM Cache: Sub-millisecond serving directly from memory!
    if let Ok(guard) = state.cover_cache.lock() {
        if let Some((cached_bytes, cached_ct, cached_at)) = guard.get(&cache_key) {
            if cached_at.elapsed() < Duration::from_secs(604800) && !cached_bytes.is_empty() {
                let mut res_headers = HeaderMap::new();
                res_headers.insert(header::CONTENT_TYPE, cached_ct.clone());
                res_headers.insert(
                    header::CACHE_CONTROL,
                    HeaderValue::from_static("public, max-age=2592000, immutable"),
                );
                return Ok((StatusCode::OK, res_headers, cached_bytes.clone()).into_response());
            }
        }
    }

    // 2. If valid HTTP target is supplied, attempt fetch with intelligent fallback
    if !raw_target.is_empty() && (raw_target.starts_with("http://") || raw_target.starts_with("https://")) {
        if check_url_ssrf(raw_target).await.is_ok() {
            let mut candidate_urls = Vec::new();

            // 1. YouTube Lossless Visual Scaling: prefer maxresdefault (1080p) -> sddefault (640p) -> hqdefault (480p)
            if raw_target.contains("hqdefault.jpg") || raw_target.contains("mqdefault.jpg") || raw_target.contains("sddefault.jpg") {
                candidate_urls.push(raw_target.replace("hqdefault.jpg", "maxresdefault.jpg").replace("mqdefault.jpg", "maxresdefault.jpg").replace("sddefault.jpg", "maxresdefault.jpg"));
                candidate_urls.push(raw_target.replace("hqdefault.jpg", "sddefault.jpg").replace("mqdefault.jpg", "sddefault.jpg"));
                candidate_urls.push(raw_target.to_string());
            } else if raw_target.contains("maxresdefault.jpg") {
                candidate_urls.push(raw_target.to_string());
                candidate_urls.push(raw_target.replace("maxresdefault.jpg", "sddefault.jpg"));
                candidate_urls.push(raw_target.replace("maxresdefault.jpg", "hqdefault.jpg"));
            }

            // 2. SoundCloud Lossless Visual Scaling: prefer -t500x500 (500x500) / -original -> -large (100x100)
            if raw_target.contains("-large.") {
                candidate_urls.push(raw_target.replace("-large.", "-t500x500."));
                candidate_urls.push(raw_target.replace("-large.", "-original."));
                candidate_urls.push(raw_target.to_string());
            } else if raw_target.contains("-t500x500.") {
                candidate_urls.push(raw_target.replace("-t500x500.", "-original."));
                candidate_urls.push(raw_target.to_string());
                candidate_urls.push(raw_target.replace("-t500x500.", "-large."));
            } else if raw_target.contains("-original.") {
                candidate_urls.push(raw_target.to_string());
                candidate_urls.push(raw_target.replace("-original.", "-t500x500."));
                candidate_urls.push(raw_target.replace("-original.", "-large."));
            }

            // 3. Deezer Lossless Visual Scaling: prefer 1000x1000 -> 500x500 -> 250x250
            if raw_target.contains("/250x250-") || raw_target.contains("/120x120-") {
                candidate_urls.push(raw_target.replace("/250x250-", "/1000x1000-").replace("/120x120-", "/1000x1000-"));
                candidate_urls.push(raw_target.replace("/120x120-", "/500x500-").replace("/250x250-", "/500x500-"));
                candidate_urls.push(raw_target.to_string());
            }

            if candidate_urls.is_empty() {
                candidate_urls.push(raw_target.to_string());
            }

            let redirect_policy = reqwest::redirect::Policy::custom(|attempt| {
                if attempt.previous().len() >= 5 {
                    attempt.error("too many redirects")
                } else {
                    if let Some(host) = attempt.url().host_str() {
                        let lower = host.to_lowercase();
                        if lower == "localhost"
                            || lower.ends_with(".local")
                            || lower.ends_with(".internal")
                            || lower.ends_with(".lan")
                        {
                            return attempt.error("redirect to internal host forbidden");
                        }
                        if let Ok(ip) = host.parse::<std::net::IpAddr>() {
                            if crate::security::is_private_or_restricted_ip(ip) {
                                return attempt.error("redirect to private IP forbidden");
                            }
                        }
                    }
                    attempt.follow()
                }
            });

            if let Ok(client) = reqwest::Client::builder()
                .redirect(redirect_policy)
                .timeout(Duration::from_millis(5000))
                .build()
            {
                for cand in candidate_urls {
                    if let Ok(resp) = client
                        .get(&cand)
                        .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36")
                        .send()
                        .await
                    {
                        if resp.status().is_success() {
                            let content_type = resp
                                .headers()
                                .get(header::CONTENT_TYPE)
                                .and_then(|v| v.to_str().ok())
                                .unwrap_or("image/jpeg")
                                .to_string();

                            let ct_lower = content_type.to_lowercase();
                            if ct_lower.starts_with("image/") || ct_lower == "application/octet-stream" {
                                if let Ok(bytes) = resp.bytes().await {
                                    if !bytes.is_empty() && bytes.len() <= 10 * 1024 * 1024 {
                                        let valid_ct = HeaderValue::from_str(&content_type)
                                            .unwrap_or_else(|_| HeaderValue::from_static("image/jpeg"));

                                        // Store in RAM cache with LRU eviction protection
                                        if let Ok(mut guard) = state.cover_cache.lock() {
                                            if guard.len() > 300 {
                                                if let Some(oldest_key) = guard.keys().next().cloned() {
                                                    guard.remove(&oldest_key);
                                                }
                                            }
                                            guard.insert(cache_key.clone(), (bytes.clone(), valid_ct.clone(), Instant::now()));
                                        }

                                        let mut res_headers = HeaderMap::new();
                                        res_headers.insert(header::CONTENT_TYPE, valid_ct);
                                        res_headers.insert(
                                            header::CACHE_CONTROL,
                                            HeaderValue::from_static("public, max-age=2592000, immutable"),
                                        );

                                        return Ok((StatusCode::OK, res_headers, bytes).into_response());
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // 3. Guaranteed Unbreakable SVG Generator:
    // If the network image fails, expires or is missing, NEVER return a broken 404/502!
    // Produce a stylish, modern neon SVG cover with genre glow and typography.
    let svg = generate_svg_cover(title, artist);
    let svg_bytes = Bytes::from(svg);
    let svg_ct = HeaderValue::from_static("image/svg+xml; charset=utf-8");

    if let Ok(mut guard) = state.cover_cache.lock() {
        if guard.len() > 300 {
            if let Some(oldest_key) = guard.keys().next().cloned() {
                guard.remove(&oldest_key);
            }
        }
        guard.insert(cache_key, (svg_bytes.clone(), svg_ct.clone(), Instant::now()));
    }

    let mut res_headers = HeaderMap::new();
    res_headers.insert(header::CONTENT_TYPE, svg_ct);
    res_headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=86400, immutable"),
    );

    Ok((StatusCode::OK, res_headers, svg_bytes).into_response())
}
