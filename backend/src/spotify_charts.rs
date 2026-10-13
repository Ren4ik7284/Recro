use crate::models::ChartArtist;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;

static CHARTS_CACHE: LazyLock<RwLock<Option<Vec<ChartArtist>>>> =
    LazyLock::new(|| RwLock::new(None));
static LAST_FETCH: LazyLock<RwLock<Option<Instant>>> =
    LazyLock::new(|| RwLock::new(None));

const CACHE_TTL_SECS: u64 = 6 * 3600; // 6 hours

fn get_cache_path() -> PathBuf {
    if Path::new("/data").exists() {
        PathBuf::from("/data/spotify_top_artists.json")
    } else {
        PathBuf::from("spotify_top_artists.json")
    }
}

fn unescape_html(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&quot;", "\"")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
}

fn strip_tags(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut inside = false;
    for ch in input.chars() {
        if ch == '<' {
            inside = true;
        } else if ch == '>' {
            inside = false;
        } else if !inside {
            out.push(ch);
        }
    }
    unescape_html(out.trim())
}

struct ParsedRawArtist {
    position: usize,
    name: String,
    spotify_id: Option<String>,
    monthly_listeners: Option<String>,
    daily_diff: Option<String>,
    peak: Option<String>,
}

fn parse_kworb_html(html: &str) -> Vec<ParsedRawArtist> {
    let mut results = Vec::new();

    let tbody_start = match html.find("<tbody") {
        Some(idx) => idx,
        None => return results,
    };
    let tbody_content = match html[tbody_start..].find('>') {
        Some(idx) => &html[tbody_start + idx + 1..],
        None => return results,
    };
    let tbody = match tbody_content.find("</tbody>") {
        Some(idx) => &tbody_content[..idx],
        None => tbody_content,
    };

    for row_block in tbody.split("<tr>") {
        let row = match row_block.find("</tr>") {
            Some(end) => &row_block[..end],
            None => continue,
        };

        let mut cells = Vec::new();
        let mut cur = row;
        while let Some(td_start) = cur.find("<td") {
            let after_td = &cur[td_start..];
            let cell_start = match after_td.find('>') {
                Some(idx) => idx + 1,
                None => break,
            };
            let content = &after_td[cell_start..];
            let cell_end = match content.find("</td>") {
                Some(idx) => idx,
                None => break,
            };
            cells.push(&content[..cell_end]);
            cur = &content[cell_end + 5..];
        }

        if cells.len() < 3 {
            continue;
        }

        // Cell 0: Rank (position)
        let pos_str = cells[0].trim();
        let position = match pos_str.parse::<usize>() {
            Ok(p) => p,
            Err(_) => continue,
        };

        // Cell 1: Artist name and Spotify link
        let cell1 = cells[1];
        let spotify_id = if let Some(href_pos) = cell1.find("href=\"") {
            let after_href = &cell1[href_pos + 6..];
            if let Some(href_end) = after_href.find('"') {
                let href = &after_href[..href_end];
                if let Some(art_idx) = href.find("artist/") {
                    let id_part = &href[art_idx + 7..];
                    let id_end = id_part.find('_').or_else(|| id_part.find('.')).unwrap_or(id_part.len());
                    Some(id_part[..id_end].to_string())
                } else {
                    None
                }
            } else {
                None
            }
        } else {
            None
        };

        let name = if let Some(a_start) = cell1.find("<a ") {
            if let Some(tag_close) = cell1[a_start..].find('>') {
                let inside_a = &cell1[a_start + tag_close + 1..];
                if let Some(a_end) = inside_a.find("</a>") {
                    unescape_html(inside_a[..a_end].trim())
                } else {
                    strip_tags(cell1)
                }
            } else {
                strip_tags(cell1)
            }
        } else {
            strip_tags(cell1)
        };

        if name.is_empty() {
            continue;
        }

        // Cell 2: Monthly listeners
        let listeners = if cells.len() > 2 {
            let l = strip_tags(cells[2]).trim().to_string();
            if l.is_empty() { None } else { Some(l) }
        } else {
            None
        };

        // Cell 3: Daily diff
        let daily_diff = if cells.len() > 3 {
            let d = strip_tags(cells[3]).trim().to_string();
            if d.is_empty() { None } else { Some(d) }
        } else {
            None
        };

        // Cell 4: Peak
        let peak = if cells.len() > 4 {
            let p = strip_tags(cells[4]).trim().to_string();
            if p.is_empty() { None } else { Some(p) }
        } else {
            None
        };

        results.push(ParsedRawArtist {
            position,
            name,
            spotify_id,
            monthly_listeners: listeners,
            daily_diff,
            peak,
        });

        if results.len() >= 50 {
            break;
        }
    }

    results
}

