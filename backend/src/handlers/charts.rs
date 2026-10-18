use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path as StdPath, PathBuf};
use std::sync::LazyLock;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;

use crate::config::get_base_url;
use crate::models::SearchTrack;
use crate::AppState;

const CACHE_TTL_SECS: u64 = 4 * 3600; // 4 hours

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChartSummary {
    pub id: String,
    pub title: String,
    pub subtitle: String,
    pub cover_url: Option<String>,
    pub track_count: usize,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChartDetail {
    pub id: String,
    pub title: String,
    pub subtitle: String,
    pub cover_url: Option<String>,
    pub updated_at: String,
    pub tracks: Vec<SearchTrack>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReleaseItem {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub cover_url: Option<String>,
    pub track_count: Option<u32>,
    pub release_date: Option<String>,
    pub is_playlist: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HomeExploreData {
    pub popular_tracks: Vec<SearchTrack>,
    pub popular_artists: Vec<crate::models::ChartArtist>,
    pub popular_albums: Vec<ReleaseItem>,
    pub charts: Vec<ChartSummary>,
}

static CHARTS_CACHE: LazyLock<RwLock<HashMap<String, (ChartDetail, Instant)>>> =
    LazyLock::new(|| RwLock::new(HashMap::new()));
static POPULAR_ALBUMS_CACHE: LazyLock<RwLock<Option<(Vec<ReleaseItem>, Instant)>>> =
    LazyLock::new(|| RwLock::new(None));

fn get_charts_cache_dir() -> PathBuf {
    let base = if StdPath::new("/data").exists() {
        PathBuf::from("/data/charts_cache")
    } else {
        PathBuf::from("charts_cache")
    };
    let _ = fs::create_dir_all(&base);
    base
}

fn load_chart_from_disk(chart_id: &str) -> Option<ChartDetail> {
    let path = get_charts_cache_dir().join(format!("{}.json", chart_id));
    if path.exists() {
        if let Ok(content) = fs::read_to_string(&path) {
            if let Ok(detail) = serde_json::from_str::<ChartDetail>(&content) {
                if !detail.tracks.is_empty() {
                    return Some(detail);
                }
            }
        }
    }
    None
}

fn save_chart_to_disk(detail: &ChartDetail) {
    let path = get_charts_cache_dir().join(format!("{}.json", detail.id));
    if let Ok(json) = serde_json::to_string(detail) {
        let _ = fs::write(path, json);
    }
}

async fn fetch_apple_music_rss(country: &str, limit: usize, base_url: &str) -> Result<Vec<SearchTrack>, String> {
    let url = format!(
        "https://rss.applemarketingtools.com/api/v2/{}/music/most-played/{}/songs.json",
        country, limit
    );
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36")
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("Bad status: {}", resp.status()));
    }

    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let results = json["feed"]["results"]
        .as_array()
        .ok_or_else(|| "No results array".to_string())?;

    let mut tracks = Vec::new();
    for (idx, item) in results.iter().enumerate() {
        let name = item["name"].as_str().unwrap_or("").trim();
        let artist = item["artistName"].as_str().unwrap_or("").trim();
        if name.is_empty() || artist.is_empty() {
            continue;
        }

        let raw_artwork = item["artworkUrl100"].as_str().unwrap_or("");
        let cover_url = if !raw_artwork.is_empty() {
            let hd = raw_artwork.replace("100x100bb.jpg", "600x600bb.jpg");
            Some(format!("{}/api/cover?url={}", base_url, urlencoding::encode(&hd)))
        } else {
            None
        };

        let track_id = item["id"].as_str().unwrap_or("");
        let id = if !track_id.is_empty() {
            format!("chart-{}-{}", country, track_id)
        } else {
            format!("chart-{}-{}", country, idx + 1)
        };

        let encoded_title = urlencoding::encode(name);
        let encoded_artist = urlencoding::encode(artist);
        let audio_url = format!(
            "{}/api/stream?title={}&artist={}&duration=0&id={}",
            base_url, encoded_title, encoded_artist, id
        );

        tracks.push(SearchTrack {
            id,
            title: name.to_string(),
            artist: artist.to_string(),
            duration: 0.0,
            audio_url,
            cover_url,
            plays: Some((results.len() - idx) as i64 * 1000),
        });
    }

    Ok(tracks)
}

async fn fetch_soundcloud_chart(limit: usize, base_url: &str) -> Result<Vec<SearchTrack>, String> {
    let sc = crate::soundcloud::SoundCloudClient::new();
    let count = (limit / 2).max(15);
    let mut tracks = sc.search_tracks("phonk drift 2026", count, base_url).await;
    let viral = sc.search_tracks("electronic viral remix", count, base_url).await;
    tracks.extend(viral);

    if !tracks.is_empty() {
        tracks.truncate(limit);
        return Ok(tracks);
    }
    Err("SoundCloud unavailable".to_string())
}

async fn fetch_tiktok_viral_chart(limit: usize, base_url: &str) -> Result<Vec<SearchTrack>, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36")
        .build()
        .map_err(|e| e.to_string())?;

    let mut global_items = Vec::new();
    let mut ru_items = Vec::new();

    // 1. Fetch TikTok Songs - Viral Hits Chart (Topsify / Deezer playlist 6951615084)
    let global_url = "https://api.deezer.com/playlist/6951615084";
    if let Ok(resp) = client.get(global_url).send().await {
        if resp.status().is_success() {
            if let Ok(json) = resp.json::<serde_json::Value>().await {
                if let Some(arr) = json["tracks"]["data"].as_array() {
                    for item in arr {
                        let title = item["title"].as_str().unwrap_or("").trim().to_string();
                        let artist = item["artist"]["name"].as_str().unwrap_or("").trim().to_string();
                        if !title.is_empty() && !artist.is_empty() {
                            let cover = item["album"]["cover_xl"].as_str()
                                .or_else(|| item["album"]["cover_big"].as_str())
                                .or_else(|| item["album"]["cover_medium"].as_str())
                                .map(|s| s.to_string());
                            let duration = item["duration"].as_f64().unwrap_or(0.0);
                            let id = item["id"].to_string();
                            global_items.push((id, title, artist, duration, cover));
                        }
                    }
                }
            }
        }
    }

    // 2. Fetch Russian TikTok Trends (Deezer playlist 8791706602)
    let ru_url = "https://api.deezer.com/playlist/8791706602";
    if let Ok(resp) = client.get(ru_url).send().await {
        if resp.status().is_success() {
            if let Ok(json) = resp.json::<serde_json::Value>().await {
                if let Some(arr) = json["tracks"]["data"].as_array() {
                    for item in arr {
                        let title = item["title"].as_str().unwrap_or("").trim().to_string();
                        let artist = item["artist"]["name"].as_str().unwrap_or("").trim().to_string();
                        if !title.is_empty() && !artist.is_empty() {
                            let cover = item["album"]["cover_xl"].as_str()
                                .or_else(|| item["album"]["cover_big"].as_str())
                                .or_else(|| item["album"]["cover_medium"].as_str())
                                .map(|s| s.to_string());
                            let duration = item["duration"].as_f64().unwrap_or(0.0);
                            let id = item["id"].to_string();
                            ru_items.push((id, title, artist, duration, cover));
                        }
                    }
                }
            }
        }
    }

    let mut tracks = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let max_len = global_items.len().max(ru_items.len());

    for i in 0..max_len {
        if i < global_items.len() {
            let (tid, title, artist, duration, cover) = &global_items[i];
            let key = format!("{}::{}", artist.to_lowercase(), title.to_lowercase());
            if seen.insert(key) {
                let id = format!("tiktok-{}", tid);
                let encoded_title = urlencoding::encode(title);
                let encoded_artist = urlencoding::encode(artist);
                let audio_url = format!(
                    "{}/api/stream?title={}&artist={}&duration={}&id={}",
                    base_url, encoded_title, encoded_artist, *duration as u32, id
                );
                tracks.push(SearchTrack {
                    id,
                    title: title.clone(),
                    artist: artist.clone(),
                    duration: *duration,
                    audio_url,
                    cover_url: cover.clone(),
                    plays: Some((1000 - tracks.len() as i64) * 5000),
                });
            }
        }

        if i < ru_items.len() {
            let (tid, title, artist, duration, cover) = &ru_items[i];
            let key = format!("{}::{}", artist.to_lowercase(), title.to_lowercase());
            if seen.insert(key) {
                let id = format!("tiktok-ru-{}", tid);
                let encoded_title = urlencoding::encode(title);
                let encoded_artist = urlencoding::encode(artist);
                let audio_url = format!(
                    "{}/api/stream?title={}&artist={}&duration={}&id={}",
                    base_url, encoded_title, encoded_artist, *duration as u32, id
                );
                tracks.push(SearchTrack {
                    id,
                    title: title.clone(),
                    artist: artist.clone(),
                    duration: *duration,
                    audio_url,
                    cover_url: cover.clone(),
                    plays: Some((1000 - tracks.len() as i64) * 4500),
                });
            }
        }

        if tracks.len() >= limit {
            break;
        }
    }

    if tracks.is_empty() {
        return fetch_apple_music_rss("gb", limit, base_url).await;
    }

    Ok(tracks)
}

