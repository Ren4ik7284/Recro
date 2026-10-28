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
use crate::models::{ChartArtist, ExtractParams, ExtractResponse, SearchParams, SearchTrack};
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
        120,
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
        if tracks.is_empty() && !is_cloud_env() && !CLOUD_FALLBACK_URL.is_empty() {
            let cloud_tracks = execute_cloud_search(query, &base_url).await;
            if !cloud_tracks.is_empty() {
                tracks = cloud_tracks;
            }
        }
        if !tracks.is_empty() {
            insert_search_cache(&state, query_key, tracks.clone());
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

    if combined.is_empty() && !is_cloud_env() && !CLOUD_FALLBACK_URL.is_empty() {
        let cloud_tracks = execute_cloud_search(query, &base_url).await;
        for t in cloud_tracks {
            if seen_ids.insert(t.id.clone()) {
                combined.push(t);
            }
        }
    }

    if !combined.is_empty() {
        insert_search_cache(&state, query_key, combined.clone());
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
        60,
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
                                    plays: None,
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

    if tracks.is_empty() && !is_cloud_env() && !CLOUD_FALLBACK_URL.is_empty() {
        let cloud_url = format!("{}/api/extract?url={}", CLOUD_FALLBACK_URL, urlencoding::encode(url));
        if let Ok(client) = reqwest::Client::builder().timeout(Duration::from_secs(15)).build() {
            if let Ok(resp) = client.get(&cloud_url).send().await {
                if resp.status().is_success() {
                    if let Ok(bytes) = resp.bytes().await {
                        if let Ok(mut ext_resp) = serde_json::from_slice::<ExtractResponse>(&bytes) {
                            for t in &mut ext_resp.tracks {
                                if let Some(stream_idx) = t.audio_url.find("/api/stream") {
                                    t.audio_url = format!("{}{}", base_url, &t.audio_url[stream_idx..]);
                                }
                            }
                            if let Some(ref mut mv) = ext_resp.main_video {
                                if let Some(stream_idx) = mv.audio_url.find("/api/stream") {
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
                                    plays: None,
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
                plays: None,
            });
        }
    }
    tracks
}

static DEEZER_CLIENT: std::sync::LazyLock<reqwest::Client> = std::sync::LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(Duration::from_millis(3500))
        .pool_idle_timeout(Duration::from_secs(90))
        .pool_max_idle_per_host(20)
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36")
        .build()
        .unwrap_or_default()
});

fn insert_search_cache(
    state: &crate::AppState,
    key: String,
    tracks: Vec<SearchTrack>,
) {
    if let Ok(mut guard) = state.search_cache.lock() {
        if guard.len() > 1000 {
            let now = std::time::Instant::now();
            guard.retain(|_, (_, cached_at)| now.duration_since(*cached_at) < Duration::from_secs(7200));
            if guard.len() > 1500 {
                guard.clear();
            }
        }
        guard.insert(key, (tracks, std::time::Instant::now()));
    }
}

pub async fn execute_deezer_search(query: &str, limit: usize, base_url: &str) -> Vec<SearchTrack> {
    let url = format!(
        "https://api.deezer.com/search?q={}&limit={}",
        urlencoding::encode(query),
        limit
    );

    let resp = match DEEZER_CLIENT.get(&url).send().await {
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
                plays: item["rank"].as_i64(),
            });
        }
    }

    tracks
}

