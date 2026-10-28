use axum::{
    body::Body,
    extract::{ConnectInfo, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use std::net::SocketAddr;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncSeekExt, SeekFrom};
use tokio::process::Command;
use tokio_util::io::ReaderStream;

use crate::config::{apply_yt_dlp_common_args, apply_yt_dlp_common_args_no_cookies, get_yt_dlp_cmd, is_cloud_env, is_frankfurt, CLOUD_FALLBACK_URL};
use crate::models::StreamParams;
use crate::security::{check_rate_limit, check_url_ssrf, get_client_ip};
use crate::AppState;

fn extract_stream_url_from_output(out: &std::process::Output) -> Option<String> {
    let stdout = String::from_utf8_lossy(&out.stdout);
    for line in stdout.lines() {
        let trimmed = line.trim();
        if (trimmed.starts_with("http://") || trimmed.starts_with("https://"))
            && (trimmed.contains("googlevideo.com")
                || trimmed.contains("soundcloud")
                || trimmed.contains("sndcdn")
                || trimmed.contains(".m3u8")
                || trimmed.contains(".mp3")
                || trimmed.contains(".aac"))
        {
            return Some(trimmed.to_string());
        }
    }
    for line in stdout.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
            return Some(trimmed.to_string());
        }
    }
    None
}

