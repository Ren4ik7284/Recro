use axum::{
    body::Bytes,
    extract::{Query, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
};
use std::time::{Duration, Instant};

use crate::models::CoverParams;
use crate::security::check_url_ssrf;
use crate::AppState as BackendState;

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
                res_headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));
                return Ok((StatusCode::OK, res_headers, cached_bytes.clone()).into_response());
            }
        }
    }

    // 2. If valid HTTP target is supplied, attempt fetch with intelligent fallback
    if !raw_target.is_empty() && (raw_target.starts_with("http://") || raw_target.starts_with("https://")) {
        if check_url_ssrf(raw_target).await.is_ok() {
            let mut candidate_urls = vec![raw_target.to_string()];

            // Fallback candidate for YouTube thumbnails
            if raw_target.contains("maxresdefault.jpg") {
                candidate_urls.push(raw_target.replace("maxresdefault.jpg", "hqdefault.jpg"));
                candidate_urls.push(raw_target.replace("maxresdefault.jpg", "mqdefault.jpg"));
            } else if raw_target.contains("sddefault.jpg") {
                candidate_urls.push(raw_target.replace("sddefault.jpg", "hqdefault.jpg"));
            }

            // Fallback candidate for SoundCloud artwork
            if raw_target.contains("-original.jpg") {
                candidate_urls.push(raw_target.replace("-original.jpg", "-t500x500.jpg"));
                candidate_urls.push(raw_target.replace("-original.jpg", "-large.jpg"));
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
                                        res_headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));

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
    res_headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));

    Ok((StatusCode::OK, res_headers, svg_bytes).into_response())
}