async fn fetch_chart_tracks(chart_id: &str, base_url: &str) -> Result<Vec<SearchTrack>, String> {
    match chart_id {
        "global-top" => fetch_apple_music_rss("us", 100, base_url).await,
        "ru-top" => fetch_apple_music_rss("ru", 100, base_url).await,
        "soundcloud-top" => fetch_soundcloud_chart(50, base_url).await,
        "viral-trends" => fetch_tiktok_viral_chart(50, base_url).await,
        _ => Err("Unknown chart id".to_string()),
    }
}

pub async fn get_or_update_chart(chart_id: &str) -> Option<ChartDetail> {
    let base_url = get_base_url();

    // 1. Check in-memory cache
    {
        let guard = CHARTS_CACHE.read().await;
        if let Some((detail, cached_at)) = guard.get(chart_id) {
            if cached_at.elapsed() < Duration::from_secs(CACHE_TTL_SECS) && !detail.tracks.is_empty() {
                return Some(detail.clone());
            }
        }
    }

    // 2. Check disk cache
    let disk_detail = load_chart_from_disk(chart_id);

    // If disk cache exists, we can return it immediately and spawn background refresh if expired
    if let Some(ref detail) = disk_detail {
        let is_recent = {
            let guard = CHARTS_CACHE.read().await;
            guard.get(chart_id).map(|(_, t)| t.elapsed() < Duration::from_secs(CACHE_TTL_SECS)).unwrap_or(false)
        };

        if !is_recent {
            // Update in-memory with disk version so subsequent calls don't hit disk
            {
                let mut guard = CHARTS_CACHE.write().await;
                guard.insert(chart_id.to_string(), (detail.clone(), Instant::now()));
            }

            // Spawn background refresh task (Stale-While-Revalidate)
            let cid = chart_id.to_string();
            let b_url = base_url.clone();
            tokio::spawn(async move {
                if let Ok(tracks) = fetch_chart_tracks(&cid, &b_url).await {
                    if !tracks.is_empty() {
                        let updated_detail = build_chart_detail(&cid, tracks);
                        save_chart_to_disk(&updated_detail);
                        let mut guard = CHARTS_CACHE.write().await;
                        guard.insert(cid, (updated_detail, Instant::now()));
                    }
                }
            });
        }

        return Some(detail.clone());
    }

    // 3. No cache at all: fetch online directly
    if let Ok(tracks) = fetch_chart_tracks(chart_id, &base_url).await {
        if !tracks.is_empty() {
            let detail = build_chart_detail(chart_id, tracks);
            save_chart_to_disk(&detail);
            let mut guard = CHARTS_CACHE.write().await;
            guard.insert(chart_id.to_string(), (detail.clone(), Instant::now()));
            return Some(detail);
        }
    }

    disk_detail
}

