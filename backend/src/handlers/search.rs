use axum::{
    extract::{ConnectInfo, Query, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use std::collections::HashSet;
use std::net::SocketAddr;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncBufReadExt;
use tokio::process::Command;

use crate::config::{apply_yt_dlp_common_args, get_base_url, get_yt_dlp_cmd, is_cloud_env, CLOUD_FALLBACK_URL};
use crate::models::{ExtractParams, ExtractResponse, SearchParams, SearchTrack};
use crate::security::{check_rate_limit, check_url_ssrf, get_client_ip};
use crate::ytdlp::{execute_cloud_search, execute_yt_dlp_search, parse_track_json};
use crate::AppState;

pub async fn search_music(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(params): Query<SearchParams>,
) -> Result<Json<Vec<SearchTrack>>, StatusCode> {
    let client_ip = get_client_ip(&headers, Some(addr));
    check_rate_limit(
        &state.endpoint_rate_limits,
        &format!("search:{}", client_ip),
        30,
        60,
    )?;

    let query = params.q.trim();
    if query.is_empty() {
        return Ok(Json(Vec::new()));
    }

    let query_key = query.to_lowercase();
    if let Ok(guard) = state.search_cache.lock() {
        if let Some((cached_tracks, cached_at)) = guard.get(&query_key) {
            if cached_at.elapsed() < Duration::from_secs(7200) && !cached_tracks.is_empty() {
                return Ok(Json(cached_tracks.clone()));
            }
        }
    }

    let _permit = match tokio::time::timeout(
        Duration::from_millis(2000),
        state.heavy_process_semaphore.acquire(),
    )
    .await
    {
        Ok(Ok(permit)) => permit,
        _ => return Err(StatusCode::TOO_MANY_REQUESTS),
    };

    let yt_cmd = get_yt_dlp_cmd();
    let base_url = get_base_url();
    let is_direct_url = query.starts_with("http://") || query.starts_with("https://");

    if is_direct_url {
        let is_trusted = query.contains("youtube.com")
            || query.contains("youtu.be")
            || query.contains("soundcloud.com");
        if !is_trusted {
            check_url_ssrf(query).await?;
        }

        let mut tracks = execute_yt_dlp_search(&yt_cmd, query, 15, &base_url).await;
        if tracks.is_empty() && !is_cloud_env() {
            let cloud_tracks = execute_cloud_search(query, &base_url).await;
            if !cloud_tracks.is_empty() {
                tracks = cloud_tracks;
            }
        }
        if !tracks.is_empty() {
            if let Ok(mut guard) = state.search_cache.lock() {
                guard.insert(query_key, (tracks.clone(), std::time::Instant::now()));
            }
        }
        return Ok(Json(tracks));
    }

    let sc_arg = format!("scsearch10:{}", query);

    // Parallel fetch: Deezer API (super-fast official tracks, HD covers) + SoundCloud (remixes & underground)
    let (dz_res, sc_res) = tokio::join!(
        execute_deezer_search(query, 12, &base_url),
        execute_yt_dlp_search(&yt_cmd, &sc_arg, 8, &base_url),
    );

    let mut combined = Vec::new();
    let mut seen_ids = HashSet::new();

    let is_valid_duration = |duration: f64| -> bool {
        duration == 0.0 || (duration >= 30.0 && duration <= 600.0)
    };

    let dz_filtered: Vec<SearchTrack> = dz_res
        .into_iter()
        .filter(|t| is_valid_duration(t.duration))
        .collect();

    let sc_filtered: Vec<SearchTrack> = sc_res
        .into_iter()
        .filter(|t| is_valid_duration(t.duration))
        .collect();

    // Balanced interleave: official studio releases + soundcloud community gems
    let max_len = dz_filtered.len().max(sc_filtered.len());
    for i in 0..max_len {
        if i < dz_filtered.len() {
            let t = &dz_filtered[i];
            if seen_ids.insert(t.id.clone()) {
                combined.push(t.clone());
            }
        }
        if i < sc_filtered.len() {
            let t = &sc_filtered[i];
            if seen_ids.insert(t.id.clone()) {
                combined.push(t.clone());
            }
        }
    }

    // Fallback: If both Deezer and SoundCloud had no hits, fallback to YouTube search
    if combined.is_empty() {
        let yt_arg = format!("ytsearch8:{}", query);
        let yt_res = execute_yt_dlp_search(&yt_cmd, &yt_arg, 8, &base_url).await;
        for t in yt_res {
            if is_valid_duration(t.duration) && seen_ids.insert(t.id.clone()) {
                combined.push(t);
            }
        }
    }

    if combined.is_empty() && !is_cloud_env() {
        let cloud_tracks = execute_cloud_search(query, &base_url).await;
        for t in cloud_tracks {
            if seen_ids.insert(t.id.clone()) {
                combined.push(t);
            }
        }
    }

    if !combined.is_empty() {
        if let Ok(mut guard) = state.search_cache.lock() {
            guard.insert(query_key, (combined.clone(), std::time::Instant::now()));
        }
    }

    Ok(Json(combined))
}

fn extract_video_id(url: &str) -> Option<String> {
    if let Some(idx) = url.find("v=") {
        let rest = &url[idx + 2..];
        let end = rest.find(['&', '?', '#', '/']).unwrap_or(rest.len());
        let id = &rest[..end];
        if !id.is_empty() && id.len() <= 20 {
            return Some(id.to_string());
        }
    }
    if let Some(idx) = url.find("youtu.be/") {
        let rest = &url[idx + 9..];
        let end = rest.find(['&', '?', '#', '/']).unwrap_or(rest.len());
        let id = &rest[..end];
        if !id.is_empty() && id.len() <= 20 {
            return Some(id.to_string());
        }
    }
    None
}

pub async fn extract_info(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(params): Query<ExtractParams>,
) -> Result<Json<ExtractResponse>, StatusCode> {
    let client_ip = get_client_ip(&headers, Some(addr));
    check_rate_limit(
        &state.endpoint_rate_limits,
        &format!("extract:{}", client_ip),
        25,
        60,
    )?;

    let url = params.url.trim();
    if url.is_empty() || url.starts_with('-') {
        return Err(StatusCode::BAD_REQUEST);
    }

    if url.starts_with("http://") || url.starts_with("https://") {
        let is_trusted = url.contains("youtube.com")
            || url.contains("youtu.be")
            || url.contains("soundcloud.com");
        if !is_trusted {
            check_url_ssrf(url).await?;
        }
    }

    let _permit = match tokio::time::timeout(
        Duration::from_millis(2000),
        state.heavy_process_semaphore.acquire(),
    )
    .await
    {
        Ok(Ok(permit)) => permit,
        _ => return Err(StatusCode::TOO_MANY_REQUESTS),
    };

    let yt_cmd = get_yt_dlp_cmd();
    let base_url = get_base_url();
    let is_radio_mix = url.contains("list=RD") || url.contains("list=UL");
    let video_id_opt = extract_video_id(url);

    let mut main_video: Option<SearchTrack> = None;
    let mut chapter_tracks: Vec<SearchTrack> = Vec::new();
    let mut has_chapters = false;

    if let Some(ref vid) = video_id_opt {
        let single_url = format!("https://www.youtube.com/watch?v={}", vid);
        let mut single_cmd = Command::new(&yt_cmd);
        apply_yt_dlp_common_args(&mut single_cmd);
        single_cmd.args([
            &single_url,
            "--dump-json",
            "--no-playlist",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::null());

        if let Ok(Ok(out)) = tokio::time::timeout(Duration::from_secs(10), single_cmd.output()).await {
            if out.status.success() {
                if let Ok(item) = serde_json::from_slice::<serde_json::Value>(&out.stdout) {
                    main_video = parse_track_json(&item, &base_url);

                    if let Some(chapters) = item["chapters"].as_array() {
                        if !chapters.is_empty() {
                            for (i, ch) in chapters.iter().enumerate() {
                                let ch_title = ch["title"].as_str().unwrap_or("Без названия").trim();
                                let start_time = ch["start_time"].as_f64().unwrap_or(0.0);
                                let end_time = ch["end_time"].as_f64().unwrap_or(start_time);
                                let ch_duration = if end_time > start_time { end_time - start_time } else { 0.0 };

                                let ch_id = format!("{}_ch_{}", vid, i + 1);
                                let ch_artist = main_video.as_ref().map(|m| m.artist.clone()).unwrap_or_else(|| "Разные исполнители".to_string());
                                let ch_audio_url = format!("{}/api/stream?url={}&ss={}&title={}&artist={}", base_url, urlencoding::encode(&single_url), start_time as u64, urlencoding::encode(ch_title), urlencoding::encode(&ch_artist));
                                let ch_cover = main_video.as_ref().and_then(|m| m.cover_url.clone());

                                chapter_tracks.push(SearchTrack {
                                    id: ch_id,
                                    title: ch_title.to_string(),
                                    artist: ch_artist,
                                    duration: ch_duration,
                                    audio_url: ch_audio_url,
                                    cover_url: ch_cover,
                                });
                            }
                            if !chapter_tracks.is_empty() {
                                has_chapters = true;
                            }
                        }
                    }
                }
            }
        }
    }

    if has_chapters && !chapter_tracks.is_empty() {
        let playlist_title = main_video.as_ref().map(|m| m.title.clone());
        return Ok(Json(ExtractResponse {
            playlist_title,
            tracks: chapter_tracks,
            main_video,
            is_radio_mix,
            has_chapters: true,
        }));
    }

    let mut tracks = Vec::new();
    let mut playlist_title = None;

    let mut cmd = Command::new(&yt_cmd);
    apply_yt_dlp_common_args(&mut cmd);
    cmd.args([
        "--dump-json",
        "--flat-playlist",
        "--playlist-end",
        "100",
        "--",
        url,
    ])
    .stdout(Stdio::piped())
    .stderr(Stdio::null());

    if let Ok(mut child) = cmd.spawn() {
        if let Some(stdout) = child.stdout.take() {
            let mut reader = tokio::io::BufReader::new(stdout).lines();
            let read_task = async {
                while let Ok(Some(line)) = reader.next_line().await {
                    if let Ok(item) = serde_json::from_str::<serde_json::Value>(&line) {
                        if playlist_title.is_none() {
                            if let Some(title) = item["playlist_title"].as_str() {
                                playlist_title = Some(title.to_string());
                            } else if let Some(title) = item["playlist"].as_str() {
                                playlist_title = Some(title.to_string());
                            }
                        }

                        if let Some(track) = parse_track_json(&item, &base_url) {
                            tracks.push(track);
                        }
                    }
                }
            };
            let _ = tokio::time::timeout(Duration::from_secs(25), read_task).await;
            let _ = child.kill().await;
        }
    }

    if tracks.is_empty() {
        if let Some(ref mv) = main_video {
            tracks.push(mv.clone());
        }
    }

    if tracks.is_empty() && !is_cloud_env() {
        let cloud_url = format!("{}/api/extract?url={}", CLOUD_FALLBACK_URL, urlencoding::encode(url));
        if let Ok(client) = reqwest::Client::builder().timeout(Duration::from_secs(15)).build() {
            if let Ok(resp) = client.get(&cloud_url).send().await {
                if resp.status().is_success() {
                    if let Ok(bytes) = resp.bytes().await {
                        if let Ok(mut ext_resp) = serde_json::from_slice::<ExtractResponse>(&bytes) {
                            for t in &mut ext_resp.tracks {
                                if t.audio_url.contains("/api/stream") {
                                    let stream_idx = t.audio_url.find("/api/stream").unwrap();
                                    t.audio_url = format!("{}{}", base_url, &t.audio_url[stream_idx..]);
                                }
                            }
                            if let Some(ref mut mv) = ext_resp.main_video {
                                if mv.audio_url.contains("/api/stream") {
                                    let stream_idx = mv.audio_url.find("/api/stream").unwrap();
                                    mv.audio_url = format!("{}{}", base_url, &mv.audio_url[stream_idx..]);
                                }
                            }
                            return Ok(Json(ext_resp));
                        }
                    }
                }
            }
        }
    }

    if tracks.is_empty() && main_video.is_none() {
        if let Some(ref vid) = video_id_opt {
            let oembed_url = format!(
                "https://www.youtube.com/oembed?url={}&format=json",
                urlencoding::encode(&format!("https://www.youtube.com/watch?v={}", vid))
            );
            if let Ok(client) = reqwest::Client::builder().timeout(Duration::from_secs(5)).build() {
                if let Ok(resp) = client.get(&oembed_url).send().await {
                    if resp.status().is_success() {
                        if let Ok(bytes) = resp.bytes().await {
                            if let Ok(oembed) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                                let raw_title = oembed["title"].as_str().unwrap_or("YouTube Track");
                                let raw_author = oembed["author_name"].as_str().unwrap_or("YouTube Artist");
                                let clean_artist = raw_author.replace(" - Topic", "");
                                let cover = oembed["thumbnail_url"].as_str().map(|u| {
                                    format!("{}/api/cover?url={}", base_url, urlencoding::encode(u))
                                });
                                let full_url = format!("https://www.youtube.com/watch?v={}", vid);
                                let audio_url = format!(
                                    "{}/api/stream?url={}&title={}&artist={}",
                                    base_url,
                                    urlencoding::encode(&full_url),
                                    urlencoding::encode(raw_title),
                                    urlencoding::encode(&clean_artist)
                                );
                                let fallback_track = SearchTrack {
                                    id: vid.clone(),
                                    title: raw_title.to_string(),
                                    artist: clean_artist,
                                    duration: 0.0,
                                    audio_url,
                                    cover_url: cover,
                                };
                                main_video = Some(fallback_track.clone());
                                tracks.push(fallback_track);
                            }
                        }
                    }
                }
            }
        }
    }

    if main_video.is_none() && !tracks.is_empty() {
        if let Some(ref vid) = video_id_opt {
            if let Some(found) = tracks.iter().find(|t| t.id == *vid) {
                main_video = Some(found.clone());
            }
        }
        if main_video.is_none() && !url.contains("list=") {
            main_video = tracks.first().cloned();
        }
    }

    Ok(Json(ExtractResponse {
        playlist_title,
        tracks,
        main_video,
        is_radio_mix,
        has_chapters,
    }))
}

#[allow(dead_code)]
pub async fn execute_audius_search(query: &str, limit: usize, base_url: &str) -> Vec<SearchTrack> {
    let url = format!(
        "https://discoveryprovider.audius.co/v1/tracks/search?query={}&app_name=RECRO_MUSIC&limit={}",
        urlencoding::encode(query),
        limit
    );
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_millis(2200))
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36")
        .build()
    {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };

    let resp = match client.get(&url).send().await {
        Ok(r) if r.status().is_success() => r,
        _ => return Vec::new(),
    };

    let data: serde_json::Value = match resp.json().await {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };

    let mut tracks = Vec::new();
    if let Some(items) = data["data"].as_array() {
        for item in items {
            let id = match item["id"].as_str() {
                Some(s) if !s.is_empty() => s.to_string(),
                _ => continue,
            };
            let title = item["title"].as_str().unwrap_or("Untitled").trim().to_string();
            let artist = item["user"]["name"].as_str()
                .or_else(|| item["user"]["handle"].as_str())
                .unwrap_or("Audius Artist").trim().to_string();
            let duration = item["duration"].as_f64().unwrap_or(0.0);

            if duration > 600.0 || (duration > 0.0 && duration < 30.0) {
                continue;
            }

            let cover_url = item["artwork"]["480x480"].as_str()
                .or_else(|| item["artwork"]["150x150"].as_str())
                .map(|u| u.to_string());

            let direct_stream_url = format!("https://discoveryprovider.audius.co/v1/tracks/{}/stream?app_name=RECRO_MUSIC", id);
            let encoded_url = urlencoding::encode(&direct_stream_url);
            let encoded_title = urlencoding::encode(&title);
            let encoded_artist = urlencoding::encode(&artist);
            let audio_url = format!("{}/api/stream?url={}&title={}&artist={}", base_url, encoded_url, encoded_title, encoded_artist);

            tracks.push(SearchTrack {
                id: format!("audius-{}", id),
                title,
                artist,
                duration,
                audio_url,
                cover_url,
            });
        }
    }
    tracks
}

pub async fn execute_deezer_search(query: &str, limit: usize, base_url: &str) -> Vec<SearchTrack> {
    let url = format!(
        "https://api.deezer.com/search?q={}&limit={}",
        urlencoding::encode(query),
        limit
    );
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_millis(3000))
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36")
        .build()
    {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };

    let resp = match client.get(&url).send().await {
        Ok(r) if r.status().is_success() => r,
        _ => return Vec::new(),
    };

    let data: serde_json::Value = match resp.json().await {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };

    let mut tracks = Vec::new();
    if let Some(items) = data["data"].as_array() {
        for item in items {
            let id_num = match item["id"].as_i64() {
                Some(n) => n,
                None => continue,
            };
            let id = format!("dz-{}", id_num);
            let raw_title = item["title_short"].as_str()
                .or_else(|| item["title"].as_str())
                .unwrap_or("Без названия")
                .trim();
            let raw_artist = item["artist"]["name"].as_str()
                .unwrap_or("Неизвестный исполнитель")
                .trim();
            let duration = item["duration"].as_f64().unwrap_or(0.0);

            if duration > 720.0 || (duration > 0.0 && duration < 30.0) {
                continue;
            }

            let cover_url = item["album"]["cover_xl"].as_str()
                .or_else(|| item["album"]["cover_big"].as_str())
                .or_else(|| item["album"]["cover_medium"].as_str())
                .map(|u| u.to_string());

            let encoded_title = urlencoding::encode(raw_title);
            let encoded_artist = urlencoding::encode(raw_artist);
            let audio_url = format!(
                "{}/api/stream?title={}&artist={}&duration={}&id={}",
                base_url, encoded_title, encoded_artist, duration as u64, id
            );

            tracks.push(SearchTrack {
                id,
                title: raw_title.to_string(),
                artist: raw_artist.to_string(),
                duration,
                audio_url,
                cover_url,
            });
        }
    }

    tracks
}

