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
        "премьера песни", "клип", "новинка", "хит", "slowed + reverb", "slowed & reverb",
        "slowed reverb", "slowed", "reverb", "speed up", "sped up", "bass boosted",
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
    let noise = ["topic", "vevo", "records", "music", "official", "channel", "label"];
    let mut lower = s.to_lowercase();
    for word in noise {
        while let Some(idx) = lower.find(word) {
            s.replace_range(idx..idx + word.len(), " ");
            lower.replace_range(idx..idx + word.len(), " ");
        }
    }
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub fn extract_primary_artist(artist: &str) -> String {
    let feat_markers = [
        " feat. ", " feat ", " ft. ", " ft ", " featuring ",
        " with ", " при уч. ", " при уч ", " с участием ",
    ];
    let mut s = artist.to_string();
    let lower = s.to_lowercase();
    for marker in feat_markers {
        if let Some(idx) = lower.find(marker) {
            s.truncate(idx);
            break;
        }
    }
    clean_artist(&s)
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

fn check_translit_artist_match(exp: &str, cand: &str) -> bool {
    let pairs = [
        ("эндшпиль", "endspiel"),
        ("эндшпиль", "andy panda"),
        ("скриптонит", "scriptonite"),
        ("баста", "basta"),
        ("кино", "kino"),
        ("оксимирон", "oxxxymiron"),
        ("макс корж", "max korzh"),
        ("моргенштерн", "morgenshtern"),
        ("лсп", "lsp"),
        ("хаски", "husky"),
        ("би 2", "bi 2"),
        ("би-2", "bi-2"),
        ("король и шут", "korol i shut"),
        ("земфира", "zemfira"),
        ("миджи", "miyagi"),
        ("мияги", "miyagi"),
    ];
    for (ru, en) in pairs {
        if (exp.contains(ru) && cand.contains(en)) || (exp.contains(en) && cand.contains(ru)) {
            return true;
        }
    }
    false
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

    // 1. Duration check: strict rejection if > 45s diff, bonus for close match
    let mut dur_penalty = 0.0;
    let mut dur_bonus = 0.0;
    if let (Some(ed), Some(cd)) = (exp_dur, cand_dur) {
        if ed > 20.0 && cd > 20.0 {
            let diff = (ed - cd).abs();
            if diff > 45.0 {
                return 0.0;
            }
            if diff <= 2.5 {
                dur_bonus = 25.0; // Near-identical audio cut / mastering
            } else if diff <= 6.0 {
                dur_bonus = 15.0;
            } else if diff <= 12.0 {
                dur_bonus = 5.0;
            }
            if diff > 15.0 {
                dur_penalty = (diff - 15.0) * 0.8;
            }
        }
    }

    // 2. Title matching
    let is_swapped = (!exp_a.is_empty() && (cand_t.contains(&exp_a) || exp_a.contains(&cand_t)))
        && (cand_a.contains(&exp_t) || exp_t.contains(&cand_a));

    let exp_words: Vec<&str> = exp_t.split_whitespace().filter(|w| w.len() >= 2).collect();
    let cand_words: Vec<&str> = cand_t.split_whitespace().filter(|w| w.len() >= 2).collect();
    let exp_a_words: Vec<&str> = exp_a.split_whitespace().filter(|w| w.len() >= 2).collect();

    let title_ratio: f64;
    let title_score = if exp_t == cand_t || is_swapped {
        title_ratio = 1.0;
        50.0
    } else if exp_words.len() == 1 {
        let target_word = exp_words[0];
        if cand_words.contains(&target_word) {
            let extra_non_noise = cand_words.iter().filter(|w| **w != target_word && !is_noise_word(w) && !exp_a_words.contains(w)).count();
            if extra_non_noise == 0 {
                title_ratio = 1.0;
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
        title_ratio = matched_words as f64 / exp_words.len().max(1) as f64;
        if title_ratio < 0.45 {
            return 0.0;
        }
        title_ratio * 45.0
    };

    // 3. Artist matching
    let mut artist_matched = false;
    let mut artist_score = 0.0;

    if is_swapped {
        artist_matched = true;
        artist_score = 30.0;
    } else if !exp_a.is_empty() && !cand_a.is_empty() {
        if exp_a == cand_a || cand_a.contains(&exp_a) || exp_a.contains(&cand_a) {
            artist_matched = true;
            artist_score = 30.0;
        } else if check_translit_artist_match(&exp_a, &cand_a) {
            artist_matched = true;
            artist_score = 30.0;
        } else {
            let cand_a_words: Vec<&str> = cand_a.split_whitespace().filter(|w| w.len() >= 2).collect();
            let mut matched_a = 0;
            for ew in &exp_a_words {
                if cand_a_words.iter().any(|cw| cw.contains(ew) || ew.contains(cw)) {
                    matched_a += 1;
                }
            }
            if matched_a > 0 {
                artist_matched = true;
                artist_score = 25.0 * (matched_a as f64 / exp_a_words.len().max(1) as f64);
            }
        }
    } else if exp_a.is_empty() {
        artist_matched = true;
        artist_score = 15.0;
    }

    if !artist_matched {
        // Если артист был задан, но не совпал — строго отвергаем, чтобы не брать чужой текст
        if !exp_a.is_empty() {
            return 0.0;
        }
    }

    let synced_bonus = if has_synced { 20.0 } else { 0.0 };

    (artist_score + title_score + synced_bonus + dur_bonus - dur_penalty).max(0.0)
}

async fn fetch_lrclib(
    client: &reqwest::Client,
    title: &str,
    artist: &str,
    duration: Option<f64>,
) -> Option<LyricsResponse> {
    let primary_a = extract_primary_artist(artist);
    let mut queries = Vec::new();
    if !primary_a.is_empty() {
        queries.push(format!("track_name={}&artist_name={}", urlencoding::encode(title), urlencoding::encode(&primary_a)));
        queries.push(format!("q={}", urlencoding::encode(&format!("{} {}", primary_a, title))));
        queries.push(format!("q={}", urlencoding::encode(&format!("{} {}", title, primary_a))));
    }
    if !artist.is_empty() && artist != primary_a {
        queries.push(format!("track_name={}&artist_name={}", urlencoding::encode(title), urlencoding::encode(artist)));
        queries.push(format!("q={}", urlencoding::encode(&format!("{} {}", artist, title))));
        queries.push(format!("q={}", urlencoding::encode(&format!("{} {}", title, artist))));
    }
    // Ищем только по названию ТОЛЬКО если артист не был передан вообще
    if primary_a.is_empty() && artist.is_empty() {
        queries.push(format!("q={}", urlencoding::encode(title)));
    }

    let mut best_synced: Option<(f64, LyricsResponse)> = None;
    let mut best_plain: Option<(f64, LyricsResponse)> = None;

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
                            let plain = it["plainLyrics"].as_str().unwrap_or("").trim();
                            let has_synced = !synced.is_empty();

                            let score = calc_match_score(title, artist, duration, cand_title, cand_artist, cand_dur, has_synced);
                            if score >= 55.0 && has_synced {
                                if best_synced.as_ref().map_or(true, |(best_s, _)| score > *best_s) {
                                    best_synced = Some((
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
                            } else if score >= 55.0 && !plain.is_empty() && best_synced.is_none() {
                                if best_plain.as_ref().map_or(true, |(best_s, _)| score > *best_s) {
                                    best_plain = Some((
                                        score,
                                        LyricsResponse {
                                            synced: false,
                                            lyrics: plain.to_string(),
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
                    let plain = it["plainLyrics"].as_str().unwrap_or("").trim();
                    let has_synced = !synced.is_empty();

                    let score = calc_match_score(title, artist, duration, cand_title, cand_artist, cand_dur, has_synced);
                    if score >= 55.0 && has_synced {
                        return Some(LyricsResponse {
                            synced: true,
                            lyrics: synced.to_string(),
                            source: "lrclib".to_string(),
                            track_name: Some(cand_title.to_string()),
                            artist_name: Some(cand_artist.to_string()),
                            duration: cand_dur,
                        });
                    } else if score >= 55.0 && !plain.is_empty() && best_plain.is_none() {
                        best_plain = Some((
                            score,
                            LyricsResponse {
                                synced: false,
                                lyrics: plain.to_string(),
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
        if let Some((score, resp)) = &best_synced {
            if *score >= 70.0 {
                return Some(resp.clone());
            }
        }
    }

    best_synced.map(|(_, resp)| resp).or_else(|| best_plain.map(|(_, resp)| resp))
}

async fn fetch_kugou(
    client: &reqwest::Client,
    title: &str,
    artist: &str,
    duration: Option<f64>,
) -> Option<LyricsResponse> {
    let primary_a = extract_primary_artist(artist);
    let mut queries = Vec::new();
    if !primary_a.is_empty() {
        queries.push(format!("{} {}", primary_a, title));
    }
    if !artist.is_empty() && artist != primary_a {
        queries.push(format!("{} {}", artist, title));
    }
    queries.push(title.to_string());

    for query in queries {
        let search_url = format!(
            "http://mobilecdn.kugou.com/api/v3/search/song?format=json&keyword={}&page=1&pagesize=5",
            urlencoding::encode(&query)
        );

        let res = match client
            .get(&search_url)
            .header("User-Agent", "Mozilla/5.0")
            .timeout(std::time::Duration::from_millis(3000))
            .send()
            .await
        {
            Ok(r) => r,
            Err(_) => continue,
        };

        let json: serde_json::Value = match res.json().await {
            Ok(j) => j,
            Err(_) => continue,
        };
        let songs = match json["data"]["info"].as_array() {
            Some(s) if !s.is_empty() => s,
            _ => continue,
        };

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

async fn fetch_deezer_metadata(
    client: &reqwest::Client,
    title: &str,
    artist: &str,
) -> Option<(String, String, f64)> {
    let query = if !artist.is_empty() {
        format!("{} {}", artist, title)
    } else {
        title.to_string()
    };

    let url = format!(
        "https://api.deezer.com/search?q={}&limit=1",
        urlencoding::encode(&query)
    );

    let res = client
        .get(&url)
        .header("User-Agent", "Mozilla/5.0")
        .timeout(std::time::Duration::from_millis(2000))
        .send()
        .await
        .ok()?;

    let json: serde_json::Value = res.json().await.ok()?;
    let item = json["data"].as_array()?.first()?;

    let d_title = item["title"].as_str().unwrap_or("").trim();
    let d_artist = item["artist"]["name"].as_str().unwrap_or("").trim();
    let d_dur = item["duration"].as_f64().unwrap_or(0.0);

    if !d_title.is_empty() && !d_artist.is_empty() {
        let t_norm = clean_title(title).to_lowercase();
        let d_norm = d_title.to_lowercase();
        let words: Vec<&str> = t_norm.split_whitespace().filter(|w| w.len() >= 2).collect();
        if words.is_empty() || words.iter().any(|w| d_norm.contains(w)) || d_norm.contains(&t_norm) {
            return Some((d_title.to_string(), d_artist.to_string(), d_dur));
        }
    }

    None
}

async fn fetch_netease(
    client: &reqwest::Client,
    title: &str,
    artist: &str,
    duration: Option<f64>,
) -> Option<LyricsResponse> {
    let mut queries = Vec::new();
    if !artist.is_empty() {
        queries.push(format!("{} {}", artist, title));
    }
    queries.push(title.to_string());

    for query in queries {
        let search_url = format!(
            "https://music.163.com/api/search/get?s={}&type=1&limit=5",
            urlencoding::encode(&query)
        );

        let res = client
            .get(&search_url)
            .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36")
            .header("Referer", "https://music.163.com")
            .timeout(std::time::Duration::from_millis(2500))
            .send()
            .await
            .ok();

        let res = match res {
            Some(r) => r,
            None => continue,
        };

        let json: serde_json::Value = match res.json().await {
            Ok(j) => j,
            Err(_) => continue,
        };
        let songs = match json["result"]["songs"].as_array() {
            Some(s) if !s.is_empty() => s,
            _ => continue,
        };

        for song in songs {
            let cand_id = match song["id"].as_i64() {
                Some(id) => id,
                None => continue,
            };
            let cand_title = song["name"].as_str().unwrap_or("");
            let cand_artist = song["artists"]
                .as_array()
                .and_then(|a| a.first())
                .and_then(|a| a["name"].as_str())
                .unwrap_or("");
            let cand_dur = song["duration"].as_f64().map(|ms| ms / 1000.0);

            let score = calc_match_score(title, artist, duration, cand_title, cand_artist, cand_dur, true);
            if score < 45.0 {
                continue;
            }

            let lrc_url = format!(
                "https://music.163.com/api/song/lyric?os=pc&id={}&lv=-1&kv=-1&tv=-1",
                cand_id
            );
            let lrc_res = client
                .get(&lrc_url)
                .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36")
                .header("Referer", "https://music.163.com")
                .timeout(std::time::Duration::from_millis(2500))
                .send()
                .await
                .ok();

            if let Some(resp) = lrc_res {
                if let Ok(lrc_json) = resp.json::<serde_json::Value>().await {
                    let raw_lrc = lrc_json["lrc"]["lyric"].as_str().unwrap_or("").trim();

                    if raw_lrc.contains('[') && raw_lrc.contains(']') && raw_lrc.len() > 30 {
                        return Some(LyricsResponse {
                            synced: true,
                            lyrics: raw_lrc.to_string(),
                            source: "netease".to_string(),
                            track_name: Some(cand_title.to_string()),
                            artist_name: Some(cand_artist.to_string()),
                            duration: cand_dur,
                        });
                    }
                }
            }
        }
    }

    None
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

    let mut clean_t = clean_title(&raw_title);
    let mut clean_a = clean_artist(&raw_artist);
    let mut target_duration = params.duration;

    let cache_key = format!("{}:{}", clean_a.to_lowercase(), clean_t.to_lowercase());
    if let Ok(cache) = state.lyrics_cache.lock() {
        if let Some((resp, _)) = cache.get(&cache_key) {
            return Ok(Json(resp.clone()));
        }
    }

    let client = reqwest::Client::new();

    // Быстрая студийная нормализация метаданных через Deezer API (чистые названия, студийный хрон)
    if let Some((d_title, d_artist, d_dur)) = fetch_deezer_metadata(&client, &clean_t, &clean_a).await {
        if !d_title.is_empty() {
            clean_t = d_title;
        }
        if !d_artist.is_empty() {
            clean_a = d_artist;
        }
        if target_duration.is_none() || target_duration == Some(0.0) {
            target_duration = Some(d_dur);
        }
    }

    // 1. Try LRCLIB (Clean studio metadata)
    if let Some(resp) = fetch_lrclib(&client, &clean_t, &clean_a, target_duration).await {
        if let Ok(mut cache) = state.lyrics_cache.lock() {
            cache.insert(cache_key, (resp.clone(), Instant::now()));
        }
        return Ok(Json(resp));
    }

    // 2. Try NetEase Cloud Music (гигантская база караоке: русский рэп, поп, инди, мировые хиты)
    if let Some(resp) = fetch_netease(&client, &clean_t, &clean_a, target_duration).await {
        if let Ok(mut cache) = state.lyrics_cache.lock() {
            cache.insert(cache_key, (resp.clone(), Instant::now()));
        }
        return Ok(Json(resp));
    }

    // 3. Try Kugou
    if let Some(resp) = fetch_kugou(&client, &clean_t, &clean_a, target_duration).await {
        if let Ok(mut cache) = state.lyrics_cache.lock() {
            cache.insert(cache_key, (resp.clone(), Instant::now()));
        }
        return Ok(Json(resp));
    }

    Err(StatusCode::NOT_FOUND)
}

#[derive(Debug, Deserialize)]
pub struct TrackMetaQuery {
    pub id: Option<String>,
    pub title: Option<String>,
    pub artist: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct TrackMetaRecord {
    pub track_id: String,
    pub title: String,
    pub artist: String,
    pub duration: Option<f64>,
    pub bpm: Option<f64>,
    pub lyrics_offset_ms: Option<i64>,
    pub synced_lyrics: Option<String>,
    pub updated_at: i64,
}

#[derive(Debug, Deserialize)]
pub struct TrackMetaPayload {
    pub track_id: String,
    pub title: String,
    pub artist: String,
    pub duration: Option<f64>,
    pub bpm: Option<f64>,
    pub lyrics_offset_ms: Option<i64>,
    pub synced_lyrics: Option<String>,
}

pub async fn get_track_meta(
    State(state): State<AppState>,
    Query(query): Query<TrackMetaQuery>,
) -> Result<Json<Option<TrackMetaRecord>>, StatusCode> {
    if let Some(id) = query.id.as_deref() {
        if !id.trim().is_empty() {
            let res = sqlx::query_as::<_, TrackMetaRecord>(
                "SELECT track_id, title, artist, duration, bpm, lyrics_offset_ms, synced_lyrics, updated_at FROM track_meta WHERE track_id = ?"
            )
            .bind(id.trim())
            .fetch_optional(&state.pool)
            .await
            .map_err(|e| {
                eprintln!("[TrackMeta] Error getting by id: {}", e);
                StatusCode::INTERNAL_SERVER_ERROR
            })?;

            if res.is_some() {
                return Ok(Json(res));
            }
        }
    }

    if let (Some(title), Some(artist)) = (query.title.as_deref(), query.artist.as_deref()) {
        let clean_t = clean_title(title);
        let clean_a = clean_artist(artist);
        if !clean_t.is_empty() {
            let res = sqlx::query_as::<_, TrackMetaRecord>(
                "SELECT track_id, title, artist, duration, bpm, lyrics_offset_ms, synced_lyrics, updated_at FROM track_meta WHERE title LIKE ? AND artist LIKE ? LIMIT 1"
            )
            .bind(format!("%{}%", clean_t))
            .bind(format!("%{}%", clean_a))
            .fetch_optional(&state.pool)
            .await
            .map_err(|e| {
                eprintln!("[TrackMeta] Error getting by title/artist: {}", e);
                StatusCode::INTERNAL_SERVER_ERROR
            })?;

            return Ok(Json(res));
        }
    }

    Ok(Json(None))
}

pub async fn save_track_meta(
    State(state): State<AppState>,
    Json(payload): Json<TrackMetaPayload>,
) -> Result<StatusCode, StatusCode> {
    let now = chrono::Utc::now().timestamp();
    let track_id = payload.track_id.trim();
    if track_id.is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }

    sqlx::query(
        r#"
        INSERT INTO track_meta (track_id, title, artist, duration, bpm, lyrics_offset_ms, synced_lyrics, updated_at)
        VALUES (?, ?, ?, ?, ?, COALESCE(?, 0), ?, ?)
        ON CONFLICT(track_id) DO UPDATE SET
            title = excluded.title,
            artist = excluded.artist,
            duration = CASE WHEN excluded.duration > 0.0 THEN excluded.duration ELSE track_meta.duration END,
            bpm = CASE WHEN excluded.bpm IS NOT NULL THEN excluded.bpm ELSE track_meta.bpm END,
            lyrics_offset_ms = CASE WHEN excluded.lyrics_offset_ms IS NOT NULL THEN excluded.lyrics_offset_ms ELSE track_meta.lyrics_offset_ms END,
            synced_lyrics = CASE WHEN excluded.synced_lyrics IS NOT NULL THEN excluded.synced_lyrics ELSE track_meta.synced_lyrics END,
            updated_at = excluded.updated_at
        "#
    )
    .bind(track_id)
    .bind(payload.title.trim())
    .bind(payload.artist.trim())
    .bind(payload.duration.unwrap_or(0.0))
    .bind(payload.bpm)
    .bind(payload.lyrics_offset_ms)
    .bind(payload.synced_lyrics)
    .bind(now)
    .execute(&state.pool)
    .await
    .map_err(|e| {
        eprintln!("[TrackMeta] Error saving: {}", e);
        StatusCode::INTERNAL_SERVER_ERROR
    })?;

    Ok(StatusCode::OK)
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

    #[test]
    fn test_calc_match_score_accepts_multiword_title_with_uploader_channel() {
        // Track: "люблю москву но снится london"
        // Expected artist: "wastedheart" (YouTube channel)
        // Candidate artist: "vers1zee" (Real artist on LRCLIB)
        let score = calc_match_score(
            "люблю москву но снится london",
            "wastedheart",
            Some(140.0),
            "люблю москву но снится london",
            "vers1zee",
            Some(140.0),
            true,
        );
        assert!(score >= 60.0, "Multi-word exact title match must be accepted, score: {}", score);
    }
}