fn build_chart_detail(chart_id: &str, tracks: Vec<SearchTrack>) -> ChartDetail {
    let (title, subtitle) = match chart_id {
        "global-top" => ("Spotify Global Top 100", "Главные мировые хиты стримингов"),
        "ru-top" => ("Топ-100: Россия и СНГ", "100 самых популярных треков региона"),
        "soundcloud-top" => ("SoundCloud Тренды & Phonk", "Вирусные треки, фонк и ремиксы с SoundCloud"),
        "viral-trends" => ("Тренды TikTok & Reels", "Вирусные композиции и мировые тренды"),
        _ => ("Чарт", "Популярные треки"),
    };

    let cover_url = tracks.first().and_then(|t| t.cover_url.clone());

    ChartDetail {
        id: chart_id.to_string(),
        title: title.to_string(),
        subtitle: subtitle.to_string(),
        cover_url,
        updated_at: "Ежедневно".to_string(),
        tracks,
    }
}

pub async fn list_charts(
    State(_state): State<AppState>,
) -> Result<Json<Vec<ChartSummary>>, StatusCode> {
    let chart_ids = ["global-top", "ru-top", "soundcloud-top", "viral-trends"];
    let mut summaries = Vec::new();

    for cid in chart_ids {
        if let Some(detail) = get_or_update_chart(cid).await {
            summaries.push(ChartSummary {
                id: detail.id,
                title: detail.title,
                subtitle: detail.subtitle,
                cover_url: detail.cover_url,
                track_count: detail.tracks.len(),
                updated_at: detail.updated_at,
            });
        } else {
            let (title, subtitle) = match cid {
                "global-top" => ("Spotify Global Top 100", "Главные мировые хиты стримингов"),
                "ru-top" => ("Топ-100: Россия и СНГ", "100 самых популярных треков региона"),
                "soundcloud-top" => ("SoundCloud Тренды & Phonk", "Вирусные треки, фонк и ремиксы с SoundCloud"),
                "viral-trends" => ("Тренды TikTok & Reels", "Вирусные композиции и мировые тренды"),
                _ => ("Чарт", "Популярные треки"),
            };
            summaries.push(ChartSummary {
                id: cid.to_string(),
                title: title.to_string(),
                subtitle: subtitle.to_string(),
                cover_url: None,
                track_count: 50,
                updated_at: "Ежедневно".to_string(),
            });
        }
    }

    Ok(Json(summaries))
}