pub async fn execute_deezer_related(artist_name: &str, limit: usize, base_url: &str) -> Vec<SearchTrack> {
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_millis(3000))
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36")
        .build()
    {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };

    // 1. Find artist id on Deezer
    let search_url = format!(
        "https://api.deezer.com/search/artist?q={}&limit=1",
        urlencoding::encode(artist_name)
    );
    let artist_id = match client.get(&search_url).send().await {
        Ok(r) if r.status().is_success() => {
            if let Ok(data) = r.json::<serde_json::Value>().await {
                data["data"].as_array().and_then(|arr| arr.first()).and_then(|a| a["id"].as_i64())
            } else {
                None
            }
        }
        _ => None,
    };

    let artist_id = match artist_id {
        Some(id) => id,
        None => return Vec::new(),
    };

    // 2. Fetch related artists (request wider pool for deep variety)
    let rel_url = format!("https://api.deezer.com/artist/{}/related?limit=12", artist_id);
    let mut rel_artists = match client.get(&rel_url).send().await {
        Ok(r) if r.status().is_success() => {
            if let Ok(data) = r.json::<serde_json::Value>().await {
                data["data"]
                    .as_array()
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|a| a["id"].as_i64())
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default()
            } else {
                Vec::new()
            }
        }
        _ => Vec::new(),
    };

    if rel_artists.is_empty() {
        return Vec::new();
    }

    // Shuffle related artists so recommendations don't fixate on the same top-3 artists
    fastrand::shuffle(&mut rel_artists);

    // 3. Concurrently fetch top tracks from diverse related artists
    let mut set = tokio::task::JoinSet::new();
    for rel_id in rel_artists.into_iter().take(7) {
        let cl = client.clone();
        set.spawn(async move {
            let top_url = format!("https://api.deezer.com/artist/{}/top?limit=4", rel_id);
            if let Ok(r) = cl.get(&top_url).send().await {
                if r.status().is_success() {
                    if let Ok(v) = r.json::<serde_json::Value>().await {
                        return v["data"].as_array().cloned().unwrap_or_default();
                    }
                }
            }
            Vec::new()
        });
    }

    let mut tracks = Vec::new();
    let max_pool = limit * 3;
    while let Some(res) = set.join_next().await {
        if let Ok(items) = res {
            for item in items {
                if tracks.len() >= max_pool {
                    break;
                }
                let id_num = match item["id"].as_i64() {
                    Some(n) => n,
                    None => continue,
                };
                let id = format!("dz-{}", id_num);
                let raw_title = item["title_short"]
                    .as_str()
                    .or_else(|| item["title"].as_str())
                    .unwrap_or("Без названия")
                    .trim();
                let raw_artist = item["artist"]["name"]
                    .as_str()
                    .unwrap_or("Неизвестный исполнитель")
                    .trim();
                let duration = item["duration"].as_f64().unwrap_or(0.0);

                if duration > 720.0 || (duration > 0.0 && duration < 30.0) {
                    continue;
                }

                let cover_url = item["album"]["cover_xl"]
                    .as_str()
                    .or_else(|| item["album"]["cover_big"].as_str())
                    .or_else(|| item["album"]["cover_medium"].as_str())
                    .map(|u| u.to_string());

                let encoded_title = urlencoding::encode(raw_title);
                let encoded_artist = urlencoding::encode(raw_artist);
                let audio_url = format!(
                    "{}/api/stream?title={}&artist={}&duration={}&id={}",
                    base_url, encoded_title, encoded_artist, duration as u64, id
                );

                tracks.push(SearchTrack {
                    id,
                    title: raw_title.to_string(),
                    artist: raw_artist.to_string(),
                    duration,
                    audio_url,
                    cover_url,
                });
            }
        }
    }

    // Shuffle gathered pool and select distinct results
    fastrand::shuffle(&mut tracks);
    tracks.truncate(limit);
    tracks
}

