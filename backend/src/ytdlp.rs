use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncBufReadExt;
use tokio::process::Command;

use crate::config::{apply_yt_dlp_common_args, CLOUD_FALLBACK_URL};
use crate::models::SearchTrack;

fn is_curator_or_label(s: &str) -> bool {
    let lower = s.to_lowercase();
    matches!(
        lower.as_str(),
        "rhymes music" | "trap city" | "trap nation" | "bass nation" | "cinderella"
        | "chill nation" | "warner music russia" | "warner music" | "black star"
        | "gazgolder" | "soyuz music" | "zhara music" | "первое музыкальное"
        | "dnk music" | "velvet music" | "zion music" | "hajime records"
        | "atlantic records" | "sony music" | "universal music" | "lofi girl"
        | "chilledcow" | "mrsuicidesheep" | "7clouds" | "syrebralvibes"
    )
}

fn strip_video_title_noise(title: &str) -> String {
    let mut s = title.to_string();

    let noise_patterns = [
        "official music video", "official video", "official audio", "official visualizer",
        "music video", "lyric video", "lyrics video", "lyrics", "visualizer", "audio",
        "clip officiel", "remastered 4k", "remastered", "4k", "hd", "hq", "60fps",
        "премьера клипа", "премьера песни", "премьера трека", "премьера", "клип", "новинка", "хит",
        "slowed + reverb", "slowed & reverb", "slowed reverb", "slowed", "reverb",
        "speed up", "sped up", "bass boosted", "mood video", "live performance", "live at", "live",
        "full album", "album version", "audio track", "prod by", "prod. by", "produced by",
    ];

    let mut lower = s.to_lowercase();
    for word in noise_patterns {
        while let Some(idx) = lower.find(word) {
            let start = s[..idx].rfind(|c| c == '(' || c == '[' || c == '{');
            let end = s[idx..].find(|c| c == ')' || c == ']' || c == '}').map(|e| idx + e);

            if let (Some(b_start), Some(b_end)) = (start, end) {
                if b_end >= idx + word.len() && !s[b_start..=b_end].contains('\n') {
                    s.replace_range(b_start..=b_end, " ");
                    lower = s.to_lowercase();
                    continue;
                }
            }

            s.replace_range(idx..idx + word.len(), " ");
            lower = s.to_lowercase();
        }
    }

    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub fn clean_youtube_title_and_artist(
    raw_track: Option<&str>,
    raw_artist: Option<&str>,
    raw_title: &str,
    uploader: Option<&str>,
) -> (String, String) {
    // 1. Приоритет официальным метаданным Content ID / YouTube Music
    if let (Some(t), Some(a)) = (raw_track, raw_artist) {
        let ct = t.trim();
        let ca = a.trim();
        if !ct.is_empty() && !ca.is_empty() {
            return (ct.to_string(), ca.to_string());
        }
    }

    let mut artist = raw_artist.unwrap_or("").trim().to_string();
    let mut title = raw_track.unwrap_or("").trim().to_string();

    // 2. Если название не задано через Content ID — парсим raw_title
    if title.is_empty() {
        let mut s = raw_title.trim().to_string();

        if let Some(pipe) = s.find('|') {
            s.truncate(pipe);
        }
        if let Some(slash) = s.find("//") {
            s.truncate(slash);
        }

        let separators = [" - ", " – ", " — ", " : "];
        let mut found_split = false;
        for sep in separators {
            if s.contains(sep) {
                let parts: Vec<&str> = s.split(sep).collect();
                if parts.len() >= 2 {
                    let cand_artist = parts[0].trim();
                    let mut final_artist = cand_artist.to_string();
                    let mut final_title = parts[1..].join(sep).trim().to_string();

                    // Если cand_artist это лейбл/канал — смотрим, нет ли настоящего артиста внутри final_title
                    if is_curator_or_label(cand_artist) {
                        for sub_sep in separators {
                            if final_title.contains(sub_sep) {
                                let sub_parts: Vec<String> = final_title
                                    .split(sub_sep)
                                    .map(|p| p.trim().to_string())
                                    .collect();
                                if sub_parts.len() >= 2 {
                                    final_artist = sub_parts[0].clone();
                                    final_title = sub_parts[1..].join(sub_sep);
                                    break;
                                }
                            }
                        }
                    }

                    if !final_artist.is_empty() && !final_title.is_empty() {
                        if artist.is_empty() || is_curator_or_label(&artist) {
                            artist = final_artist;
                        }
                        title = final_title;
                        found_split = true;
                        break;
                    }
                }
            }
        }

        if !found_split {
            title = s;
        }
    }

    // 3. Fallback артиста на uploader
    if artist.is_empty() {
        if let Some(u) = uploader {
            artist = u.trim().to_string();
        }
    }

    // 4. Очистка артиста от суффиксов каналов
    let artist_noise = [" - Topic", " Topic", "VEVO", " Vevo", " Official", " Records", " Music", " Channel", " Label"];
    for suf in artist_noise {
        if artist.ends_with(suf) {
            artist = artist.trim_end_matches(suf).trim().to_string();
        }
    }

    // 5. Очистка названия от шума видеоклипов
    title = strip_video_title_noise(&title);

    // 6. Очистка кавычек
    title = title.trim_matches(|c| c == '«' || c == '»' || c == '"' || c == '\'').trim().to_string();

    if title.is_empty() {
        title = "Без названия".to_string();
    }
    if artist.is_empty() {
        artist = "Неизвестный исполнитель".to_string();
    }

    (title, artist)
}

pub fn parse_track_json(item: &serde_json::Value, base_url: &str) -> Option<SearchTrack> {
    let id = if let Some(val) = item["id"].as_str() {
        val.to_string()
    } else if let Some(num) = item["id"].as_i64() {
        num.to_string()
    } else {
        return None;
    };

    if id.is_empty() {
        return None;
    }

    let raw_title = item["title"].as_str().unwrap_or("").trim();
    let raw_track = item["track"].as_str();
    let raw_artist = item["artist"].as_str().or_else(|| item["creator"].as_str());
    let uploader = item["uploader"].as_str().or_else(|| item["channel"].as_str());

    let (title, artist) = clean_youtube_title_and_artist(raw_track, raw_artist, raw_title, uploader);

    let duration = item["duration"].as_f64().unwrap_or(0.0);

    let track_url = if let Some(u) = item["webpage_url"].as_str() {
        u.to_string()
    } else if let Some(u) = item["url"].as_str() {
        if u.starts_with("http") {
            u.to_string()
        } else {
            format!("https://www.youtube.com/watch?v={}", id)
        }
    } else {
        format!("https://www.youtube.com/watch?v={}", id)
    };

    let mut cover_url = None;
    if let Some(thumbs) = item["thumbnails"].as_array() {
        if let Some(last) = thumbs.last() {
            if let Some(u) = last["url"].as_str() {
                cover_url = Some(u.to_string());
            }
        }
    }
    if cover_url.is_none() {
        if let Some(u) = item["thumbnail"].as_str() {
            cover_url = Some(u.to_string());
        }
    }

    let proxied_cover = cover_url.map(|u| {
        if u.contains("ytimg.com") {
            format!("{}/api/cover?url={}", base_url, urlencoding::encode(&u))
        } else {
            u
        }
    });

    let encoded_url = urlencoding::encode(&track_url);
    let encoded_title = urlencoding::encode(&title);
    let encoded_artist = urlencoding::encode(&artist);
    let audio_url = format!(
        "{}/api/stream?url={}&title={}&artist={}",
        base_url, encoded_url, encoded_title, encoded_artist
    );

    Some(SearchTrack {
        id,
        title,
        artist,
        duration,
        audio_url,
        cover_url: proxied_cover,
    })
}

pub async fn execute_yt_dlp_search(yt_cmd: &str, search_arg: &str, timeout_sec: u64, base_url: &str) -> Vec<SearchTrack> {
    let mut cmd = Command::new(yt_cmd);
    apply_yt_dlp_common_args(&mut cmd);
    cmd.args([
        "--dump-json",
        "--flat-playlist",
        "--playlist-end",
        "50",
        "--",
        search_arg,
    ])
    .stdout(Stdio::piped())
    .stderr(Stdio::null());

    let mut tracks = Vec::new();

    let spawn_res = cmd.spawn();
    if let Ok(mut child) = spawn_res {
        if let Some(stdout) = child.stdout.take() {
            let mut reader = tokio::io::BufReader::new(stdout).lines();
            let read_task = async {
                while let Ok(Some(line)) = reader.next_line().await {
                    if let Ok(item) = serde_json::from_str::<serde_json::Value>(&line) {
                        if let Some(track) = parse_track_json(&item, base_url) {
                            tracks.push(track);
                        }
                    }
                }
            };
            let _ = tokio::time::timeout(Duration::from_secs(timeout_sec), read_task).await;
        }
        let _ = child.kill().await;
    }

    tracks
}

pub async fn execute_cloud_search(query: &str, base_url: &str) -> Vec<SearchTrack> {
    let cloud_url = format!("{}/api/search?q={}", CLOUD_FALLBACK_URL, urlencoding::encode(query));
    let client = match reqwest::Client::builder().timeout(Duration::from_secs(5)).build() {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };

    if let Ok(resp) = client.get(&cloud_url).send().await {
        if resp.status().is_success() {
            if let Ok(bytes) = resp.bytes().await {
                if let Ok(mut list) = serde_json::from_slice::<Vec<SearchTrack>>(&bytes) {
                    for t in &mut list {
                        if t.audio_url.contains("/api/stream") {
                            let stream_idx = t.audio_url.find("/api/stream").unwrap();
                            t.audio_url = format!("{}{}", base_url, &t.audio_url[stream_idx..]);
                        }
                    }
                    return list;
                }
            }
        }
    }

    Vec::new()
}