pub async fn get_chart_by_id(
    State(_state): State<AppState>,
    Path(chart_id): Path<String>,
) -> Result<Json<ChartDetail>, StatusCode> {
    if let Some(detail) = get_or_update_chart(&chart_id).await {
        Ok(Json(detail))
    } else {
        Err(StatusCode::NOT_FOUND)
    }
}

async fn fetch_popular_albums_online(base_url: &str) -> Vec<ReleaseItem> {
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36")
        .build()
    {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };

    let mut all_albums = Vec::new();

    // 1. Global / Spotify Top Albums (80% - up to 16 albums)
    let us_url = "https://rss.applemarketingtools.com/api/v2/us/music/most-played/25/albums.json";
    if let Ok(resp) = client.get(us_url).send().await {
        if resp.status().is_success() {
            if let Ok(json) = resp.json::<serde_json::Value>().await {
                if let Some(results) = json["feed"]["results"].as_array() {
                    for a in results.iter().take(16) {
                        let name = a["name"].as_str().unwrap_or("").trim();
                        let artist = a["artistName"].as_str().unwrap_or("").trim();
                        if name.is_empty() || artist.is_empty() {
                            continue;
                        }
                        let raw_art = a["artworkUrl100"].as_str().unwrap_or("");
                        let cover_url = if !raw_art.is_empty() {
                            let hd = raw_art.replace("100x100bb.jpg", "600x600bb.jpg");
                            Some(format!("{}/api/cover?url={}", base_url, urlencoding::encode(&hd)))
                        } else {
                            None
                        };
                        let id = a["id"].as_str().unwrap_or("").to_string();
                        let release_date = a["releaseDate"].as_str().map(|s| s.to_string());
                        all_albums.push(ReleaseItem {
                            id,
                            title: name.to_string(),
                            artist: artist.to_string(),
                            cover_url,
                            track_count: None,
                            release_date,
                            is_playlist: false,
                        });
                    }
                }
            }
        }
    }

    // 2. Russian Top Albums (20% - up to 6 albums)
    let ru_url = "https://rss.applemarketingtools.com/api/v2/ru/music/most-played/20/albums.json";
    if let Ok(resp) = client.get(ru_url).send().await {
        if resp.status().is_success() {
            if let Ok(json) = resp.json::<serde_json::Value>().await {
                if let Some(results) = json["feed"]["results"].as_array() {
                    for a in results.iter().take(6) {
                        let name = a["name"].as_str().unwrap_or("").trim();
                        let artist = a["artistName"].as_str().unwrap_or("").trim();
                        if name.is_empty() || artist.is_empty() {
                            continue;
                        }
                        if all_albums.iter().any(|existing| existing.title == name && existing.artist == artist) {
                            continue;
                        }
                        let raw_art = a["artworkUrl100"].as_str().unwrap_or("");
                        let cover_url = if !raw_art.is_empty() {
                            let hd = raw_art.replace("100x100bb.jpg", "600x600bb.jpg");
                            Some(format!("{}/api/cover?url={}", base_url, urlencoding::encode(&hd)))
                        } else {
                            None
                        };
                        let id = a["id"].as_str().unwrap_or("").to_string();
                        let release_date = a["releaseDate"].as_str().map(|s| s.to_string());
                        all_albums.push(ReleaseItem {
                            id,
                            title: name.to_string(),
                            artist: artist.to_string(),
                            cover_url,
                            track_count: None,
                            release_date,
                            is_playlist: false,
                        });
                    }
                }
            }
        }
    }

    all_albums
}