fn is_noisy_compilation(title: &str) -> bool {
    let lower = title.to_lowercase();
    lower.contains("playlist")
        || lower.contains("плейлист")
        || lower.contains("full album")
        || lower.contains("альбом целиком")
        || lower.contains("сборник")
        || lower.contains("1 hour")
        || lower.contains("10 hours")
        || lower.contains("hour mix")
        || lower.contains("compilation")
        || lower.contains("type beat")
}

#[derive(Debug, serde::Deserialize)]
pub struct RecommendParams {
    pub artist: Option<String>,
    pub genre: Option<String>,
    pub chart: Option<String>,
    pub limit: Option<usize>,
}

pub async fn get_recommendations(
    State(state): State<AppState>,
    Query(params): Query<RecommendParams>,
) -> Result<Json<Vec<SearchTrack>>, StatusCode> {
    let artist = params.artist.as_deref().unwrap_or("").trim();
    let genre = params.genre.as_deref().unwrap_or("").trim().to_lowercase();
    let chart = params.chart.as_deref().unwrap_or("").trim().to_lowercase();

    if artist.is_empty() && chart.is_empty() && genre.is_empty() {
        return Ok(Json(Vec::new()));
    }

    let limit = params.limit.unwrap_or(10).min(30);
    let base_url = get_base_url();
    let yt_cmd = get_yt_dlp_cmd();

    let cache_key = if !chart.is_empty() {
        format!("rec:chart:{}:{}", chart, genre)
    } else if !artist.is_empty() {
        format!("rec:art:{}:{}", artist.to_lowercase(), genre)
    } else {
        format!("rec:gen:{}", genre)
    };

    // 5-minute TTL cache with random sampling to avoid repetitive loops
    if let Ok(guard) = state.search_cache.lock() {
        if let Some((cached_tracks, cached_at)) = guard.get(&cache_key) {
            if cached_at.elapsed() < Duration::from_secs(300) && !cached_tracks.is_empty() {
                let mut out = cached_tracks.clone();
                if out.len() > limit {
                    fastrand::shuffle(&mut out);
                    out.truncate(limit);
                }
                return Ok(Json(out));
            }
        }
    }

    let mut tracks = Vec::new();
    let mut seen_ids = HashSet::new();

    // 1. Chart / trending query for SoundCloud with dynamic subgenre variety
    if !chart.is_empty() || (artist.is_empty() && !genre.is_empty()) {
        let genre_queries: &[&str] = if genre.contains("rap") || genre.contains("hip") || genre.contains("trap") || genre.contains("drill") {
            &["russian rap топ", "русский хип хоп тренды", "underground rap новинки", "хип хоп чарт soundcloud", "новинки рэпа"]
        } else if genre.contains("phonk") {
            &["drift phonk hits", "phonk remix", "brazilian phonk bass", "aggressive phonk", "memphis phonk hits"]
        } else if genre.contains("rock") || genre.contains("metal") || genre.contains("alternative") {
            &["русский рок хиты", "альтернативный рок новинки", "indie rock hits", "русский панк рок", "post punk russian"]
        } else if genre.contains("pop") {
            &["популярные русские песни топ", "хиты 2024 новинки", "pop music charting hits", "русский поп чарт", "новинки музыки радио"]
        } else {
            &["топ треки soundcloud чарт", "популярная музыка тренды", "trending songs hits", "топ музыка новинки"]
        };
        let sc_query = genre_queries[fastrand::usize(..genre_queries.len())];

        let fetch_limit = (limit * 2).clamp(20, 30);
        let sc_arg = format!("scsearch{}:{}", fetch_limit, sc_query);
        let sc_res = execute_yt_dlp_search(&yt_cmd, &sc_arg, 8, &base_url).await;
        for t in sc_res {
            if (t.duration == 0.0 || (t.duration >= 45.0 && t.duration <= 600.0))
                && !is_noisy_compilation(&t.title)
                && seen_ids.insert(t.id.clone())
            {
                tracks.push(t);
            }
        }
        fastrand::shuffle(&mut tracks);
    } else if !artist.is_empty() {
        // 2. Artist-based recommendations:
        // Try Deezer related artists first
        let dz_related = execute_deezer_related(artist, limit, &base_url).await;
        for t in dz_related {
            if seen_ids.insert(t.id.clone()) {
                tracks.push(t);
            }
        }

        // If Deezer related gave few tracks (< 4), complement with SoundCloud artist hits / trending
        if tracks.len() < limit {
            let sc_arg = format!("scsearch{}:{} топ", (limit - tracks.len()).max(6), artist);
            let sc_res = execute_yt_dlp_search(&yt_cmd, &sc_arg, 8, &base_url).await;
            for t in sc_res {
                if (t.duration == 0.0 || (t.duration >= 45.0 && t.duration <= 600.0))
                    && !is_noisy_compilation(&t.title)
                    && seen_ids.insert(t.id.clone())
                {
                    tracks.push(t);
                    if tracks.len() >= limit {
                        break;
                    }
                }
            }
        }

        // If still fewer than 3, search Deezer for artist directly
        if tracks.len() < 3 {
            let dz_direct = execute_deezer_search(artist, limit, &base_url).await;
            for t in dz_direct {
                if seen_ids.insert(t.id.clone()) {
                    tracks.push(t);
                    if tracks.len() >= limit {
                        break;
                    }
                }
            }
        }
    }

    if !tracks.is_empty() {
        if let Ok(mut guard) = state.search_cache.lock() {
            guard.insert(cache_key, (tracks.clone(), std::time::Instant::now()));
        }
    }

    tracks.truncate(limit);
    Ok(Json(tracks))
}
