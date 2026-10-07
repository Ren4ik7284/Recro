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

    let (dz_res, sc_res) = tokio::join!(
        execute_deezer_search(query, 12, &base_url),
        state.soundcloud.search_tracks(query, 15, &base_url),
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
    pub track_id: Option<String>,
    pub artist: Option<String>,
    pub genre: Option<String>,
    pub chart: Option<String>,
    pub limit: Option<usize>,
}

pub async fn get_recommendations(
    State(state): State<AppState>,
    Query(params): Query<RecommendParams>,
) -> Result<Json<Vec<SearchTrack>>, StatusCode> {
    let track_id = params.track_id.as_deref().unwrap_or("").trim();
    let artist = params.artist.as_deref().unwrap_or("").trim();
    let genre = params.genre.as_deref().unwrap_or("").trim().to_lowercase();
    let chart = params.chart.as_deref().unwrap_or("").trim().to_lowercase();

    if track_id.is_empty() && artist.is_empty() && chart.is_empty() && genre.is_empty() {
        return Ok(Json(Vec::new()));
    }

    let limit = params.limit.unwrap_or(10).min(30);
    let base_url = get_base_url();

    let cache_key = if !track_id.is_empty() {
        format!("rec:tid:{}", track_id)
    } else if !chart.is_empty() {
        format!("rec:chart:{}:{}", chart, genre)
    } else if !artist.is_empty() {
        format!("rec:art:{}:{}", artist.to_lowercase(), genre)
    } else {
        format!("rec:gen:{}", genre)
    };

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

    if !track_id.is_empty() {
        let rel_tracks = state.soundcloud.get_related_tracks(track_id, limit * 2, &base_url).await;
        for t in rel_tracks {
            if (t.duration == 0.0 || (t.duration >= 45.0 && t.duration <= 600.0))
                && !is_noisy_compilation(&t.title)
                && seen_ids.insert(t.id.clone())
            {
                tracks.push(t);
            }
        }
    }

    if tracks.is_empty() && (!chart.is_empty() || (artist.is_empty() && !genre.is_empty())) {
        let genre_queries: &[&str] = if genre.contains("rap") || genre.contains("hip") || genre.contains("trap") || genre.contains("drill") {
            &["russian rap", "русский хип хоп", "underground rap", "hip hop", "trap"]
        } else if genre.contains("phonk") {
            &["drift phonk", "phonk remix", "brazilian phonk", "memphis phonk"]
        } else if genre.contains("rock") || genre.contains("metal") || genre.contains("alternative") {
            &["русский рок", "альтернативный рок", "indie rock", "post punk"]
        } else if genre.contains("pop") {
            &["популярная музыка", "русский поп", "pop hits", "хиты"]
        } else {
            &["trending", "топ треки", "hits", "новинки"]
        };
        let sc_query = genre_queries[fastrand::usize(..genre_queries.len())];

        let sc_res = state.soundcloud.search_tracks(sc_query, limit * 2, &base_url).await;
        for t in sc_res {
            if (t.duration == 0.0 || (t.duration >= 45.0 && t.duration <= 600.0))
                && !is_noisy_compilation(&t.title)
                && seen_ids.insert(t.id.clone())
            {
                tracks.push(t);
            }
        }
        fastrand::shuffle(&mut tracks);
    } else if tracks.is_empty() && !artist.is_empty() {
        let sc_artist_res = state.soundcloud.search_tracks(artist, limit * 2, &base_url).await;
        let mut first_id = None;
        for t in sc_artist_res {
            if first_id.is_none() {
                first_id = Some(t.id.clone());
            }
            if (t.duration == 0.0 || (t.duration >= 45.0 && t.duration <= 600.0))
                && !is_noisy_compilation(&t.title)
                && seen_ids.insert(t.id.clone())
            {
                tracks.push(t);
                if tracks.len() >= 3 {
                    break;
                }
            }
        }

        if let Some(fid) = first_id {
            let rel = state.soundcloud.get_related_tracks(&fid, limit * 2, &base_url).await;
            for t in rel {
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
    }

    if !tracks.is_empty() {
        if let Ok(mut guard) = state.search_cache.lock() {
            guard.insert(cache_key, (tracks.clone(), std::time::Instant::now()));
        }
    }

    tracks.truncate(limit);
    Ok(Json(tracks))
}

#[derive(Debug, serde::Deserialize)]
pub struct SimilarTracksParams {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub limit: Option<usize>,
}

/// Collaborative-filtering-style recommendations using Last.fm Similar Tracks + Deezer Radio.
/// This is the key upgrade that gives Spotify-quality "people who listen to X also listen to Y".
pub async fn get_similar_tracks(
    State(state): State<AppState>,
    Query(params): Query<SimilarTracksParams>,
) -> Result<Json<Vec<SearchTrack>>, StatusCode> {
    let title = params.title.as_deref().unwrap_or("").trim();
    let artist = params.artist.as_deref().unwrap_or("").trim();

    if title.is_empty() && artist.is_empty() {
        return Ok(Json(Vec::new()));
    }

    let limit = params.limit.unwrap_or(10).min(30);
    let base_url = get_base_url();

    let cache_key = format!("similar:{}:{}", artist.to_lowercase(), title.to_lowercase());

    // 10-minute TTL cache with random sampling for variety
    if let Ok(guard) = state.search_cache.lock() {
        if let Some((cached_tracks, cached_at)) = guard.get(&cache_key) {
            if cached_at.elapsed() < Duration::from_secs(600) && !cached_tracks.is_empty() {
                let mut out = cached_tracks.clone();
                if out.len() > limit {
                    fastrand::shuffle(&mut out);
                    out.truncate(limit);
                }
                return Ok(Json(out));
            }
        }
    }

    let lastfm_api_key = std::env::var("LASTFM_API_KEY")
        .unwrap_or_else(|_| "1913322afac44ffa30bbec00e1e4c0f2".to_string());

    let client = match reqwest::Client::builder()
        .timeout(Duration::from_millis(4000))
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
        .build()
    {
        Ok(c) => c,
        Err(_) => return Ok(Json(Vec::new())),
    };

    let mut tracks: Vec<SearchTrack> = Vec::new();
    let mut seen_ids = HashSet::new();
    let mut seen_artists = HashSet::new();

    // === SOURCE 1: Last.fm track.getSimilar (collaborative filtering from billions of scrobbles) ===
    if !title.is_empty() && !artist.is_empty() {
        let lfm_url = format!(
            "https://ws.audioscrobbler.com/2.0/?method=track.getSimilar&artist={}&track={}&api_key={}&format=json&limit=20",
            urlencoding::encode(artist),
            urlencoding::encode(title),
            lastfm_api_key
        );

        if let Ok(resp) = client.get(&lfm_url).send().await {
            if resp.status().is_success() {
                if let Ok(data) = resp.json::<serde_json::Value>().await {
                    if let Some(similar_tracks) = data["similartracks"]["track"].as_array() {
                        for item in similar_tracks {
                            let t_name = item["name"].as_str().unwrap_or("").trim();
                            let t_artist = item["artist"]["name"].as_str().unwrap_or("").trim();
                            if t_name.is_empty() || t_artist.is_empty() { continue; }
                            if is_noisy_compilation(t_name) { continue; }

                            let norm_art = t_artist.to_lowercase();
                            if seen_artists.contains(&norm_art) { continue; }

                            let encoded_title = urlencoding::encode(t_name);
                            let encoded_artist = urlencoding::encode(t_artist);
                            let id = format!("lfm-{}-{}", encoded_artist, encoded_title);

                            if !seen_ids.insert(id.clone()) { continue; }

                            let audio_url = format!(
                                "{}/api/stream?title={}&artist={}",
                                base_url, encoded_title, encoded_artist
                            );

                            // Try to get cover from Last.fm image array
                            let cover_url = item["image"].as_array()
                                .and_then(|imgs| {
                                    imgs.iter().rev().find_map(|img| {
                                        let url = img["#text"].as_str().unwrap_or("");
                                        if !url.is_empty() && !url.contains("2a96cbd8b46e442fc41c2b86b821562f") {
                                            Some(url.to_string())
                                        } else {
                                            None
                                        }
                                    })
                                });

                            tracks.push(SearchTrack {
                                id,
                                title: t_name.to_string(),
                                artist: t_artist.to_string(),
                                duration: 0.0, // Last.fm doesn't give duration; backend /api/stream resolves it
                                audio_url,
                                cover_url,
                            });
                            seen_artists.insert(norm_art);
                        }
                    }
                }
            }
        }
    }

    // === SOURCE 2: Last.fm artist.getSimilar (if track-level gave < 5 results) ===
    if tracks.len() < 5 && !artist.is_empty() {
        let lfm_artist_url = format!(
            "https://ws.audioscrobbler.com/2.0/?method=artist.getSimilar&artist={}&api_key={}&format=json&limit=10",
            urlencoding::encode(artist),
            lastfm_api_key
        );

        if let Ok(resp) = client.get(&lfm_artist_url).send().await {
            if resp.status().is_success() {
                if let Ok(data) = resp.json::<serde_json::Value>().await {
                    if let Some(similar_artists) = data["similarartists"]["artist"].as_array() {
                        let cl = client.clone();
                        let mut artist_tasks = tokio::task::JoinSet::new();

                        for sa in similar_artists.iter().take(6) {
                            let sa_name = match sa["name"].as_str() {
                                Some(n) if !n.is_empty() => n.to_string(),
                                _ => continue,
                            };
                            let norm = sa_name.to_lowercase();
                            if seen_artists.contains(&norm) { continue; }

                            let c = cl.clone();
                            let bu = base_url.clone();
                            artist_tasks.spawn(async move {
                                // Get top 2 tracks from Deezer for this similar artist
                                let dz_url = format!(
                                    "https://api.deezer.com/search?q=artist:\"{}\"&limit=2",
                                    urlencoding::encode(&sa_name)
                                );
                                let mut result = Vec::new();
                                if let Ok(r) = c.get(&dz_url).send().await {
                                    if r.status().is_success() {
                                        if let Ok(d) = r.json::<serde_json::Value>().await {
                                            if let Some(items) = d["data"].as_array() {
                                                for item in items {
                                                    let id_num = match item["id"].as_i64() {
                                                        Some(n) => n,
                                                        None => continue,
                                                    };
                                                    let raw_title = item["title_short"].as_str()
                                                        .or_else(|| item["title"].as_str())
                                                        .unwrap_or("").trim();
                                                    let raw_artist = item["artist"]["name"].as_str()
                                                        .unwrap_or("").trim();
                                                    let duration = item["duration"].as_f64().unwrap_or(0.0);
                                                    if raw_title.is_empty() || raw_artist.is_empty() { continue; }
                                                    if duration > 600.0 || (duration > 0.0 && duration < 30.0) { continue; }

                                                    let cover_url = item["album"]["cover_xl"].as_str()
                                                        .or_else(|| item["album"]["cover_big"].as_str())
                                                        .map(|u| u.to_string());

                                                    let id = format!("dz-{}", id_num);
                                                    let encoded_title = urlencoding::encode(raw_title);
                                                    let encoded_artist = urlencoding::encode(raw_artist);
                                                    let audio_url = format!(
                                                        "{}/api/stream?title={}&artist={}&duration={}&id={}",
                                                        bu, encoded_title, encoded_artist, duration as u64, id
                                                    );
                                                    result.push(SearchTrack {
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
                                    }
                                }
                                result
                            });
                        }

                        while let Some(res) = artist_tasks.join_next().await {
                            if let Ok(items) = res {
                                for t in items {
                                    let norm_art = t.artist.to_lowercase();
                                    if seen_artists.contains(&norm_art) { continue; }
                                    if !seen_ids.insert(t.id.clone()) { continue; }
                                    seen_artists.insert(norm_art);
                                    tracks.push(t);
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // === SOURCE 3: Deezer Artist Radio (fill remaining slots) ===
    if tracks.len() < limit && !artist.is_empty() {
        let search_url = format!(
            "https://api.deezer.com/search/artist?q={}&limit=1",
            urlencoding::encode(artist)
        );
        if let Ok(r) = client.get(&search_url).send().await {
            if r.status().is_success() {
                if let Ok(data) = r.json::<serde_json::Value>().await {
                    if let Some(artist_id) = data["data"].as_array()
                        .and_then(|arr| arr.first())
                        .and_then(|a| a["id"].as_i64())
                    {
                        let radio_url = format!(
                            "https://api.deezer.com/artist/{}/radio?limit={}",
                            artist_id, (limit * 2).min(40)
                        );
                        if let Ok(r2) = client.get(&radio_url).send().await {
                            if r2.status().is_success() {
                                if let Ok(radio_data) = r2.json::<serde_json::Value>().await {
                                    if let Some(items) = radio_data["data"].as_array() {
                                        for item in items {
                                            let id_num = match item["id"].as_i64() {
                                                Some(n) => n,
                                                None => continue,
                                            };
                                            let raw_title = item["title_short"].as_str()
                                                .or_else(|| item["title"].as_str())
                                                .unwrap_or("").trim();
                                            let raw_artist = item["artist"]["name"].as_str()
                                                .unwrap_or("").trim();
                                            let duration = item["duration"].as_f64().unwrap_or(0.0);
                                            if raw_title.is_empty() || raw_artist.is_empty() { continue; }
                                            if duration > 600.0 || (duration > 0.0 && duration < 30.0) { continue; }

                                            let norm_art = raw_artist.to_lowercase();
                                            if seen_artists.contains(&norm_art) { continue; }

                                            let id = format!("dz-{}", id_num);
                                            if !seen_ids.insert(id.clone()) { continue; }

                                            let cover_url = item["album"]["cover_xl"].as_str()
                                                .or_else(|| item["album"]["cover_big"].as_str())
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
                                            seen_artists.insert(norm_art);
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

    // Cache all collected tracks
    if !tracks.is_empty() {
        if let Ok(mut guard) = state.search_cache.lock() {
            guard.insert(cache_key, (tracks.clone(), std::time::Instant::now()));
        }
    }

    fastrand::shuffle(&mut tracks);
    tracks.truncate(limit);
    Ok(Json(tracks))
}