pub async fn get_or_update_popular_albums(base_url: &str) -> Vec<ReleaseItem> {
    // 1. In-memory cache
    {
        let guard = POPULAR_ALBUMS_CACHE.read().await;
        if let Some((ref albums, cached_at)) = *guard {
            if cached_at.elapsed() < Duration::from_secs(CACHE_TTL_SECS) && !albums.is_empty() {
                return albums.clone();
            }
        }
    }

    // 2. Disk cache
    let path = get_charts_cache_dir().join("popular_albums.json");
    if path.exists() {
        if let Ok(content) = fs::read_to_string(&path) {
            if let Ok(albums) = serde_json::from_str::<Vec<ReleaseItem>>(&content) {
                if !albums.is_empty() {
                    let mut guard = POPULAR_ALBUMS_CACHE.write().await;
                    *guard = Some((albums.clone(), Instant::now()));

                    // Background refresh if expired
                    let b_url = base_url.to_string();
                    tokio::spawn(async move {
                        let fresh = fetch_popular_albums_online(&b_url).await;
                        if !fresh.is_empty() {
                            let p = get_charts_cache_dir().join("popular_albums.json");
                            if let Ok(json) = serde_json::to_string(&fresh) {
                                let _ = fs::write(p, json);
                            }
                            let mut g = POPULAR_ALBUMS_CACHE.write().await;
                            *g = Some((fresh, Instant::now()));
                        }
                    });

                    return albums;
                }
            }
        }
    }

    // 3. Fetch online
    let fresh = fetch_popular_albums_online(base_url).await;
    if !fresh.is_empty() {
        let path = get_charts_cache_dir().join("popular_albums.json");
        if let Ok(json) = serde_json::to_string(&fresh) {
            let _ = fs::write(path, json);
        }
        let mut guard = POPULAR_ALBUMS_CACHE.write().await;
        *guard = Some((fresh.clone(), Instant::now()));
        return fresh;
    }

    Vec::new()
}

