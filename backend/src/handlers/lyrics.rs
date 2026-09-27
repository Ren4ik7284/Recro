use axum::{
    extract::{Query, State},
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use crate::AppState;

#[derive(Debug, Deserialize)]
pub struct LyricsQuery {
    pub title: String,
    pub artist: Option<String>,
    #[allow(dead_code)]
    pub duration: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LyricsResponse {
    pub synced: bool,
    pub lyrics: String,
    pub source: String,
    pub track_name: Option<String>,
    pub artist_name: Option<String>,
    pub duration: Option<f64>,
}

pub type LyricsCache = Arc<Mutex<HashMap<String, (LyricsResponse, Instant)>>>;

pub fn clean_title(title: &str) -> String {
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
    let noise = [
        "official music video", "official video", "official audio", "official",
        "lyric video", "lyrics", "visualizer", "audio", "clip officiel",
        "remastered", "4k", "hd", "hq", "live", "full album", "премьера клипа",
        "премьера песни", "клип", "новинка", "хит", "slowed", "reverb", "speed up",
    ];
    let mut lower = s.to_lowercase();
    for word in noise {
        while let Some(idx) = lower.find(word) {
            s.replace_range(idx..idx + word.len(), " ");
            lower.replace_range(idx..idx + word.len(), " ");
        }
    }
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub fn clean_artist(artist: &str) -> String {
    let mut s = artist.to_string();
    let noise = ["topic", "vevo", "records", "music", "official", "channel"];
    let mut lower = s.to_lowercase();
    for word in noise {
        while let Some(idx) = lower.find(word) {
            s.replace_range(idx..idx + word.len(), " ");
            lower.replace_range(idx..idx + word.len(), " ");
        }
    }
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn normalize_for_comparison(s: &str) -> String {
    s.to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn is_noise_word(w: &str) -> bool {
    matches!(
        w,
        "official" | "video" | "audio" | "remastered" | "remaster" | "hd" | "4k"
        | "visualizer" | "clip" | "slowed" | "reverb" | "speed" | "up" | "sped"
        | "live" | "edit" | "version" | "acoustic" | "cover" | "instrumental"
        | "prod" | "feat" | "ft" | "lyrics" | "lyric" | "mix" | "original" | "extended"
        | "клип" | "новинка" | "песня" | "трек" | "хит"
    )
}

fn calc_match_score(
    exp_title: &str,
    exp_artist: &str,
    exp_dur: Option<f64>,
    cand_title: &str,
    cand_artist: &str,
    cand_dur: Option<f64>,
    has_synced: bool,
) -> f64 {
    let exp_t = normalize_for_comparison(exp_title);
    let exp_a = normalize_for_comparison(exp_artist);
    let cand_t = normalize_for_comparison(cand_title);
    let cand_a = normalize_for_comparison(cand_artist);

    if exp_t.is_empty() || cand_t.is_empty() {
        return 0.0;
    }

    // 1. Artist matching
    let is_swapped = (!exp_a.is_empty() && (cand_t.contains(&exp_a) || exp_a.contains(&cand_t)))
        && (cand_a.contains(&exp_t) || exp_t.contains(&cand_a));

    let artist_score = if is_swapped {
        30.0
    } else if !exp_a.is_empty() && !cand_a.is_empty() {
        if exp_a == cand_a || cand_a.contains(&exp_a) || exp_a.contains(&cand_a) {
            30.0
        } else {
            let exp_words: Vec<&str> = exp_a.split_whitespace().filter(|w| w.len() >= 2).collect();
            let cand_words: Vec<&str> = cand_a.split_whitespace().filter(|w| w.len() >= 2).collect();
            let mut matched_words = 0;
            for ew in &exp_words {
                if cand_words.iter().any(|cw| cw.contains(ew) || ew.contains(cw)) {
                    matched_words += 1;
                }
            }
            if matched_words > 0 {
                25.0 * (matched_words as f64 / exp_words.len().max(1) as f64)
            } else {
                // If candidate artist does not match expected artist at all, REJECT!
                return 0.0;
            }
        }
    } else if exp_a.is_empty() {
        15.0
    } else {
        5.0
    };

    // 2. Title matching
    let title_score = if exp_t == cand_t || is_swapped {
        50.0
    } else {
        let exp_words: Vec<&str> = exp_t.split_whitespace().filter(|w| w.len() >= 2).collect();
        let cand_words: Vec<&str> = cand_t.split_whitespace().filter(|w| w.len() >= 2).collect();

        if exp_words.len() == 1 {
            let target_word = exp_words[0];
            if cand_words.contains(&target_word) {
                let extra_non_noise = cand_words.iter().filter(|w| **w != target_word && !is_noise_word(w)).count();
                if extra_non_noise == 0 {
                    45.0
                } else {
                    return 0.0;
                }
            } else {
                return 0.0;
            }
        } else {
            let mut matched_words = 0;
            for ew in &exp_words {
                if cand_words.iter().any(|cw| cw == ew || cw.contains(ew) || ew.contains(cw)) {
                    matched_words += 1;
                }
            }
            let ratio = matched_words as f64 / exp_words.len().max(1) as f64;
            if ratio < 0.45 {
                return 0.0;
            }
            ratio * 45.0
        }
    };

    // 3. Duration check
    let mut dur_penalty = 0.0;
    if let (Some(ed), Some(cd)) = (exp_dur, cand_dur) {
        if ed > 20.0 && cd > 20.0 {
            let diff = (ed - cd).abs();
            if diff > 45.0 {
                return 0.0;
            }
            if diff > 15.0 {
                dur_penalty = (diff - 15.0) * 0.8;
            }
        }
    }

    let synced_bonus = if has_synced { 20.0 } else { 0.0 };

    (artist_score + title_score + synced_bonus - dur_penalty).max(0.0)
}

async fn fetch_lrclib(
    client: &reqwest::Client,
    title: &str,
    artist: &str,
    duration: Option<f64>,
) -> Option<LyricsResponse> {
    let mut queries = Vec::new();
    if !artist.is_empty() {
        queries.push(format!("track_name={}&artist_name={}", urlencoding::encode(title), urlencoding::encode(artist)));
        queries.push(format!("q={}", urlencoding::encode(&format!("{} {}", artist, title))));
        queries.push(format!("q={}", urlencoding::encode(&format!("{} {}", title, artist))));
    } else {
        queries.push(format!("q={}", urlencoding::encode(title)));
    }

    let mut best_candidate: Option<(f64, LyricsResponse)> = None;

    for q in queries {
        let is_search = q.starts_with("q=");
        let url = if is_search {
            format!("https://lrclib.net/api/search?{}", q)
        } else {
            format!("https://lrclib.net/api/get?{}", q)
        };

        let req = client.get(&url).header("User-Agent", "RecroPlayer/1.0").timeout(std::time::Duration::from_millis(2500));
        if let Ok(res) = req.send().await {
            if res.status().is_success() {
                if is_search {
                    if let Ok(items) = res.json::<Vec<serde_json::Value>>().await {
                        for it in items {
                            let cand_title = it["trackName"].as_str().unwrap_or("");
                            let cand_artist = it["artistName"].as_str().unwrap_or("");
                            let cand_dur = it["duration"].as_f64();
                            let synced = it["syncedLyrics"].as_str().unwrap_or("").trim();
                            let has_synced = !synced.is_empty();

                            let score = calc_match_score(title, artist, duration, cand_title, cand_artist, cand_dur, has_synced);
                            if score >= 60.0 && has_synced {
                                if best_candidate.as_ref().map_or(true, |(best_s, _)| score > *best_s) {
                                    best_candidate = Some((
                                        score,
                                        LyricsResponse {
                                            synced: true,
                                            lyrics: synced.to_string(),
                                            source: "lrclib".to_string(),
                                            track_name: Some(cand_title.to_string()),
                                            artist_name: Some(cand_artist.to_string()),
                                            duration: cand_dur,
                                        },
                                    ));
                                }
                            }
                        }
                    }
                } else if let Ok(it) = res.json::<serde_json::Value>().await {
                    let cand_title = it["trackName"].as_str().unwrap_or("");
                    let cand_artist = it["artistName"].as_str().unwrap_or("");
                    let cand_dur = it["duration"].as_f64();
                    let synced = it["syncedLyrics"].as_str().unwrap_or("").trim();
                    let has_synced = !synced.is_empty();

                    let score = calc_match_score(title, artist, duration, cand_title, cand_artist, cand_dur, has_synced);
                    if score >= 60.0 && has_synced {
                        return Some(LyricsResponse {
                            synced: true,
                            lyrics: synced.to_string(),
                            source: "lrclib".to_string(),
                            track_name: Some(cand_title.to_string()),
                            artist_name: Some(cand_artist.to_string()),
                            duration: cand_dur,
                        });
                    }
                }
            }
        }
        if let Some((score, resp)) = &best_candidate {
            if *score >= 75.0 {
                return Some(resp.clone());
            }
        }
    }

    best_candidate.map(|(_, resp)| resp)
}

async fn fetch_kugou(
    client: &reqwest::Client,
    title: &str,
    artist: &str,
    duration: Option<f64>,
) -> Option<LyricsResponse> {
    let query = if !artist.is_empty() {
        format!("{} {}", artist, title)
    } else {
        title.to_string()
    };

    let search_url = format!(
        "http://mobilecdn.kugou.com/api/v3/search/song?format=json&keyword={}&page=1&pagesize=5",
        urlencoding::encode(&query)
    );

    let res = client
        .get(&search_url)
        .header("User-Agent", "Mozilla/5.0")
        .timeout(std::time::Duration::from_millis(3000))
        .send()
        .await
        .ok()?;

    let json: serde_json::Value = res.json().await.ok()?;
    let songs = json["data"]["info"].as_array()?;

    for song in songs {
        let cand_title = song["songname"].as_str().unwrap_or("");
        let cand_artist = song["singername"].as_str().unwrap_or("");
        let cand_dur = song["duration"].as_f64();

        let score = calc_match_score(title, artist, duration, cand_title, cand_artist, cand_dur, true);
        if score < 55.0 {
            continue;
        }

        let hash = match song["hash"].as_str() {
            Some(h) if !h.is_empty() => h,
            _ => continue,
        };

        let lrc_search = format!(
            "http://krcs.kugou.com/search?ver=1&man=yes&client=mobi&keyword=&duration=&hash={}",
            hash
        );
        let cand_res = client
            .get(&lrc_search)
            .timeout(std::time::Duration::from_millis(2500))
            .send()
            .await
            .ok()?;

        let cand_json: serde_json::Value = cand_res.json().await.ok()?;
        let candidates = match cand_json["candidates"].as_array() {
            Some(c) if !c.is_empty() => c,
            _ => continue,
        };

        for cand in candidates {
            let id = match cand["id"].as_str() {
                Some(i) => i.to_string(),
                None => match cand["id"].as_i64() {
                    Some(num) => num.to_string(),
                    None => continue,
                },
            };
            let accesskey = match cand["accesskey"].as_str() {
                Some(k) if k.len() >= 20 => k,
                _ => continue,
            };

            let dl_url = format!(
                "http://lyrics.kugou.com/download?ver=1&client=pc&id={}&accesskey={}&fmt=lrc&charset=utf8",
                id, accesskey
            );

            let dl_res = client
                .get(&dl_url)
                .timeout(std::time::Duration::from_millis(2500))
                .send()
                .await
                .ok();

            if let Some(dl) = dl_res {
                if let Ok(dl_json) = dl.json::<serde_json::Value>().await {
                    if let Some(b64) = dl_json["content"].as_str() {
                        if let Ok(bytes) = base64_decode(b64) {
                            if let Ok(text) = String::from_utf8(bytes) {
                                if text.contains('[') && text.contains(']') {
                                    return Some(LyricsResponse {
                                        synced: true,
                                        lyrics: text,
                                        source: "kugou".to_string(),
                                        track_name: Some(cand_title.to_string()),
                                        artist_name: Some(cand_artist.to_string()),
                                        duration: cand_dur,
                                    });
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    None
}

fn base64_decode(input: &str) -> Result<Vec<u8>, ()> {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut map = [255u8; 256];
    for (i, &b) in TABLE.iter().enumerate() {
        map[b as usize] = i as u8;
    }
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len() * 3 / 4);
    let mut buf = 0u32;
    let mut bits = 0;
    for &b in bytes {
        if b == b'=' || b == b'\r' || b == b'\n' || b == b' ' {
            continue;
        }
        let val = map[b as usize];
        if val == 255 {
            continue;
        }
        buf = (buf << 6) | (val as u32);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
        }
    }
    Ok(out)
}

pub async fn get_lyrics(
    State(state): State<AppState>,
    Query(params): Query<LyricsQuery>,
) -> Result<Json<LyricsResponse>, StatusCode> {
    let mut raw_title = params.title.trim().to_string();
    let mut raw_artist = params.artist.unwrap_or_default().trim().to_string();

    let separators = [" - ", " – ", " — ", " | ", " // "];
    for sep in separators {
        if raw_title.contains(sep) {
            let parts: Vec<&str> = raw_title.split(sep).collect();
            if parts.len() >= 2 {
                raw_artist = parts[0].trim().to_string();
                raw_title = parts[1..].join(sep).trim().to_string();
                break;
            }
        }
    }

    let clean_t = clean_title(&raw_title);
    let clean_a = clean_artist(&raw_artist);

    let cache_key = format!("{}:{}", clean_a.to_lowercase(), clean_t.to_lowercase());
    if let Ok(cache) = state.lyrics_cache.lock() {
        if let Some((resp, _)) = cache.get(&cache_key) {
            return Ok(Json(resp.clone()));
        }
    }

    let client = reqwest::Client::new();

    // 1. Try LRCLIB
    if let Some(resp) = fetch_lrclib(&client, &clean_t, &clean_a, params.duration).await {
        if let Ok(mut cache) = state.lyrics_cache.lock() {
            cache.insert(cache_key, (resp.clone(), Instant::now()));
        }
        return Ok(Json(resp));
    }

    // 2. Try Kugou (covers almost all Russian & Western tracks)
    if let Some(resp) = fetch_kugou(&client, &clean_t, &clean_a, params.duration).await {
        if let Ok(mut cache) = state.lyrics_cache.lock() {
            cache.insert(cache_key, (resp.clone(), Instant::now()));
        }
        return Ok(Json(resp));
    }

    Err(StatusCode::NOT_FOUND)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_calc_match_score_rejects_wrong_artist() {
        // "Cold" by "BoyWithUke" vs "Cold Water" by "Major Lazer"
        let score = calc_match_score(
            "Cold",
            "BoyWithUke",
            Some(180.0),
            "Cold Water",
            "Major Lazer",
            Some(185.0),
            true,
        );
        assert_eq!(score, 0.0, "Must reject different artist!");
    }

    #[test]
    fn test_calc_match_score_accepts_correct_track() {
        let score = calc_match_score(
            "Without Me",
            "Eminem",
            Some(290.0),
            "Without Me",
            "Eminem",
            Some(290.0),
            true,
        );
        assert!(score >= 80.0, "Score should be >= 80, got {}", score);
    }

    #[test]
    fn test_calc_match_score_rejects_huge_duration_diff() {
        let score = calc_match_score(
            "Without Me",
            "Eminem",
            Some(290.0),
            "Without Me",
            "Eminem",
            Some(120.0),
            true,
        );
        assert_eq!(score, 0.0, "Must reject > 45s duration diff!");
    }
}