async fn fetch_spotify_image(client: &reqwest::Client, spotify_id: &str) -> Option<String> {
    let url = format!("https://open.spotify.com/embed/artist/{}", spotify_id);
    let resp = client.get(&url).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let text = resp.text().await.ok()?;
    let marker = "\"image\":[";
    let start = text.find(marker)?;
    let slice = &text[start..];
    let url_marker = "\"url\":\"";
    let url_start = slice.find(url_marker)?;
    let url_slice = &slice[url_start + url_marker.len()..];
    let url_end = url_slice.find('"')?;
    let found_url = &url_slice[..url_end];
    let upgraded = found_url
        .replace("ab67616100005174", "ab6761610000e5eb")
        .replace("ab6761610000f178", "ab6761610000e5eb");
    Some(upgraded)
}

async fn fetch_deezer_image(client: &reqwest::Client, name: &str) -> Option<String> {
    let url = format!(
        "https://api.deezer.com/search/artist?q={}",
        urlencoding::encode(name)
    );
    let resp = client.get(&url).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let data: serde_json::Value = resp.json().await.ok()?;
    let first = data.get("data")?.as_array()?.first()?;
    first
        .get("picture_big")
        .or_else(|| first.get("picture_medium"))
        .or_else(|| first.get("picture"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

fn load_cache_from_disk() -> Option<Vec<ChartArtist>> {
    let path = get_cache_path();
    if path.exists() {
        if let Ok(content) = fs::read_to_string(&path) {
            if let Ok(artists) = serde_json::from_str::<Vec<ChartArtist>>(&content) {
                if !artists.is_empty() {
                    return Some(artists);
                }
            }
        }
    }
    None
}

fn save_cache_to_disk(artists: &[ChartArtist]) {
    let path = get_cache_path();
    if let Ok(json) = serde_json::to_string_pretty(artists) {
        let _ = fs::write(path, json);
    }
}

pub fn get_fallback_artists() -> Vec<ChartArtist> {
    let fallbacks = [
        (1, "Bruno Mars", "0du5cEVh5yTK9QJze8zA0C", "129,781,010", "+12,500", "1"),
        (2, "Rihanna", "5pKCCKE2ajJHZ9KAiaK11H", "116,192,743", "+15,798", "2"),
        (3, "The Weeknd", "1Xyo4u8uXC1ZmMpatF05PJ", "116,119,078", "+17,256", "1"),
        (4, "Justin Bieber", "1uNFoZAHBGtllmzznpCI3s", "112,569,493", "-14,886", "1"),
        (5, "Taylor Swift", "06HL4z0CvFAxyc27GXpf02", "106,764,975", "+41,570", "1"),
        (6, "Lady Gaga", "1HY2Jd0NmPuamShAr6KMms", "100,351,565", "+67,876", "2"),
        (7, "Drake", "3TVXtAsR1Inumwj472S9r4", "94,830,461", "-21,657", "3"),
        (8, "Coldplay", "4gzpq5DPGxSnKTe4SA8HAU", "94,648,892", "-11,761", "4"),
        (9, "Ariana Grande", "66CXWjxzNUsdJxJ2JdwvnR", "93,433,118", "-21,152", "1"),
        (10, "Bad Bunny", "4q3ewBCX7sLwd24euuV69X", "92,736,570", "+18,738", "2"),
        (11, "Shakira", "0EmeFodog0BfCgMzAIvKQp", "90,703,615", "-48,542", "3"),
        (12, "Katy Perry", "6jJ0s89eD6GaHleKKya26X", "88,450,098", "-10,289", "12"),
        (13, "Michael Jackson", "3fMbdgg4jU18AjLCKBhRSm", "87,128,519", "-15,163", "4"),
        (14, "David Guetta", "1Cs0zKBU1kc0i8ypK3B9ai", "82,869,208", "-4,032", "4"),
        (15, "Billie Eilish", "6qqNVTkY8uBg9cP3Jd7DAH", "79,411,553", "+137,166", "1"),
        (16, "Ed Sheeran", "6eUKZXaKkcviH0Ku9w2n3V", "78,939,169", "-16,335", "2"),
        (17, "Dua Lipa", "6M2wZ9GZgrQXHCFfjv46we", "77,347,175", "-7,307", "3"),
        (18, "Eminem", "7dGJo4pcD2V6oG8kP0tJRR", "73,674,520", "-25,174", "5"),
        (19, "Kendrick Lamar", "2YZyLoL8N0Wb9xBt1NhZWg", "70,662,438", "+31,451", "4"),
        (20, "Post Malone", "246dkjvS1zLTtiykXe5h60", "65,845,025", "+14,738", "3"),
    ];

    fallbacks
        .into_iter()
        .map(|(pos, name, sp_id, monthly, daily, peak)| ChartArtist {
            position: pos,
            name: name.to_string(),
            picture: None,
            monthly_listeners: Some(monthly.to_string()),
            daily_diff: Some(daily.to_string()),
            peak: Some(peak.to_string()),
            spotify_id: Some(sp_id.to_string()),
        })
        .collect()
}

pub async fn update_spotify_charts() -> Result<Vec<ChartArtist>, String> {
    println!("[SpotifyCharts] Fetching latest daily chart from Kworb...");

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        .build()
        .map_err(|e| format!("Client build error: {}", e))?;

    let url = "https://kworb.net/spotify/listeners.html";
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("HTTP request error: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Bad status: {}", resp.status()));
    }

    let html = resp
        .text()
        .await
        .map_err(|e| format!("Body read error: {}", e))?;

    let raw_artists = parse_kworb_html(&html);
    if raw_artists.is_empty() {
        return Err("No artists parsed from Kworb HTML".to_string());
    }

    println!(
        "[SpotifyCharts] Successfully parsed {} artists from Kworb. Enriching covers...",
        raw_artists.len()
    );

    // Map existing pictures from cache to minimize network calls
    let mut existing_pictures = HashMap::new();
    {
        let guard = CHARTS_CACHE.read().await;
        if let Some(cached) = &*guard {
            for a in cached {
                if let Some(pic) = &a.picture {
                    existing_pictures.insert(a.name.to_lowercase(), pic.clone());
                }
            }
        }
    }
    if existing_pictures.is_empty() {
        if let Some(from_disk) = load_cache_from_disk() {
            for a in from_disk {
                if let Some(pic) = &a.picture {
                    existing_pictures.insert(a.name.to_lowercase(), pic.clone());
                }
            }
        }
    }

    let mut final_artists = Vec::with_capacity(raw_artists.len());

    for raw in raw_artists {
        let name_lower = raw.name.to_lowercase();
        let picture = if let Some(existing) = existing_pictures.get(&name_lower) {
            Some(existing.clone())
        } else {
            // Fetch picture: try Spotify embed first, then Deezer
            let sp_pic = if let Some(ref sp_id) = raw.spotify_id {
                fetch_spotify_image(&client, sp_id).await
            } else {
                None
            };

            if sp_pic.is_some() {
                sp_pic
            } else {
                fetch_deezer_image(&client, &raw.name).await
            }
        };

        final_artists.push(ChartArtist {
            position: raw.position,
            name: raw.name,
            picture,
            monthly_listeners: raw.monthly_listeners,
            daily_diff: raw.daily_diff,
            peak: raw.peak,
            spotify_id: raw.spotify_id,
        });
    }

    // Save to cache
    {
        let mut guard = CHARTS_CACHE.write().await;
        *guard = Some(final_artists.clone());
    }
    {
        let mut last_guard = LAST_FETCH.write().await;
        *last_guard = Some(Instant::now());
    }

    save_cache_to_disk(&final_artists);
    println!(
        "[SpotifyCharts] Successfully updated {} Spotify daily top artists!",
        final_artists.len()
    );

    Ok(final_artists)
}

pub async fn get_cached_spotify_top_artists(force: bool) -> Vec<ChartArtist> {
    // 1. If not force, check in-memory cache
    if !force {
        let guard = CHARTS_CACHE.read().await;
        if let Some(cached) = &*guard {
            if !cached.is_empty() {
                return cached.clone();
            }
        }
    }

    // 2. Check disk cache if in-memory empty and not force
    if !force {
        if let Some(from_disk) = load_cache_from_disk() {
            let mut guard = CHARTS_CACHE.write().await;
            *guard = Some(from_disk.clone());
            let mut last_guard = LAST_FETCH.write().await;
            *last_guard = Some(Instant::now());
            return from_disk;
        }
    }

    // 3. Needs fetch (either force or cache is completely empty)
    match update_spotify_charts().await {
        Ok(artists) => artists,
        Err(e) => {
            eprintln!("[SpotifyCharts] Fetch failed: {}", e);
            // Fallback to disk or hardcoded
            if let Some(disk) = load_cache_from_disk() {
                disk
            } else {
                get_fallback_artists()
            }
        }
    }
}

pub async fn start_spotify_charts_worker() {
    println!("[SpotifyCharts] Background service initialized.");

    // Load from disk immediately on boot
    if let Some(disk_data) = load_cache_from_disk() {
        let mut guard = CHARTS_CACHE.write().await;
        *guard = Some(disk_data);
        println!("[SpotifyCharts] Pre-warmed cache with persisted data from disk.");
    }

    // Wait 3 seconds to let server boot, then check if we need initial fetch
    tokio::time::sleep(Duration::from_secs(3)).await;

    let needs_update = {
        let guard = CHARTS_CACHE.read().await;
        match &*guard {
            None => true,
            Some(list) => list.is_empty(),
        }
    };

    if needs_update {
        println!("[SpotifyCharts] Fetching initial fresh charts...");
        if let Err(e) = update_spotify_charts().await {
            eprintln!("[SpotifyCharts] Initial fetch error: {}", e);
        }
    }

    // Scheduled background refresh every 6 hours
    loop {
        tokio::time::sleep(Duration::from_secs(CACHE_TTL_SECS)).await;
        println!("[SpotifyCharts] Running scheduled 6-hour daily update...");
        if let Err(e) = update_spotify_charts().await {
            eprintln!("[SpotifyCharts] Scheduled update error: {}", e);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_sample_html() {
        let sample = r#"
        <tbody>
        <tr><td>1</td><td class="text"><div><a href="artist/0du5cEVh5yTK9QJze8zA0C_songs.html">Bruno Mars</a></div></td><td>129,781,010</td><td>-34,139</td><td>1</td><td class="smaller">151,079,821</td></tr>
        <tr><td>2</td><td class="text"><div><a href="artist/5pKCCKE2ajJHZ9KAiaK11H_songs.html">Rihanna</a></div></td><td>116,192,743</td><td>15,798</td><td>2</td><td class="smaller">116,982,926</td></tr>
        </tbody>
        "#;
        let parsed = parse_kworb_html(sample);
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].position, 1);
        assert_eq!(parsed[0].name, "Bruno Mars");
        assert_eq!(parsed[0].spotify_id.as_deref(), Some("0du5cEVh5yTK9QJze8zA0C"));
        assert_eq!(parsed[0].monthly_listeners.as_deref(), Some("129,781,010"));
        assert_eq!(parsed[0].daily_diff.as_deref(), Some("-34,139"));
        assert_eq!(parsed[0].peak.as_deref(), Some("1"));
    }
}