pub async fn get_home_explore(
    State(_state): State<AppState>,
) -> Result<Json<HomeExploreData>, StatusCode> {
    let base_url = get_base_url();

    // 1. Popular tracks: 80% Spotify global hits + Russian Top hits + SoundCloud viral
    let global_tracks = get_or_update_chart("global-top").await.map(|c| c.tracks).unwrap_or_default();
    let ru_tracks = get_or_update_chart("ru-top").await.map(|c| c.tracks).unwrap_or_default();
    let sc_tracks = get_or_update_chart("soundcloud-top").await.map(|c| c.tracks).unwrap_or_default();

    let mut popular_tracks = Vec::new();
    popular_tracks.extend(global_tracks.into_iter().take(14));
    popular_tracks.extend(ru_tracks.into_iter().take(5));
    popular_tracks.extend(sc_tracks.into_iter().take(5));

    // 2. Popular artists: 100% Spotify top artists
    let mut popular_artists = crate::spotify_charts::get_cached_spotify_top_artists(false).await;
    popular_artists.truncate(10);

    // 3. Popular albums: 80% Global/Spotify + 20% Russian
    let popular_albums = get_or_update_popular_albums(&base_url).await;

    // 4. Featured Charts: 4 primary curated categories
    let chart_ids = ["global-top", "ru-top", "soundcloud-top", "viral-trends"];
    let mut charts = Vec::new();
    for cid in chart_ids {
        if let Some(detail) = get_or_update_chart(cid).await {
            charts.push(ChartSummary {
                id: detail.id,
                title: detail.title,
                subtitle: detail.subtitle,
                cover_url: detail.cover_url,
                track_count: detail.tracks.len(),
                updated_at: detail.updated_at,
            });
        }
    }

    Ok(Json(HomeExploreData {
        popular_tracks,
        popular_artists,
        popular_albums,
        charts,
    }))
}

pub fn spawn_charts_background_refresher() {
    tokio::spawn(async move {
        // Initial warmup delay: 4 seconds after startup
        tokio::time::sleep(Duration::from_secs(4)).await;

        loop {
            let base_url = get_base_url();
            let chart_ids = ["global-top", "ru-top", "soundcloud-top", "viral-trends"];

            for cid in chart_ids {
                if let Ok(tracks) = fetch_chart_tracks(cid, &base_url).await {
                    if !tracks.is_empty() {
                        let updated_detail = build_chart_detail(cid, tracks);
                        save_chart_to_disk(&updated_detail);
                        let mut guard = CHARTS_CACHE.write().await;
                        guard.insert(cid.to_string(), (updated_detail, Instant::now()));
                    }
                }
                tokio::time::sleep(Duration::from_millis(600)).await;
            }

            // Also refresh popular albums
            let albums = fetch_popular_albums_online(&base_url).await;
            if !albums.is_empty() {
                let path = get_charts_cache_dir().join("popular_albums.json");
                if let Ok(json) = serde_json::to_string(&albums) {
                    let _ = fs::write(path, json);
                }
                let mut guard = POPULAR_ALBUMS_CACHE.write().await;
                *guard = Some((albums, Instant::now()));
            }

            // Also refresh Spotify top artists
            let _ = crate::spotify_charts::get_cached_spotify_top_artists(true).await;

            // Automatically refresh every 1 hour in real-time
            tokio::time::sleep(Duration::from_secs(3600)).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_chart_detail() {
        let dummy_tracks = vec![SearchTrack {
            id: "t1".to_string(),
            title: "Track 1".to_string(),
            artist: "Artist 1".to_string(),
            duration: 180.0,
            audio_url: "https://example.com/audio".to_string(),
            cover_url: Some("https://example.com/cover.jpg".to_string()),
            plays: Some(5000),
        }];

        let detail = build_chart_detail("ru-top", dummy_tracks);
        assert_eq!(detail.id, "ru-top");
        assert_eq!(detail.title, "Топ-100: Россия и СНГ");
        assert_eq!(detail.cover_url, Some("https://example.com/cover.jpg".to_string()));
        assert_eq!(detail.tracks.len(), 1);
    }
}