#[allow(dead_code)]
pub async fn fetch_lastfm_related_artists(artist_name: &str, api_key: &str) -> Vec<String> {
    let clean = artist_name
        .split("feat")
        .next()
        .unwrap_or(artist_name)
        .split("ft.")
        .next()
        .unwrap_or(artist_name)
        .split('&')
        .next()
        .unwrap_or(artist_name)
        .trim();

    if clean.is_empty() {
        return Vec::new();
    }

    let client = match reqwest::Client::builder()
        .timeout(Duration::from_millis(3000))
        .user_agent("Mozilla/5.0")
        .build()
    {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };

    let url = format!(
        "https://ws.audioscrobbler.com/2.0/?method=artist.getSimilar&artist={}&api_key={}&format=json&limit=15",
        urlencoding::encode(clean),
        api_key
    );

    match client.get(&url).send().await {
        Ok(r) if r.status().is_success() => {
            if let Ok(data) = r.json::<serde_json::Value>().await {
                if let Some(arr) = data["similarartists"]["artist"].as_array() {
                    return arr
                        .iter()
                        .filter_map(|a| a["name"].as_str().map(|s| s.to_string()))
                        .collect();
                }
            }
            Vec::new()
        }
        _ => Vec::new(),
    }
}

pub async fn fetch_deezer_related_artists(artist_name: &str) -> Vec<String> {
    let clean = artist_name
        .split("feat")
        .next()
        .unwrap_or(artist_name)
        .split("ft.")
        .next()
        .unwrap_or(artist_name)
        .split('&')
        .next()
        .unwrap_or(artist_name)
        .trim();

    if clean.is_empty() {
        return Vec::new();
    }

    let client = match reqwest::Client::builder()
        .timeout(Duration::from_millis(3000))
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")
        .build()
    {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };

    let canonical = resolve_canonical_artist_name(clean);
    let search_url = format!(
        "https://api.deezer.com/search/artist?q={}&limit=5",
        urlencoding::encode(canonical)
    );
    let artist_id = match client.get(&search_url).send().await {
        Ok(r) if r.status().is_success() => {
            if let Ok(data) = r.json::<serde_json::Value>().await {
                data["data"].as_array().and_then(|arr| {
                    arr.iter()
                        .find(|a| a["name"].as_str().map(|n| n.trim().eq_ignore_ascii_case(canonical)).unwrap_or(false))
                        .and_then(|a| a["id"].as_i64())
                        .or_else(|| arr.first().and_then(|a| a["id"].as_i64()))
                })
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

    let rel_url = format!("https://api.deezer.com/artist/{}/related?limit=15", artist_id);
    match client.get(&rel_url).send().await {
        Ok(r) if r.status().is_success() => {
            if let Ok(data) = r.json::<serde_json::Value>().await {
                data["data"]
                    .as_array()
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|a| a["name"].as_str().map(|s| s.to_string()))
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default()
            } else {
                Vec::new()
            }
        }
        _ => Vec::new(),
    }
}

pub fn resolve_canonical_artist_name(name: &str) -> &str {
    let lower = name.trim().to_lowercase();
    match lower.as_str() {
        "madkid" | "мадкид" | "мадкидд" => "madk1d",
        "капсайз" | "ккапсайз" => "cupsize",
        "жанулька" => "zhanulka",
        "унки" => "unki",
        "кай ангел" => "kai angel",
        "найн майс" | "9 майс" => "9mice",
        "вайпер" | "вайперр" => "viperr",
        "бушидо жо" | "бушидожо" => "bushido zho",
        "херонвотер" | "херон вотер" => "heronwater",
        "токсис" => "toxi$",
        "тейп" | "биг бейби тейп" | "биг бэби тэйп" => "big baby tape",
        "кизару" => "kizaru",
        "ог буда" => "og buda",
        "скалли милано" => "scally milano",
        "аглистефан" => "uglystephan",
        "платина" => "platina",
        "майот" => "mayot",
        "сода лав" => "soda luv",
        "серега пират" | "серёга пират" => "serega pirat",
        "виллиан" | "вильян" | "v!ll!an" => "villian",
        "фортуна 812" => "fortuna 812",
        "темный принц" | "тёмный принц" => "тёмный принц",
        "аквакей" => "aquakey",
        _ => name,
    }
}

pub fn is_russian_artist(name: &str) -> bool {
    let lower = name.trim().to_lowercase();
    if lower.chars().any(|c| ('\u{0400}'..='\u{04FF}').contains(&c)) {
        return true;
    }
    const KNOWN: &[&str] = &[
        "madkid", "madk1d", "cupsize", "zhanulka", "unki", "dakook", "13karat",
        "kai angel", "9mice", "viperr", "toxi$", "toxis", "shadowraze", "zxcursed",
        "hikikomori kai", "dvrst", "kizaru", "big baby tape", "og buda", "mayot",
        "soda luv", "163onmyneck", "scally milano", "uglystephan", "bushido zho",
        "heronwater", "alblak 52", "friendly thug", "friendly thug 52 ngg",
        "aarne", "lovv66", "seemee", "yungway", "pinq", "lil krystalll", "white punk",
        "yanix", "rocket", "t-fest", "kostromin", "saluki", "boulevard depo",
        "jeembo", "pharaoh", "scriptonite", "skryptonite", "loqiemean", "noize mc",
        "face", "gone fludd", "flesh", "lizer", "thrill pill", "platina", "macan",
        "markul", "obladaet", "oxxxymiron", "slava marlow", "instasamka", "sqwoz bab",
        "dead blonde", "gspd", "cmh", "dk", "mzlff", "tri dnya dozhdya", "dzhizus",
        "mukka", "playingtheangel", "zivert", "serega пират", "midix", "polmateri",
        "fallen777angel", "fortuna 812", "doxxxelll", "kristiee", "bond s knopkoy",
        "villian", "v!ll!an", "aquakey", "whole lotta swag", "4jaycard",
        "onda andar", "ivycraft", "kudokushi", "odasu", "sh0tty", "eryn martin",
        "mapt0v", "volhey", "автоспорт", "перемотка", "буерак", "дурной вкус",
        "увула", "ssshhhiiittt", "ssshhhiiittt!", "щенки", "свидетельство о смерти",
        "конец солнечных дней", "горемыка", "петля пристрастия", "дарья виардо",
        "электрофорез", "дайте танк", "дайте танк (!)", "пасош", "плохо", "союз",
    ];
    for &k in KNOWN {
        if lower == k || lower.starts_with(&format!("{} ", k)) || lower.ends_with(&format!(" {}", k)) || lower.contains(&format!(" {} ", k)) {
            return true;
        }
    }
    false
}

pub async fn fetch_deezer_artist_radio(artist_name: &str, limit: usize, base_url: &str) -> Vec<SearchTrack> {
    let clean = artist_name
        .split("feat")
        .next()
        .unwrap_or(artist_name)
        .split("ft.")
        .next()
        .unwrap_or(artist_name)
        .split('&')
        .next()
        .unwrap_or(artist_name)
        .trim();

    if clean.is_empty() {
        return Vec::new();
    }

    let client = match reqwest::Client::builder()
        .timeout(Duration::from_millis(3500))
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")
        .build()
    {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };

    let canonical = resolve_canonical_artist_name(clean);
    let search_url = format!(
        "https://api.deezer.com/search/artist?q={}&limit=5",
        urlencoding::encode(canonical)
    );
    let artist_id = match client.get(&search_url).send().await {
        Ok(r) if r.status().is_success() => {
            if let Ok(data) = r.json::<serde_json::Value>().await {
                if let Some(arr) = data["data"].as_array() {
                    // Exact name match first to avoid picking completely wrong artists with higher fan counts
                    arr.iter()
                        .find(|a| {
                            a["name"].as_str().map(|n| n.trim().eq_ignore_ascii_case(canonical)).unwrap_or(false)
                        })
                        .and_then(|a| a["id"].as_i64())
                        .or_else(|| {
                            arr.iter()
                                .find(|a| {
                                    a["name"].as_str().map(|n| {
                                        let ln = n.trim().to_lowercase();
                                        let lc = canonical.to_lowercase();
                                        ln.starts_with(&lc) || lc.starts_with(&ln)
                                    }).unwrap_or(false)
                                })
                                .and_then(|a| a["id"].as_i64())
                        })
                        .or_else(|| {
                            arr.iter()
                                .filter(|a| a["radio"].as_bool() == Some(true))
                                .max_by_key(|a| a["nb_fan"].as_i64().unwrap_or(0))
                                .and_then(|a| a["id"].as_i64())
                        })
                        .or_else(|| arr.first().and_then(|a| a["id"].as_i64()))
                } else {
                    None
                }
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

    let radio_url = format!(
        "https://api.deezer.com/artist/{}/radio?limit={}",
        artist_id,
        (limit * 2).max(25).min(50)
    );

    let mut tracks = Vec::new();
    if let Ok(r) = client.get(&radio_url).send().await {
        if r.status().is_success() {
            if let Ok(data) = r.json::<serde_json::Value>().await {
                if let Some(items) = data["data"].as_array() {
                    let is_russian = is_russian_artist(artist_name);
                    for item in items {
                        let id_num = match item["id"].as_i64() {
                            Some(n) => n,
                            None => continue,
                        };
                        let raw_title = item["title"]
                            .as_str()
                            .or_else(|| item["title_short"].as_str())
                            .unwrap_or("")
                            .trim();
                        let raw_artist = item["artist"]["name"].as_str().unwrap_or("").trim();
                        let duration = item["duration"].as_f64().unwrap_or(0.0);
                        if raw_title.is_empty() || raw_artist.is_empty() {
                            continue;
                        }
                        if duration > 600.0 || (duration > 0.0 && duration < 30.0) {
                            continue;
                        }
                        if is_noisy_compilation(raw_title) || is_junk_track(raw_title, raw_artist, is_russian) {
                            continue;
                        }

                        let cover_url = item["album"]["cover_xl"]
                            .as_str()
                            .or_else(|| item["album"]["cover_big"].as_str())
                            .map(|u| u.to_string());

                        let id = format!("dz-{}", id_num);
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
                            plays: item["rank"].as_i64(),
                        });
                    }
                }
            }
        }
    }

    tracks
}

pub fn is_junk_track(title: &str, artist: &str, query_is_russian: bool) -> bool {
    let lower_title = title.to_lowercase();
    let lower_artist = artist.to_lowercase();
    let combined = format!("{} {}", lower_title, lower_artist);

    let noise_words = [
        "type beat", "beat prod", "instrumental", "karaoke", "караоке",
        "минус", "minus", "slowed", "reverb", "8d audio", "bass boosted",
        "nightcore", "sped up", "speed up", "remake", "guitar cover",
        "кавер", "cover", "1 hour", "10 hours", "hour mix", "compilation",
        "сборник", "плейлист", "playlist", "full album", "альбом целиком",
        "snip", "snippet", "leak", "unreleased",
    ];
    for w in noise_words {
        if combined.contains(w) {
            return true;
        }
    }

    let regional_markers = [
        "punjabi", "hindi", "bollywood", "desi", "bhangra", "sidhu", "haryanvi", "tamil", "telugu",
    ];
    for m in regional_markers {
        if combined.contains(m) {
            return true;
        }
    }
    if combined.chars().any(|c| ('\u{0900}'..='\u{097F}').contains(&c)) {
        return true;
    }

    if query_is_russian {
        let ua_markers = ["українськ", "ukrainian", "зсу", "слава україні"];
        for m in ua_markers {
            if combined.contains(m) {
                return true;
            }
        }
        let ua_chars = ['і', 'ї', 'є', 'ґ', 'І', 'Ї', 'Є', 'Ґ'];
        if combined.chars().any(|c| ua_chars.contains(&c)) {
            return true;
        }

        let foreign_markers = [
            "deutschrap", "german rap", "der ", "die ", "das ", "und ", "nicht ",
            "macht rap", "berlin", "auf deutsch", "feiern", "french rap", "rap francais",
            "c'est", "pour toi", "reggaeton", "funk rj", "funk bh", "rap brasileiro",
            "para ti", "persian", "türkçe", "rap việt", "viet rap", "arabic", "rap marocain",
            "angelina jolie",
        ];
        for f in foreign_markers {
            if combined.contains(f) {
                return true;
            }
        }
    }

    false
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

    if !artist.is_empty() {
        let is_russian = is_russian_artist(artist);

        let dz_tracks = fetch_deezer_artist_radio(artist, limit * 2, &base_url).await;
        for t in dz_tracks {
            if seen_ids.insert(t.id.clone()) {
                tracks.push(t);
            }
        }

        // Discover features and collaborations for this artist
        let feat_query = format!("{} feat", artist);
        let dz_feats = execute_deezer_search(&feat_query, 6, &base_url).await;
        for t in dz_feats {
            if seen_ids.insert(t.id.clone()) {
                tracks.push(t);
            }
        }

        if tracks.len() < limit * 2 {
            let rel_names = fetch_deezer_related_artists(artist).await;
            for rel_name in rel_names.into_iter().take(3) {
                if tracks.len() >= limit * 2 {
                    break;
                }
                let rel_tracks = fetch_deezer_artist_radio(&rel_name, 5, &base_url).await;
                for t in rel_tracks {
                    if seen_ids.insert(t.id.clone()) {
                        tracks.push(t);
                    }
                    if tracks.len() >= limit * 2 {
                        break;
                    }
                }
            }
        }

        if tracks.len() < limit {
            let sc_res = state.soundcloud.search_tracks(artist, limit * 2, &base_url).await;
            let mut first_sc_id: Option<String> = None;
            for t in sc_res {
                if (t.duration == 0.0 || (t.duration >= 50.0 && t.duration <= 500.0))
                    && !is_noisy_compilation(&t.title)
                    && !is_junk_track(&t.title, &t.artist, is_russian)
                {
                    if first_sc_id.is_none() {
                        first_sc_id = Some(t.id.clone());
                    }
                    if seen_ids.insert(t.id.clone()) {
                        tracks.push(t);
                    }
                }
            }

            // Query SoundCloud related tracks for the first track found for this artist
            if let Some(sc_id) = first_sc_id {
                let sc_related = state.soundcloud.get_related_tracks(&sc_id, limit, &base_url).await;
                for t in sc_related {
                    if (t.duration == 0.0 || (t.duration >= 50.0 && t.duration <= 500.0))
                        && !is_noisy_compilation(&t.title)
                        && !is_junk_track(&t.title, &t.artist, is_russian)
                        && seen_ids.insert(t.id.clone())
                    {
                        tracks.push(t);
                    }
                }
            }
        }
        fastrand::shuffle(&mut tracks);
    }

    if tracks.is_empty() && !artist.is_empty() {
        let is_russian = is_russian_artist(artist);
        let sc_res = state.soundcloud.search_tracks(artist, limit * 2, &base_url).await;
        let mut first_sc_id: Option<String> = None;
        for t in sc_res {
            if (t.duration == 0.0 || (t.duration >= 50.0 && t.duration <= 500.0))
                && !is_noisy_compilation(&t.title)
                && !is_junk_track(&t.title, &t.artist, is_russian)
            {
                if first_sc_id.is_none() {
                    first_sc_id = Some(t.id.clone());
                }
                if seen_ids.insert(t.id.clone()) {
                    tracks.push(t);
                }
            }
        }
        if let Some(sc_id) = first_sc_id {
            let sc_related = state.soundcloud.get_related_tracks(&sc_id, limit, &base_url).await;
            for t in sc_related {
                if (t.duration == 0.0 || (t.duration >= 50.0 && t.duration <= 500.0))
                    && !is_noisy_compilation(&t.title)
                    && !is_junk_track(&t.title, &t.artist, is_russian)
                    && seen_ids.insert(t.id.clone())
                {
                    tracks.push(t);
                }
            }
        }
        fastrand::shuffle(&mut tracks);
    } else if tracks.is_empty() && !genre.is_empty() {
        let is_russian = genre.chars().any(|c| ('\u{0400}'..='\u{04FF}').contains(&c)) || chart.contains("ru");
        let search_query = if is_russian {
            match genre.as_str() {
                "rap" | "hiphop" | "hip-hop" => "русский хип-хоп",
                "rock" => "русский инди рок",
                "phonk" => "drift phonk",
                "pop" => "инди поп",
                _ => &genre,
            }
        } else {
            &genre
        };
        let sc_res = state.soundcloud.search_tracks(search_query, limit * 2, &base_url).await;
        for t in sc_res {
            if (t.duration == 0.0 || (t.duration >= 50.0 && t.duration <= 500.0))
                && !is_noisy_compilation(&t.title)
                && !is_junk_track(&t.title, &t.artist, is_russian)
                && t.plays.unwrap_or(0) >= 1000
                && seen_ids.insert(t.id.clone())
            {
                tracks.push(t);
            }
        }
        fastrand::shuffle(&mut tracks);
    }

    if !tracks.is_empty() {
        insert_search_cache(&state, cache_key, tracks.clone());
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

    let mut tracks: Vec<SearchTrack> = Vec::new();
    let mut seen_ids = HashSet::new();
    let mut seen_artists = HashSet::new();

    if !artist.is_empty() {
        let is_russian = is_russian_artist(artist);
        let dz_tracks = fetch_deezer_artist_radio(artist, limit * 2, &base_url).await;
        for t in dz_tracks {
            let norm_art = t.artist.to_lowercase();
            if seen_artists.contains(&norm_art) {
                continue;
            }
            if seen_ids.insert(t.id.clone()) {
                seen_artists.insert(norm_art);
                tracks.push(t);
            }
        }

        // Discover features and collaborations for this artist
        let feat_query = format!("{} feat", artist);
        let dz_feats = execute_deezer_search(&feat_query, 6, &base_url).await;
        for t in dz_feats {
            let norm_art = t.artist.to_lowercase();
            if seen_ids.insert(t.id.clone()) {
                seen_artists.insert(norm_art);
                tracks.push(t);
            }
        }

        if tracks.len() < limit * 2 {
            let rel_names = fetch_deezer_related_artists(artist).await;
            for rel_name in rel_names.into_iter().take(4) {
                if tracks.len() >= limit * 2 {
                    break;
                }
                let rel_tracks = fetch_deezer_artist_radio(&rel_name, 5, &base_url).await;
                for t in rel_tracks {
                    let norm_art = t.artist.to_lowercase();
                    if seen_artists.contains(&norm_art) {
                        continue;
                    }
                    if seen_ids.insert(t.id.clone()) {
                        seen_artists.insert(norm_art);
                        tracks.push(t);
                    }
                    if tracks.len() >= limit * 2 {
                        break;
                    }
                }
            }
        }
        if tracks.len() < limit {
            let sc_res = state.soundcloud.search_tracks(artist, limit * 2, &base_url).await;
            let mut first_sc_id: Option<String> = None;
            for t in sc_res {
                if (t.duration == 0.0 || (t.duration >= 50.0 && t.duration <= 500.0))
                    && !is_noisy_compilation(&t.title)
                    && !is_junk_track(&t.title, &t.artist, is_russian)
                {
                    if first_sc_id.is_none() {
                        first_sc_id = Some(t.id.clone());
                    }
                    let norm_art = t.artist.to_lowercase();
                    if seen_artists.insert(norm_art) && seen_ids.insert(t.id.clone()) {
                        tracks.push(t);
                    }
                }
            }

            if let Some(sc_id) = first_sc_id {
                let sc_related = state.soundcloud.get_related_tracks(&sc_id, limit, &base_url).await;
                for t in sc_related {
                    if (t.duration == 0.0 || (t.duration >= 50.0 && t.duration <= 500.0))
                        && !is_noisy_compilation(&t.title)
                        && !is_junk_track(&t.title, &t.artist, is_russian)
                    {
                        let norm_art = t.artist.to_lowercase();
                        if seen_artists.insert(norm_art) && seen_ids.insert(t.id.clone()) {
                            tracks.push(t);
                        }
                    }
                }
            }
        }
    }

    if tracks.is_empty() {
        let query = if !title.is_empty() && !artist.is_empty() {
            format!("{} {}", artist, title)
        } else if !artist.is_empty() {
            artist.to_string()
        } else {
            title.to_string()
        };
        let dz_search = execute_deezer_search(&query, limit * 2, &base_url).await;
        for t in dz_search {
            if seen_ids.insert(t.id.clone()) {
                tracks.push(t);
            }
        }
        if tracks.len() < limit {
            let sc_search = state.soundcloud.search_tracks(&query, limit, &base_url).await;
            for t in sc_search {
                if !is_noisy_compilation(&t.title) && seen_ids.insert(t.id.clone()) {
                    tracks.push(t);
                }
            }
        }
    }

    fastrand::shuffle(&mut tracks);

    // Cache all collected tracks
    if !tracks.is_empty() {
        insert_search_cache(&state, cache_key, tracks.clone());
    }

    fastrand::shuffle(&mut tracks);
    tracks.truncate(limit);
    Ok(Json(tracks))
}

#[derive(Debug, serde::Deserialize, Default)]
pub struct TopArtistsQuery {
    #[serde(default)]
    pub force: Option<bool>,
    #[serde(default)]
    pub limit: Option<usize>,
}

pub async fn get_top_artists(
    Query(query): Query<TopArtistsQuery>,
) -> Result<Json<Vec<ChartArtist>>, StatusCode> {
    let force = query.force.unwrap_or(false);
    let mut artists = crate::spotify_charts::get_cached_spotify_top_artists(force).await;
    if let Some(limit) = query.limit {
        if limit > 0 && limit < artists.len() {
            artists.truncate(limit);
        }
    }
    Ok(Json(artists))
}

#[derive(Debug, serde::Deserialize, Default)]
pub struct NewReleasesQuery {
    #[serde(default)]
    pub artists: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ReleaseItem {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub cover_url: Option<String>,
    pub track_count: Option<u32>,
    pub release_date: Option<String>,
    pub is_playlist: bool,
}

async fn fetch_artist_latest_albums(client: &reqwest::Client, artist_name: &str) -> Vec<ReleaseItem> {
    let mut albums = Vec::new();
    let encoded = urlencoding::encode(artist_name);

    // 1. Deezer: resolve artist ID -> get artist discography
    let search_url = format!("https://api.deezer.com/search/artist?q={}&limit=1", encoded);
    if let Ok(resp) = client.get(&search_url).header("User-Agent", "Mozilla/5.0").send().await {
        if let Ok(json) = resp.json::<serde_json::Value>().await {
            if let Some(first_artist) = json["data"].as_array().and_then(|arr| arr.first()) {
                if let Some(artist_id) = first_artist["id"].as_i64() {
                    let canon_name = first_artist["name"].as_str().unwrap_or(artist_name).trim().to_string();
                    let discog_url = format!("https://api.deezer.com/artist/{}/albums?limit=8", artist_id);
                    if let Ok(discog_resp) = client.get(&discog_url).header("User-Agent", "Mozilla/5.0").send().await {
                        if let Ok(discog_json) = discog_resp.json::<serde_json::Value>().await {
                            if let Some(arr) = discog_json["data"].as_array() {
                                for item in arr {
                                    let title = item["title"].as_str().unwrap_or("").trim().to_string();
                                    if title.is_empty() {
                                        continue;
                                    }
                                    let cover = item["cover_xl"].as_str()
                                        .or_else(|| item["cover_big"].as_str())
                                        .or_else(|| item["cover_medium"].as_str())
                                        .map(|s| s.to_string());
                                    let id = item["id"].to_string();
                                    let track_count = item["nb_tracks"].as_u64().map(|n| n as u32);
                                    let rel_date = item["release_date"].as_str().map(|s| s.to_string());

                                    albums.push(ReleaseItem {
                                        id,
                                        title,
                                        artist: canon_name.clone(),
                                        cover_url: cover,
                                        track_count,
                                        release_date: rel_date,
                                        is_playlist: false,
                                    });

                                    if albums.len() >= 2 {
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

    // 2. Fallback to iTunes if Deezer returned nothing
    if albums.is_empty() {
        let itunes_url = format!("https://itunes.apple.com/search?term={}&entity=album&attribute=artistTerm&limit=6", encoded);
        if let Ok(resp) = client.get(&itunes_url).header("User-Agent", "Mozilla/5.0").send().await {
            if let Ok(json) = resp.json::<serde_json::Value>().await {
                if let Some(results) = json["results"].as_array() {
                    for item in results {
                        let title = item["collectionName"].as_str().unwrap_or("").trim().to_string();
                        let art = item["artistName"].as_str().unwrap_or(artist_name).trim().to_string();
                        if title.is_empty() {
                            continue;
                        }
                        let cover = item["artworkUrl100"].as_str().map(|s| {
                            s.replace("100x100bb.jpg", "600x600bb.jpg")
                        });
                        let id = item["collectionId"].to_string();
                        let track_count = item["trackCount"].as_u64().map(|n| n as u32);
                        let rel_date = item["releaseDate"].as_str().map(|s| {
                            s.split('T').next().unwrap_or(s).to_string()
                        });

                        albums.push(ReleaseItem {
                            id,
                            title,
                            artist: art,
                            cover_url: cover,
                            track_count,
                            release_date: rel_date,
                            is_playlist: false,
                        });

                        if albums.len() >= 2 {
                            break;
                        }
                    }
                }
            }
        }
    }

    albums
}

pub async fn get_new_releases(
    Query(query): Query<NewReleasesQuery>,
) -> Result<Json<Vec<ReleaseItem>>, StatusCode> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(6))
        .build()
        .unwrap_or_default();

    let artists_raw = query.artists.unwrap_or_default();
    let mut artist_list: Vec<String> = artists_raw
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .take(8)
        .collect();

    if artist_list.is_empty() {
        artist_list = vec![
            "CUPSIZE".to_string(),
            "MACAN".to_string(),
            "The Weeknd".to_string(),
            "Travis Scott".to_string(),
            "VILLIAN & madk1d".to_string(),
            "Taylor Swift".to_string(),
        ];
    }

    let mut fetch_tasks = Vec::new();
    for artist in &artist_list {
        let c = client.clone();
        let art = artist.clone();
        fetch_tasks.push(async move {
            fetch_artist_latest_albums(&c, &art).await
        });
    }

    let results = futures_util::future::join_all(fetch_tasks).await;

    let mut releases = Vec::new();
    let mut seen_keys = HashSet::new();

    for artist_albums in results {
        for album in artist_albums {
            let key = format!("{}::{}", album.artist.to_lowercase(), album.title.to_lowercase());
            if seen_keys.insert(key) {
                releases.push(album);
            }
        }
    }

    if releases.is_empty() {
        let defaults = vec!["CUPSIZE", "MACAN", "The Weeknd", "Travis Scott"];
        for def_art in defaults {
            let albums = fetch_artist_latest_albums(&client, def_art).await;
            for album in albums {
                let key = format!("{}::{}", album.artist.to_lowercase(), album.title.to_lowercase());
                if seen_keys.insert(key) {
                    releases.push(album);
                }
            }
        }
    }

    Ok(Json(releases))
}