fn clean_music_title(title: &str) -> String {
    let mut s = title.to_string();
    while let Some(open) = s.find('[') {
        if let Some(close) = s[open..].find(']') {
            s.replace_range(open..=open + close, " ");
        } else {
            break;
        }
    }
    while let Some(open) = s.find('(') {
        if let Some(close) = s[open..].find(')') {
            s.replace_range(open..=open + close, " ");
        } else {
            break;
        }
    }
    while let Some(open) = s.find('{') {
        if let Some(close) = s[open..].find('}') {
            s.replace_range(open..=open + close, " ");
        } else {
            break;
        }
    }
    if let Some(pipe) = s.find('|') {
        s.truncate(pipe);
    }
    let mut cleaned = String::with_capacity(s.len());
    for c in s.chars() {
        if c.is_alphanumeric() || c == ' ' || c == '-' {
            cleaned.push(c);
        } else {
            cleaned.push(' ');
        }
    }

    let noise_words = [
        "official music video", "official video", "official audio", "official",
        "lyric video", "lyrics", "visualizer", "audio", "clip officiel",
        "remastered", "4k", "hd", "hq", "live in", "full album", "сборник песен",
        "премьера клипа", "премьера песни", "клип", "новинки", "новинка", "хиты",
        "music video", "original mix", "extended mix", "topic",
    ];

    let mut lower = cleaned.to_lowercase();
    for word in noise_words {
        while let Some(idx) = lower.find(word) {
            cleaned.replace_range(idx..idx + word.len(), " ");
            lower.replace_range(idx..idx + word.len(), " ");
        }
    }

    cleaned.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn parse_byte_range(range_header: &str, total_len: u64) -> Option<(u64, u64)> {
    let range_str = range_header.strip_prefix("bytes=")?;
    let mut parts = range_str.split('-');
    let start_str = parts.next()?.trim();
    let end_str = parts.next().unwrap_or("").trim();

    if start_str.is_empty() {
        let suffix_len: u64 = end_str.parse().ok()?;
        if suffix_len == 0 {
            return None;
        }
        let start = total_len.saturating_sub(suffix_len);
        let end = total_len.saturating_sub(1);
        Some((start, end))
    } else {
        let start: u64 = start_str.parse().ok()?;
        let end: u64 = if end_str.is_empty() {
            total_len.saturating_sub(1)
        } else {
            end_str.parse().ok()?
        };
        if start <= end && start < total_len {
            let clamped_end = end.min(total_len.saturating_sub(1));
            Some((start, clamped_end))
        } else {
            None
        }
    }
}

fn deterministic_hash_64(s: &str) -> u64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for b in s.as_bytes() {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

async fn proxy_direct_stream(client: &reqwest::Client, target: &str, is_live: bool) -> Result<Response, StatusCode> {
    let upstream = client
        .get(target)
        .header(
            header::USER_AGENT,
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
        )
        .header(header::ACCEPT, "*/*")
        .send()
        .await
        .map_err(|e| {
            eprintln!("[Stream] Direct proxy connection error: {}: {}", target, e);
            StatusCode::BAD_GATEWAY
        })?;

    if !upstream.status().is_success() {
        eprintln!("[Stream] Upstream returned error status {}: {}", upstream.status(), target);
        return Err(StatusCode::BAD_GATEWAY);
    }

    let upstream_ct = upstream
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_else(|| {
            if target.contains(".flac") {
                "audio/flac"
            } else if target.contains(".wav") {
                "audio/wav"
            } else if target.contains(".aac") || target.contains(".aacp") {
                "audio/aac"
            } else {
                "audio/mpeg"
            }
        })
        .to_string();

    let mut res_headers = HeaderMap::new();
    res_headers.insert(
        header::CONTENT_TYPE,
        upstream_ct.parse().unwrap_or(header::HeaderValue::from_static("audio/mpeg")),
    );
    res_headers.insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("no-cache, no-store, must-revalidate"),
    );

    if !is_live {
        if let Some(cl) = upstream.headers().get(header::CONTENT_LENGTH) {
            res_headers.insert(header::CONTENT_LENGTH, cl.clone());
        }
        if let Some(ar) = upstream.headers().get(header::ACCEPT_RANGES) {
            res_headers.insert(header::ACCEPT_RANGES, ar.clone());
        }
    } else {
        res_headers.insert(header::ACCEPT_RANGES, header::HeaderValue::from_static("none"));
    }

    let body = Body::from_stream(upstream.bytes_stream());
    Ok((StatusCode::OK, res_headers, body).into_response())
}

pub async fn stream_audio(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(params): Query<StreamParams>,
) -> Result<Response, StatusCode> {
    let client_ip = get_client_ip(&headers, Some(addr));
    let is_prefetch = params.prefetch.unwrap_or(false);
    if !is_prefetch {
        check_rate_limit(
            &state.endpoint_rate_limits,
            &format!("stream:{}", client_ip),
            600,
            60,
        )?;
    }

    let mut target = String::new();
    eprintln!("[STREAM] New request: title={:?}, artist={:?}, id={:?}, quality={:?}, format={:?}", params.title, params.artist, params.id, params.quality, params.format);

    if let Some(id) = params.id.clone() {
        let id_clean = id.trim().to_string();
        if id_clean.starts_with("sc-") {
            target = id_clean;
        } else if id_clean.starts_with("http") {
            target = id_clean;
        } else if id_clean.len() == 11 && id_clean.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
            target = format!("https://www.youtube.com/watch?v={}", id_clean);
        }
    }

    if target.is_empty() {
        if let Some(u) = params.url.clone() {
            if !u.trim().is_empty() {
                target = u.trim().to_string();
            }
        }
    }

    if target.is_empty() {
        if let Some(id) = params.id.clone() {
            let id_clean = id.trim().to_string();
            if let Some(yt_id) = id_clean.strip_prefix("yt-") {
                if yt_id.len() == 11 && yt_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
                    target = format!("https://www.youtube.com/watch?v={}", yt_id);
                }
            } else if !id_clean.starts_with("dz-") && !id_clean.starts_with("lfm-") && !id_clean.starts_with("audius-") && !id_clean.starts_with("starter-") && !id_clean.starts_with("default-") {
                target = id_clean;
            }
        }
    }

    if target.is_empty() {
        if let Some(title) = params.title.as_deref() {
            let t = title.trim();
            if !t.is_empty() {
                let artist = params.artist.as_deref().unwrap_or("").trim();
                let clean = clean_music_title(t);
                let clean_art = clean_music_title(artist);
                if !clean_art.is_empty() {
                    target = format!("search:{} {}", clean, clean_art);
                } else {
                    target = format!("search:{}", clean);
                }
            }
        }
    }

    if target.is_empty() || target.starts_with('-') {
        return Err(StatusCode::BAD_REQUEST);
    }

    if target.contains(":8052") || target.contains("ep256.hostingradio.ru") || target.contains("europaplus256.mp3") {
        if target.contains("top") || target.contains("256") {
            target = "https://europaplus.hostingradio.ru:8014/ep-top256.mp3".to_string();
        } else {
            target = "https://ep128server.streamr.ru:8030/ep128".to_string();
        }
    }

    if target.starts_with("http://") || target.starts_with("https://") {
        let is_trusted_music_domain = target.contains("youtube.com")
            || target.contains("youtu.be")
            || target.contains("soundcloud.com")
            || target.contains("audius.co")
            || target.contains("audius")
            || target.contains("archive.org")
            || target.contains("sndcdn.com");
        if !is_trusted_music_domain {
            check_url_ssrf(&target).await?;
        }
    }

    let is_live = params.is_live.unwrap_or(false);
    let is_direct_candidate = (target.starts_with("http://") || target.starts_with("https://"))
        && !target.contains("youtube.com")
        && !target.contains("youtu.be")
        && !target.contains("soundcloud.com")
        && !target.contains("googlevideo.com")
        && !target.contains("sndcdn.com")
        && (is_live
            || target.ends_with(".mp3")
            || target.ends_with(".flac")
            || target.ends_with(".wav")
            || target.ends_with(".aac")
            || target.ends_with(".aacp")
            || target.ends_with(".m3u8")
            || target.ends_with(".ogg")
            || target.contains("/stream")
            || target.contains("hostingradio.ru")
            || target.contains("somafm.com")
            || target.contains("streamr.ru")
            || target.contains("101.ru")
            || target.contains(":80"));

    if is_direct_candidate && params.ss.unwrap_or(0) == 0 {
        if params.prefetch.unwrap_or(false) {
            return Ok(StatusCode::NO_CONTENT.into_response());
        }
        match proxy_direct_stream(&state.http_client, &target, is_live).await {
            Ok(resp) => return Ok(resp),
            Err(e) => {
                if is_live {
                    return Err(e);
                }
            }
        }
    }

    let is_lossless_requested = params.quality.as_deref() == Some("lossless")
        || params.format.as_deref() == Some("flac")
        || target.ends_with(".flac")
        || target.contains(".flac?");

    let cache_key = if let (Some(t), Some(a)) = (&params.title, &params.artist) {
        format!("{}:{}:{}:{}", target, t.trim(), a.trim(), if is_lossless_requested { "lossless" } else { "standard" })
    } else {
        format!("{}:{}", target, if is_lossless_requested { "lossless" } else { "standard" })
    };

    let cache_ext = if is_lossless_requested { "flac" } else { "mp3" };
    let cache_mime = if is_lossless_requested { "audio/flac" } else { "audio/mpeg" };

    let cache_filename = format!("{:016x}.{}", deterministic_hash_64(&cache_key), cache_ext);
    let cache_dir = std::env::var("CACHE_DIR").unwrap_or_else(|_| "/var/www/recro/cache".to_string());
    let _ = std::fs::create_dir_all(&cache_dir);
    let cache_file_path = format!("{}/{}", cache_dir, cache_filename);

    if params.ss.unwrap_or(0) == 0 && !is_live {
        let is_transcoding = state
            .active_transcodes
            .lock()
            .map(|g| g.contains(&cache_filename))
            .unwrap_or(false);
        if is_transcoding {
            // If background transcoding is currently in progress, wait up to 2.5s for it to finish
            // so we serve the static cached file directly rather than spawning duplicate ffmpegs!
            for _ in 0..25 {
                tokio::time::sleep(Duration::from_millis(100)).await;
                let still_transcoding = state
                    .active_transcodes
                    .lock()
                    .map(|g| g.contains(&cache_filename))
                    .unwrap_or(false);
                if !still_transcoding {
                    break;
                }
            }
        }

        if let Ok(mut file) = tokio::fs::File::open(&cache_file_path).await {
            if let Ok(meta) = file.metadata().await {
                let total_size = meta.len();
                if total_size > 100_000 {
                    if params.prefetch.unwrap_or(false) {
                        return Ok(StatusCode::NO_CONTENT.into_response());
                    }

                    let mut res_headers = HeaderMap::new();
                    res_headers.insert(header::CONTENT_TYPE, cache_mime.parse().unwrap());
                    res_headers.insert(header::ACCEPT_RANGES, header::HeaderValue::from_static("bytes"));
                    res_headers.insert(header::CACHE_CONTROL, header::HeaderValue::from_static("public, max-age=604800, immutable"));
                    if is_lossless_requested {
                        res_headers.insert("X-Audio-Quality", header::HeaderValue::from_static("lossless"));
                        res_headers.insert("X-Audio-Codec", header::HeaderValue::from_static("flac"));
                        res_headers.insert("X-Audio-Bitrate", header::HeaderValue::from_static("1411k"));
                    } else {
                        res_headers.insert("X-Audio-Quality", header::HeaderValue::from_static("high"));
                        res_headers.insert("X-Audio-Codec", header::HeaderValue::from_static("mp3"));
                        res_headers.insert("X-Audio-Bitrate", header::HeaderValue::from_static("320k"));
                    }

                    if let Some(range_header) = headers.get(header::RANGE).and_then(|v| v.to_str().ok()) {
                        if let Some((start, end)) = parse_byte_range(range_header, total_size) {
                            if file.seek(SeekFrom::Start(start)).await.is_ok() {
                                let length_to_read = end - start + 1;
                                let limited_reader = file.take(length_to_read);
                                let stream = tokio_util::io::ReaderStream::new(limited_reader);
                                let body = Body::from_stream(stream);

                                res_headers.insert(header::CONTENT_LENGTH, length_to_read.to_string().parse().unwrap());
                                res_headers.insert(header::CONTENT_RANGE, format!("bytes {}-{}/{}", start, end, total_size).parse().unwrap());

                                return Ok((StatusCode::PARTIAL_CONTENT, res_headers, body).into_response());
                            }
                        } else {
                            let mut err_headers = HeaderMap::new();
                            err_headers.insert(header::CONTENT_RANGE, format!("bytes */{}", total_size).parse().unwrap());
                            return Ok((StatusCode::RANGE_NOT_SATISFIABLE, err_headers, Body::empty()).into_response());
                        }
                    }

                    let stream = tokio_util::io::ReaderStream::new(file);
                    let body = Body::from_stream(stream);
                    res_headers.insert(header::CONTENT_LENGTH, total_size.to_string().parse().unwrap());
                    return Ok((StatusCode::OK, res_headers, body).into_response());
                }
            }
        }
    }

    let mut direct_url = String::new();

    if let Ok(guard) = state.stream_cache.lock() {
        if let Some((cached_url, cached_at)) = guard.get(&cache_key) {
            if cached_at.elapsed() < Duration::from_secs(600) {
                direct_url = cached_url.clone();
            }
        }
    }

    let acquire_timeout = if is_prefetch {
        Duration::from_millis(3000)
    } else {
        Duration::from_millis(12000)
    };
    let _permit = match tokio::time::timeout(
        acquire_timeout,
        state.stream_semaphore.acquire(),
    )
    .await
    {
        Ok(Ok(permit)) => permit,
        _ => return Err(StatusCode::TOO_MANY_REQUESTS),
    };

    let yt_cmd = get_yt_dlp_cmd();

    if direct_url.is_empty() {
        let is_direct_candidate = target.starts_with("http://") || target.starts_with("https://");
        if is_direct_candidate
            && (target.ends_with(".mp3")
                || target.ends_with(".aac")
                || target.ends_with(".aacp")
                || target.ends_with(".m3u8")
                || target.contains("audius.co")
                || target.contains("cidstream")
                || target.contains("archive.org")
                || target.contains("/stream")
                || target.contains(":80"))
        {
            direct_url = target.clone();
        } else if target.starts_with("sc-") {
            if let Some(u) = state.soundcloud.resolve_stream_url(&target).await {
                direct_url = u;
            }
        } else if target.contains("soundcloud.com") && !target.starts_with("scsearch") && !target.starts_with("search:") {
            if let Some(u) = state.soundcloud.resolve_stream_by_permalink(&target).await {
                direct_url = u;
            } else {
                let mut sc_cmd = Command::new(&yt_cmd);
                apply_yt_dlp_common_args_no_cookies(&mut sc_cmd);
                sc_cmd.kill_on_drop(true);
                sc_cmd.args(["--no-playlist", "--ignore-errors", "-g", "-f", "bestaudio/b", "--", &target]);
                if let Ok(Ok(out)) = tokio::time::timeout(Duration::from_secs(5), sc_cmd.output()).await {
                    if let Some(u) = extract_stream_url_from_output(&out) {
                        direct_url = u;
                    }
                }
            }
        }

        if direct_url.is_empty() {
            let mut resolved_title = params.title.as_deref().unwrap_or("").trim().to_string();
            let mut resolved_uploader = params.artist.as_deref().unwrap_or("").trim().to_string();

            if resolved_title.is_empty() && target.contains("soundcloud.com/") {
                if let Some(path) = target.split("soundcloud.com/").nth(1) {
                    let parts: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
                    if parts.len() >= 2 {
                        resolved_uploader = parts[0].replace('-', " ");
                        resolved_title = parts[1].replace('-', " ");
                    } else if parts.len() == 1 {
                        resolved_title = parts[0].replace('-', " ");
                    }
                }
            }

            let is_youtube_target = target.contains("youtube.com") || target.contains("youtu.be");

            if direct_url.is_empty() && resolved_title.is_empty() && is_youtube_target {
                let oembed_url = format!(
                    "https://www.youtube.com/oembed?url={}&format=json",
                    urlencoding::encode(&target)
                );
                if let Ok(resp) = state.http_client.get(&oembed_url).timeout(Duration::from_millis(1500)).send().await {
                    if resp.status().is_success() {
                        if let Ok(bytes) = resp.bytes().await {
                            if let Ok(data) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                                if let Some(t) = data["title"].as_str() {
                                    resolved_title = t.trim().to_string();
                                }
                                if let Some(a) = data["author_name"].as_str() {
                                    resolved_uploader = a.trim().to_string();
                                }
                            }
                        }
                    }
                }
            }

            if resolved_title.is_empty() && (target.starts_with("search:") || target.starts_with("scsearch")) {
                let stripped = if let Some(s) = target.strip_prefix("search:") {
                    s
                } else if let Some(s) = target.find(':').map(|idx| &target[idx + 1..]) {
                    s
                } else {
                    &target
                };
                resolved_title = stripped.trim().to_string();
            }

            // 1. On Frankfurt node, SoundCloud resolves in 150ms natively.
            // On Moscow (RU) node, SoundCloud CDN blocks Russian IP addresses with 403 Forbidden,
            // so we skip SoundCloud directly and resolve via YouTube first. If YouTube fails, Fallback 3 proxies from Frankfurt.
            if is_frankfurt() && direct_url.is_empty() && !resolved_title.is_empty() {
                let clean_title = clean_music_title(&resolved_title);
                let clean_uploader = clean_music_title(&resolved_uploader);
                let sc_query = if !clean_uploader.is_empty() && !clean_title.to_lowercase().contains(&clean_uploader.to_lowercase()) {
                    format!("{} {}", clean_title, clean_uploader)
                } else {
                    clean_title.clone()
                };

                eprintln!("[STREAM] Querying SoundCloud with sc_query={:?}", sc_query);
                if let Ok(Some(u)) = tokio::time::timeout(Duration::from_millis(3500), state.soundcloud.search_and_resolve_stream(&sc_query)).await {
                    eprintln!("[STREAM] SoundCloud stream resolved directly: {}", u);
                    direct_url = u;
                }
            }

            // 2. Direct YouTube extraction if target is a YouTube URL and SoundCloud didn't match
            if is_youtube_target && direct_url.is_empty() {
                let mut cmd_fast = Command::new(&yt_cmd);
                apply_yt_dlp_common_args(&mut cmd_fast);
                cmd_fast.kill_on_drop(true);
                cmd_fast.args([
                    "--no-playlist",
                    "--ignore-errors",
                    "-g",
                    "-f", "ba[ext=m4a]/ba/b",
                    "--extractor-args", "youtube:player_client=ios,android,web",
                    "--",
                    &target,
                ]);
                if let Ok(Ok(out)) = tokio::time::timeout(Duration::from_millis(9000), cmd_fast.output()).await {
                    if let Some(u) = extract_stream_url_from_output(&out) {
                        direct_url = u;
                    }
                }
            }

            // 3. YouTube search fallback if SoundCloud had no hits
            if direct_url.is_empty() && !resolved_title.is_empty() {
                let clean_title = clean_music_title(&resolved_title);
                let clean_uploader = clean_music_title(&resolved_uploader);
                let yt_query = if !clean_uploader.is_empty() && !clean_title.to_lowercase().contains(&clean_uploader.to_lowercase()) {
                    format!("ytsearch1:{} {}", clean_title, clean_uploader)
                } else {
                    format!("ytsearch1:{}", clean_title)
                };

                let mut yt_search_cmd = Command::new(&yt_cmd);
                apply_yt_dlp_common_args(&mut yt_search_cmd);
                yt_search_cmd.kill_on_drop(true);
                yt_search_cmd.args([
                    "--no-playlist",
                    "--ignore-errors",
                    "-g",
                    "-f", "ba[ext=m4a]/ba/b",
                    "--extractor-args", "youtube:player_client=ios,android,web",
                    "--",
                    &yt_query,
                ]);
                if let Ok(Ok(yt_out)) = tokio::time::timeout(Duration::from_millis(9000), yt_search_cmd.output()).await {
                    if let Some(u) = extract_stream_url_from_output(&yt_out) {
                        direct_url = u;
                    }
                }
            }

            // Fallback 2: Verified high-health Invidious API
            if direct_url.is_empty() {
                let vid = if let Some(idx) = target.find("v=") {
                    let rest = &target[idx + 2..];
                    let end = rest.find(['&', '?', '#', '/']).unwrap_or(rest.len());
                    Some(rest[..end].to_string())
                } else if let Some(idx) = target.find("youtu.be/") {
                    let rest = &target[idx + 9..];
                    let end = rest.find(['&', '?', '#', '/']).unwrap_or(rest.len());
                    Some(rest[..end].to_string())
                } else {
                    None
                };

                if let Some(v) = vid {
                    let instances = [
                        "https://invidious.f5.si",
                    ];
                    if let Ok(client) = reqwest::Client::builder().timeout(Duration::from_secs(3)).build() {
                        for inst in instances {
                            let inv_url = format!("{}/api/v1/videos/{}", inst, v);
                            if let Ok(resp) = client.get(&inv_url).send().await {
                                if resp.status().is_success() {
                                    if let Ok(bytes) = resp.bytes().await {
                                        if let Ok(data) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                                            if let Some(formats) = data["adaptiveFormats"].as_array() {
                                                for f in formats {
                                                    if let Some(t) = f["type"].as_str() {
                                                        if t.starts_with("audio/") {
                                                            if let Some(u) = f["url"].as_str() {
                                                                if !u.is_empty() {
                                                                    direct_url = u.to_string();
                                                                    break;
                                                                }
                                                            }
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                            if !direct_url.is_empty() {
                                break;
                            }
                        }
                    }
                }
            }

            // Fallback 3: Foreign Frankfurt cluster proxy when local stream resolution fails (e.g. RU blocks)
            let is_frankfurt = is_frankfurt();

            if direct_url.is_empty() && (!is_frankfurt || is_cloud_env()) && !CLOUD_FALLBACK_URL.is_empty() {
                let mut fwd_params = Vec::new();
                if let Some(ref t) = params.title {
                    fwd_params.push(format!("title={}", urlencoding::encode(t)));
                }
                if let Some(ref a) = params.artist {
                    fwd_params.push(format!("artist={}", urlencoding::encode(a)));
                }
                if let Some(ref id) = params.id {
                    fwd_params.push(format!("id={}", urlencoding::encode(id)));
                }
                if !target.is_empty() {
                    fwd_params.push(format!("url={}", urlencoding::encode(&target)));
                }
                if let Some(ss) = params.ss {
                    fwd_params.push(format!("ss={}", ss));
                }
                if let Some(ref q) = params.quality {
                    fwd_params.push(format!("quality={}", urlencoding::encode(q)));
                }
                if let Some(ref f) = params.format {
                    fwd_params.push(format!("format={}", urlencoding::encode(f)));
                }

                let cloud_stream_url = format!("{}/api/stream?{}", CLOUD_FALLBACK_URL, fwd_params.join("&"));
                eprintln!("[STREAM] Falling back to foreign cluster node: {}", cloud_stream_url);

                if let Ok(client) = reqwest::Client::builder().timeout(Duration::from_secs(30)).build() {
                    let is_prefetch = params.prefetch.unwrap_or(false);
                    let mut req = client.get(&cloud_stream_url);
                    if let Some(range_val) = headers.get(header::RANGE) {
                        if !is_prefetch {
                            req = req.header(header::RANGE, range_val);
                        }
                    }
                    if let Ok(mut resp) = req.send().await {
                        let status = resp.status();
                        if status.is_success() || status == StatusCode::PARTIAL_CONTENT {
                            // If this was a prefetch request and returned 200 OK, save full stream to disk cache!
                            if is_prefetch && status.is_success() && !cache_file_path.is_empty() {
                                let tmp_path = format!("{}.tmp.{}", cache_file_path, fastrand::u64(..));
                                use tokio::io::AsyncWriteExt;
                                if let Ok(mut f) = tokio::fs::File::create(&tmp_path).await {
                                    let mut written = 0u64;
                                    while let Ok(Some(chunk)) = resp.chunk().await {
                                        written += chunk.len() as u64;
                                        let _ = f.write_all(&chunk).await;
                                    }
                                    let _ = f.flush().await;
                                    drop(f);
                                    if written > 100_000 {
                                        let _ = tokio::fs::rename(&tmp_path, &cache_file_path).await;
                                        eprintln!("[STREAM] Prefetched & cached to disk: {} ({} bytes)", cache_file_path, written);
                                        return Ok(StatusCode::NO_CONTENT.into_response());
                                    } else {
                                        let _ = tokio::fs::remove_file(&tmp_path).await;
                                    }
                                }
                            }

                            let mut res_headers = HeaderMap::new();
                            let fwd_ct = resp.headers().get(header::CONTENT_TYPE).cloned().unwrap_or_else(|| "audio/mpeg".parse().unwrap());
                            res_headers.insert(header::CONTENT_TYPE, fwd_ct);
                            if let Some(cl) = resp.headers().get(header::CONTENT_LENGTH) {
                                res_headers.insert(header::CONTENT_LENGTH, cl.clone());
                            }
                            if let Some(ar) = resp.headers().get(header::ACCEPT_RANGES) {
                                res_headers.insert(header::ACCEPT_RANGES, ar.clone());
                            }
                            if let Some(cr) = resp.headers().get(header::CONTENT_RANGE) {
                                res_headers.insert(header::CONTENT_RANGE, cr.clone());
                            }
                            res_headers.insert(header::CACHE_CONTROL, header::HeaderValue::from_static("public, max-age=604800"));

                            let stream = resp.bytes_stream();
                            let body = Body::from_stream(stream);
                            return Ok((status, res_headers, body).into_response());
                        }
                    }
                }
            }
        }

        if !direct_url.is_empty() {
            if let Ok(mut guard) = state.stream_cache.lock() {
                if guard.len() > 1000 {
                    guard.retain(|_, (_, cached_at)| cached_at.elapsed() < Duration::from_secs(600));
                    if guard.len() > 1500 {
                        guard.clear();
                    }
                }
                guard.insert(cache_key, (direct_url.clone(), std::time::Instant::now()));
            }
        }
    }

    if direct_url.is_empty() {
        return Err(StatusCode::NOT_FOUND);
    }

    let referer = if direct_url.contains("soundcloud") || direct_url.contains("sndcdn") {
        "https://soundcloud.com/"
    } else if direct_url.contains("audius") || direct_url.contains("cidstream") {
        "https://audius.co/"
    } else {
        "https://www.youtube.com/"
    };

    // Background cache transcoding: only for explicit prefetch requests
    if params.prefetch.unwrap_or(false) {
        if !is_cloud_env() && params.ss.unwrap_or(0) == 0 && !is_live {
            let is_already_transcoding = {
                let mut guard = state.active_transcodes.lock().unwrap_or_else(|p| p.into_inner());
                if guard.contains(&cache_filename) {
                    true
                } else {
                    guard.insert(cache_filename.clone());
                    false
                }
            };

            if !is_already_transcoding {
                let active_transcodes = state.active_transcodes.clone();
                let cfn = cache_filename.clone();
                let cfp = cache_file_path.clone();
                let d_url = direct_url.clone();
                let ref_hdr = referer.to_string();

                tokio::spawn(async move {
                    let (codec_args, fmt_arg) = if is_lossless_requested {
                        (vec!["-c:a", "flac", "-compression_level", "5"], "flac")
                    } else if d_url.contains(".mp3") {
                        (vec!["-c:a", "copy"], "mp3")
                    } else {
                        (vec!["-c:a", "libmp3lame", "-b:a", "320k"], "mp3")
                    };

                    let tmp_file_path = format!("{}.tmp.{}", cfp, fastrand::u64(..));

                    let mut conv_cmd = Command::new("ffmpeg");
                    conv_cmd.kill_on_drop(true);
                    conv_cmd.args([
                        "-y",
                        "-probesize", "65536",
                        "-analyzeduration", "500000",
                        "-protocol_whitelist", "file,http,https,tcp,tls,crypto,data,hls,applehttp",
                        "-user_agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
                        "-referer", &ref_hdr,
                        "-reconnect", "1",
                        "-reconnect_streamed", "1",
                        "-reconnect_on_network_error", "1",
                        "-reconnect_delay_max", "5",
                        "-i", &d_url,
                        "-vn",
                    ]);
                    conv_cmd.args(&codec_args);
                    conv_cmd.args(["-f", fmt_arg, &tmp_file_path]);
                    conv_cmd.stdout(Stdio::null());
                    conv_cmd.stderr(Stdio::null());

                    let exit_status = if let Ok(mut child) = conv_cmd.spawn() {
                        match tokio::time::timeout(Duration::from_secs(360), child.wait()).await {
                            Ok(Ok(status)) => Some(status),
                            _ => {
                                let _ = child.kill().await;
                                None
                            }
                        }
                    } else {
                        None
                    };

                    if let Some(status) = exit_status {
                        if status.success() {
                            if let Ok(meta) = std::fs::metadata(&tmp_file_path) {
                                if meta.len() > 100_000 {
                                    let _ = std::fs::rename(&tmp_file_path, &cfp);
                                    if let Ok(mut guard) = active_transcodes.lock() {
                                        guard.remove(&cfn);
                                    }
                                    return;
                                }
                            }
                        }
                    }
                    let _ = std::fs::remove_file(&tmp_file_path);
                    if let Ok(mut guard) = active_transcodes.lock() {
                        guard.remove(&cfn);
                    }
                });
            }
        }

        return Ok(StatusCode::NO_CONTENT.into_response());
    }

    // Direct immediate live streaming with ultra-fast startup (<50ms probe time)
    let mut ffmpeg_args = vec![
        "-probesize".to_string(),
        "65536".to_string(),
        "-analyzeduration".to_string(),
        "500000".to_string(),
        "-protocol_whitelist".to_string(),
        "file,http,https,tcp,tls,crypto,data,hls,applehttp".to_string(),
        "-user_agent".to_string(),
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36".to_string(),
        "-referer".to_string(),
        referer.to_string(),
        "-reconnect".to_string(),
        "1".to_string(),
        "-reconnect_streamed".to_string(),
        "1".to_string(),
        "-reconnect_on_network_error".to_string(),
        "1".to_string(),
        "-reconnect_on_http_error".to_string(),
        "4xx,5xx".to_string(),
        "-reconnect_delay_max".to_string(),
        "5".to_string(),
        "-seg_max_retry".to_string(),
        "8".to_string(),
        "-rw_timeout".to_string(),
        "15000000".to_string(),
        "-i".to_string(),
        direct_url.clone(),
    ];

    if let Some(seek_sec) = params.ss {
        if seek_sec > 0 {
            ffmpeg_args.push("-ss".to_string());
            ffmpeg_args.push(seek_sec.to_string());
        }
    }

    let is_flac_direct = direct_url.ends_with(".flac") || direct_url.contains(".flac?");
    let is_mp3_direct = direct_url.ends_with(".mp3") || direct_url.contains(".mp3?");

    if is_lossless_requested {
        if is_flac_direct && params.ss.unwrap_or(0) == 0 {
            ffmpeg_args.extend([
                "-vn".to_string(),
                "-c:a".to_string(),
                "copy".to_string(),
                "-f".to_string(),
                "flac".to_string(),
                "pipe:1".to_string(),
            ]);
        } else {
            // Encode in Bit-Perfect FLAC Lossless (16/24-bit PCM -> FLAC)
            ffmpeg_args.extend([
                "-vn".to_string(),
                "-c:a".to_string(),
                "flac".to_string(),
                "-compression_level".to_string(),
                "5".to_string(),
                "-f".to_string(),
                "flac".to_string(),
                "pipe:1".to_string(),
            ]);
        }
    } else if is_mp3_direct && params.ss.unwrap_or(0) == 0 {
        ffmpeg_args.extend([
            "-vn".to_string(),
            "-c:a".to_string(),
            "copy".to_string(),
            "-f".to_string(),
            "mp3".to_string(),
            "-flush_packets".to_string(),
            "1".to_string(),
            "pipe:1".to_string(),
        ]);
    } else {
        let bitrate = match params.quality.as_deref() {
            Some("high") => "320k",
            Some("data_saver") => "128k",
            _ => "320k",
        };
        ffmpeg_args.extend([
            "-vn".to_string(),
            "-c:a".to_string(),
            "libmp3lame".to_string(),
            "-b:a".to_string(),
            bitrate.to_string(),
            "-compression_level".to_string(),
            "2".to_string(),
            "-threads".to_string(),
            "2".to_string(),
            "-f".to_string(),
            "mp3".to_string(),
            "-flush_packets".to_string(),
            "1".to_string(),
            "pipe:1".to_string(),
        ]);
    }

    eprintln!("[STREAM] Spawning ffmpeg for direct_url: {}", direct_url);
    let mut ffmpeg_cmd = Command::new("ffmpeg");
    ffmpeg_cmd.kill_on_drop(true);
    let mut ffmpeg_child = match ffmpeg_cmd
        .args(&ffmpeg_args)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(c) => {
            eprintln!("[STREAM] ffmpeg spawned successfully!");
            c
        },
        Err(e) => {
            eprintln!("[STREAM] ffmpeg spawn failed: {}", e);
            return Err(StatusCode::INTERNAL_SERVER_ERROR);
        }
    };

    let stdout = match ffmpeg_child.stdout.take() {
        Some(s) => s,
        None => return Err(StatusCode::INTERNAL_SERVER_ERROR),
    };

    let kill_notify = Arc::new(tokio::sync::Notify::new());
    let kill_notify_child = kill_notify.clone();

    tokio::spawn(async move {
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(360)) => {
                let _ = ffmpeg_child.start_kill();
            }
            _ = kill_notify_child.notified() => {
                let _ = ffmpeg_child.start_kill();
            }
            _ = ffmpeg_child.wait() => {}
        }
    });

    let tmp_file_path = format!("{}.tmp.{}", cache_file_path, fastrand::u64(..));
    let file_opt = if !is_cloud_env() && params.ss.unwrap_or(0) == 0 && !is_live {
        tokio::fs::File::create(&tmp_file_path).await.ok()
    } else {
        None
    };

    let (tx, rx) = tokio::sync::mpsc::channel::<Result<axum::body::Bytes, std::io::Error>>(128);
    let cfp = cache_file_path.clone();
    let tmp_fp = tmp_file_path.clone();
    let kill_on_disconnect = kill_notify.clone();

    tokio::spawn(async move {
        use tokio::io::AsyncWriteExt;
        use tokio_stream::StreamExt;

        let mut reader_stream = ReaderStream::with_capacity(stdout, 64 * 1024);
        let mut total_bytes = 0u64;
        let mut write_error = false;
        let mut client_disconnected = false;
        let mut file = file_opt;

        while let Some(chunk_res) = reader_stream.next().await {
            match chunk_res {
                Ok(bytes) => {
                    if let Some(ref mut f) = file {
                        if !write_error {
                            if f.write_all(&bytes).await.is_err() {
                                write_error = true;
                            } else {
                                total_bytes += bytes.len() as u64;
                            }
                        }
                    }
                    if tx.send(Ok(bytes)).await.is_err() {
                        // Client stopped listening or skipped track — DO NOT cache truncated file!
                        client_disconnected = true;
                        break;
                    }
                }
                Err(e) => {
                    let _ = tx.send(Err(e)).await;
                    client_disconnected = true;
                    break;
                }
            }
        }

        if client_disconnected {
            kill_on_disconnect.notify_one();
        }

        if let Some(mut f) = file {
            let _ = f.flush().await;
            drop(f);
            if !client_disconnected && !write_error && total_bytes > 200_000 {
                let _ = tokio::fs::rename(&tmp_fp, &cfp).await;
                eprintln!("[STREAM] Track fully streamed and safely cached to disk: {} ({} bytes)", cfp, total_bytes);
            } else {
                let _ = tokio::fs::remove_file(&tmp_fp).await;
            }
        }
    });

    let body = Body::from_stream(tokio_stream::wrappers::ReceiverStream::new(rx));

    let mut res_headers = HeaderMap::new();
    res_headers.insert(header::CONTENT_TYPE, cache_mime.parse().unwrap());
    res_headers.insert(header::CACHE_CONTROL, "no-cache, no-store, must-revalidate".parse().unwrap());
    res_headers.insert(header::ACCEPT_RANGES, header::HeaderValue::from_static("none"));
    if is_lossless_requested {
        res_headers.insert("X-Audio-Quality", header::HeaderValue::from_static("lossless"));
        res_headers.insert("X-Audio-Codec", header::HeaderValue::from_static("flac"));
        res_headers.insert("X-Audio-Bitrate", header::HeaderValue::from_static("1411k"));
    } else {
        res_headers.insert("X-Audio-Quality", header::HeaderValue::from_static("high"));
        res_headers.insert("X-Audio-Codec", header::HeaderValue::from_static("mp3"));
        res_headers.insert("X-Audio-Bitrate", header::HeaderValue::from_static("320k"));
    }

    Ok((StatusCode::OK, res_headers, body).into_response())
}
