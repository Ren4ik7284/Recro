use crate::db::DbPool;
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

static TURSO_CONFIG: OnceLock<TursoConfig> = OnceLock::new();

pub struct TursoConfig {
    pub url: String,
    pub token: String,
    pub client: reqwest::Client,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum TursoValue {
    #[serde(rename = "null")]
    Null,
    #[serde(rename = "integer")]
    Integer { value: String },
    #[serde(rename = "float")]
    Float { value: f64 },
    #[serde(rename = "text")]
    Text { value: String },
}

impl TursoValue {
    pub fn text<S: Into<String>>(s: S) -> Self {
        TursoValue::Text { value: s.into() }
    }

    pub fn text_opt(s: Option<String>) -> Self {
        match s {
            Some(v) => TursoValue::Text { value: v },
            None => TursoValue::Null,
        }
    }

    pub fn int(i: i64) -> Self {
        TursoValue::Integer {
            value: i.to_string(),
        }
    }

    pub fn float(f: f64) -> Self {
        TursoValue::Float { value: f }
    }

    pub fn null() -> Self {
        TursoValue::Null
    }
}

pub fn init_turso() {
    let url = std::env::var("TURSO_DATABASE_URL").unwrap_or_else(|_| {
        "https://signal-db-ren4ik7284.aws-ap-northeast-1.turso.io".to_string()
    });
    let token = std::env::var("TURSO_AUTH_TOKEN").unwrap_or_else(|_| {
        "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3OTE3MzcwNTUsImlkIjoiMDFhMTJiZDktOGMwMS03ZGU4LTgwZTgtNDNlY2Q2OTgyYTRkIiwia2lkIjoiaGx5SzdZOGZGRGExV1c2cWVkUkFhbENjNzh6bjE4Wm9ZdXNodDhwZ3JxNCIsInJpZCI6IjRhNzU1NmM4LWE4YTgtNDdhYy1hMzllLWFkODgxZTU2ZGMxOSJ9.nFOhRjf8ExJnRMT1QMOsb3lxiY9LiHk4FDa0Go6mdz4OpKF0ZHQsHuNC4de8PoTmOI6mqvRBbLBL8FzGJbSbBw".to_string()
    });

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .unwrap_or_default();

    println!("[Turso] Cloud replication enabled for: {}", url);
    let _ = TURSO_CONFIG.set(TursoConfig { url, token, client });
}

#[derive(Serialize)]
struct Stmt {
    sql: String,
    args: Vec<TursoValue>,
}

#[derive(Serialize)]
struct RequestItem {
    #[serde(rename = "type")]
    req_type: &'static str,
    stmt: Stmt,
}

#[derive(Serialize)]
struct PipelineBody {
    requests: Vec<RequestItem>,
}

#[derive(Deserialize)]
struct RawCell {
    #[serde(rename = "type")]
    val_type: String,
    value: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct RawQueryResult {
    rows: Option<Vec<Vec<RawCell>>>,
}

#[derive(Deserialize)]
#[allow(dead_code)]
struct RawResponseWrapper {
    #[serde(rename = "type")]
    resp_type: String,
    result: Option<RawQueryResult>,
}

#[derive(Deserialize)]
#[allow(dead_code)]
struct PipelineResultItem {
    #[serde(rename = "type")]
    status: String,
    response: Option<RawResponseWrapper>,
}

#[derive(Deserialize)]
struct PipelineResponseBody {
    results: Option<Vec<PipelineResultItem>>,
}

pub fn execute_write(sql: &str, args: Vec<TursoValue>) {
    let sql = sql.to_string();
    tokio::spawn(async move {
        if let Some(cfg) = TURSO_CONFIG.get() {
            let body = PipelineBody {
                requests: vec![RequestItem {
                    req_type: "execute",
                    stmt: Stmt {
                        sql: sql.clone(),
                        args,
                    },
                }],
            };

            let endpoint = format!("{}/v2/pipeline", cfg.url.trim_end_matches('/'));
            let res = cfg
                .client
                .post(&endpoint)
                .header("Authorization", format!("Bearer {}", cfg.token))
                .header("Content-Type", "application/json")
                .json(&body)
                .send()
                .await;

            if let Err(e) = res {
                eprintln!("[Turso] Cloud write failed: {}", e);
            }
        }
    });
}

pub fn execute_batch_writes(stmts: Vec<(String, Vec<TursoValue>)>) {
    if stmts.is_empty() {
        return;
    }
    tokio::spawn(async move {
        if let Some(cfg) = TURSO_CONFIG.get() {
            let chunks: Vec<_> = stmts.chunks(50).map(|c| c.to_vec()).collect();
            for chunk in chunks {
                let requests: Vec<RequestItem> = chunk
                    .into_iter()
                    .map(|(sql, args)| RequestItem {
                        req_type: "execute",
                        stmt: Stmt { sql, args },
                    })
                    .collect();

                let body = PipelineBody { requests };
                let endpoint = format!("{}/v2/pipeline", cfg.url.trim_end_matches('/'));
                let res = cfg
                    .client
                    .post(&endpoint)
                    .header("Authorization", format!("Bearer {}", cfg.token))
                    .header("Content-Type", "application/json")
                    .json(&body)
                    .send()
                    .await;

                if let Err(e) = res {
                    eprintln!("[Turso] Batch write failed: {}", e);
                }
            }
        }
    });
}

fn cell_as_str(cell: &RawCell) -> Option<String> {
    if cell.val_type == "null" {
        return None;
    }
    match &cell.value {
        Some(serde_json::Value::String(s)) => Some(s.clone()),
        Some(v) => Some(v.to_string()),
        None => None,
    }
}

fn cell_as_i64(cell: &RawCell) -> Option<i64> {
    if cell.val_type == "null" {
        return None;
    }
    match &cell.value {
        Some(serde_json::Value::Number(n)) => n.as_i64(),
        Some(serde_json::Value::String(s)) => s.parse::<i64>().ok(),
        _ => None,
    }
}

fn cell_as_f64(cell: &RawCell) -> Option<f64> {
    if cell.val_type == "null" {
        return None;
    }
    match &cell.value {
        Some(serde_json::Value::Number(n)) => n.as_f64(),
        Some(serde_json::Value::String(s)) => s.parse::<f64>().ok(),
        _ => None,
    }
}

pub async fn sync_down_on_boot(pool: &DbPool) {
    let cfg = match TURSO_CONFIG.get() {
        Some(c) => c,
        None => return,
    };

    println!("[Turso] Checking cloud database snapshot...");

    let body = PipelineBody {
        requests: vec![
            RequestItem {
                req_type: "execute",
                stmt: Stmt {
                    sql: "SELECT id, username, password_hash, google_id, email, avatar_url, banner_url, profile_tags, created_at FROM users".to_string(),
                    args: vec![],
                },
            },
            RequestItem {
                req_type: "execute",
                stmt: Stmt {
                    sql: "SELECT user_id, updated_at, mix_settings, disliked_tracks FROM user_sync_meta".to_string(),
                    args: vec![],
                },
            },
            RequestItem {
                req_type: "execute",
                stmt: Stmt {
                    sql: "SELECT id, user_id, title, artist, album, duration, audio_url, cover_url, genre, format, bitrate, plays, is_favorite, is_live_stream, is_local_upload, is_offline, playlist_only, added_at FROM tracks".to_string(),
                    args: vec![],
                },
            },
            RequestItem {
                req_type: "execute",
                stmt: Stmt {
                    sql: "SELECT id, user_id, title, description, cover_text, cover_url, track_ids, created_at FROM playlists".to_string(),
                    args: vec![],
                },
            },
            RequestItem {
                req_type: "execute",
                stmt: Stmt {
                    sql: "SELECT id, user_id, name, stream_url, genre, country, bitrate, favicon, is_custom FROM radio_stations".to_string(),
                    args: vec![],
                },
            },
        ],
    };

    let endpoint = format!("{}/v2/pipeline", cfg.url.trim_end_matches('/'));
    let resp = match cfg
        .client
        .post(&endpoint)
        .header("Authorization", format!("Bearer {}", cfg.token))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            eprintln!("[Turso] Could not connect to Turso cloud on boot: {}", e);
            return;
        }
    };

    let parsed: PipelineResponseBody = match resp.json().await {
        Ok(p) => p,
        Err(e) => {
            eprintln!("[Turso] Failed to parse Turso cloud response: {}", e);
            return;
        }
    };

    let results = match parsed.results {
        Some(r) => r,
        None => return,
    };

    // 0: users
    if let Some(item) = results.get(0) {
        if let Some(rows) = item.response.as_ref().and_then(|r| r.result.as_ref()).and_then(|res| res.rows.as_ref()) {
            let count = rows.len();
            for r in rows {
                if r.len() >= 9 {
                    let id = cell_as_str(&r[0]).unwrap_or_default();
                    let username = cell_as_str(&r[1]).unwrap_or_default();
                    let password_hash = cell_as_str(&r[2]).unwrap_or_default();
                    let google_id = cell_as_str(&r[3]);
                    let email = cell_as_str(&r[4]);
                    let avatar_url = cell_as_str(&r[5]);
                    let banner_url = cell_as_str(&r[6]);
                    let profile_tags = cell_as_str(&r[7]);
                    let created_at = cell_as_i64(&r[8]).unwrap_or(0);

                    let _ = sqlx::query(
                        r#"
                        INSERT OR REPLACE INTO users (id, username, password_hash, google_id, email, avatar_url, banner_url, profile_tags, created_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                        "#,
                    )
                    .bind(id)
                    .bind(username)
                    .bind(password_hash)
                    .bind(google_id)
                    .bind(email)
                    .bind(avatar_url)
                    .bind(banner_url)
                    .bind(profile_tags)
                    .bind(created_at)
                    .execute(pool)
                    .await;
                }
            }
            if count > 0 {
                println!("[Turso] Restored {} user(s) from cloud database.", count);
            }
        }
    }

    // 1: user_sync_meta
    if let Some(item) = results.get(1) {
        if let Some(rows) = item.response.as_ref().and_then(|r| r.result.as_ref()).and_then(|res| res.rows.as_ref()) {
            for r in rows {
                if r.len() >= 4 {
                    let user_id = cell_as_str(&r[0]).unwrap_or_default();
                    let updated_at = cell_as_i64(&r[1]).unwrap_or(0);
                    let mix_settings = cell_as_str(&r[2]);
                    let disliked_tracks = cell_as_str(&r[3]);

                    let _ = sqlx::query(
                        r#"
                        INSERT OR REPLACE INTO user_sync_meta (user_id, updated_at, mix_settings, disliked_tracks)
                        VALUES (?, ?, ?, ?)
                        "#,
                    )
                    .bind(user_id)
                    .bind(updated_at)
                    .bind(mix_settings)
                    .bind(disliked_tracks)
                    .execute(pool)
                    .await;
                }
            }
        }
    }

    // 2: tracks
    if let Some(item) = results.get(2) {
        if let Some(rows) = item.response.as_ref().and_then(|r| r.result.as_ref()).and_then(|res| res.rows.as_ref()) {
            let count = rows.len();
            for r in rows {
                if r.len() >= 18 {
                    let id = cell_as_str(&r[0]).unwrap_or_default();
                    let user_id = cell_as_str(&r[1]).unwrap_or_default();
                    let title = cell_as_str(&r[2]).unwrap_or_default();
                    let artist = cell_as_str(&r[3]).unwrap_or_default();
                    let album = cell_as_str(&r[4]);
                    let duration = cell_as_f64(&r[5]).unwrap_or(0.0);
                    let audio_url = cell_as_str(&r[6]).unwrap_or_default();
                    let cover_url = cell_as_str(&r[7]);
                    let genre = cell_as_str(&r[8]);
                    let format = cell_as_str(&r[9]);
                    let bitrate = cell_as_str(&r[10]);
                    let plays = cell_as_i64(&r[11]).unwrap_or(0);
                    let is_favorite = cell_as_i64(&r[12]).unwrap_or(0);
                    let is_live_stream = cell_as_i64(&r[13]).unwrap_or(0);
                    let is_local_upload = cell_as_i64(&r[14]).unwrap_or(0);
                    let is_offline = cell_as_i64(&r[15]).unwrap_or(0);
                    let playlist_only = cell_as_i64(&r[16]).unwrap_or(0);
                    let added_at = cell_as_str(&r[17]);

                    let _ = sqlx::query(
                        r#"
                        INSERT OR REPLACE INTO tracks (
                            id, user_id, title, artist, album, duration, audio_url, cover_url,
                            genre, format, bitrate, plays, is_favorite, is_live_stream,
                            is_local_upload, is_offline, playlist_only, added_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        "#,
                    )
                    .bind(id)
                    .bind(user_id)
                    .bind(title)
                    .bind(artist)
                    .bind(album)
                    .bind(duration)
                    .bind(audio_url)
                    .bind(cover_url)
                    .bind(genre)
                    .bind(format)
                    .bind(bitrate)
                    .bind(plays)
                    .bind(is_favorite)
                    .bind(is_live_stream)
                    .bind(is_local_upload)
                    .bind(is_offline)
                    .bind(playlist_only)
                    .bind(added_at)
                    .execute(pool)
                    .await;
                }
            }
            if count > 0 {
                println!("[Turso] Restored {} cloud track(s).", count);
            }
        }
    }

    // 3: playlists
    if let Some(item) = results.get(3) {
        if let Some(rows) = item.response.as_ref().and_then(|r| r.result.as_ref()).and_then(|res| res.rows.as_ref()) {
            let count = rows.len();
            for r in rows {
                if r.len() >= 8 {
                    let id = cell_as_str(&r[0]).unwrap_or_default();
                    let user_id = cell_as_str(&r[1]).unwrap_or_default();
                    let title = cell_as_str(&r[2]).unwrap_or_default();
                    let description = cell_as_str(&r[3]);
                    let cover_text = cell_as_str(&r[4]);
                    let cover_url = cell_as_str(&r[5]);
                    let track_ids = cell_as_str(&r[6]).unwrap_or_else(|| "[]".to_string());
                    let created_at = cell_as_i64(&r[7]).unwrap_or(0);

                    let _ = sqlx::query(
                        r#"
                        INSERT OR REPLACE INTO playlists (id, user_id, title, description, cover_text, cover_url, track_ids, created_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                        "#,
                    )
                    .bind(id)
                    .bind(user_id)
                    .bind(title)
                    .bind(description)
                    .bind(cover_text)
                    .bind(cover_url)
                    .bind(track_ids)
                    .bind(created_at)
                    .execute(pool)
                    .await;
                }
            }
            if count > 0 {
                println!("[Turso] Restored {} cloud playlist(s).", count);
            }
        }
    }

    // 4: radio_stations
    if let Some(item) = results.get(4) {
        if let Some(rows) = item.response.as_ref().and_then(|r| r.result.as_ref()).and_then(|res| res.rows.as_ref()) {
            for r in rows {
                if r.len() >= 9 {
                    let id = cell_as_str(&r[0]).unwrap_or_default();
                    let user_id = cell_as_str(&r[1]).unwrap_or_default();
                    let name = cell_as_str(&r[2]).unwrap_or_default();
                    let stream_url = cell_as_str(&r[3]).unwrap_or_default();
                    let genre = cell_as_str(&r[4]);
                    let country = cell_as_str(&r[5]);
                    let bitrate = cell_as_str(&r[6]);
                    let favicon = cell_as_str(&r[7]);
                    let is_custom = cell_as_i64(&r[8]).unwrap_or(1);

                    let _ = sqlx::query(
                        r#"
                        INSERT OR REPLACE INTO radio_stations (id, user_id, name, stream_url, genre, country, bitrate, favicon, is_custom)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                        "#,
                    )
                    .bind(id)
                    .bind(user_id)
                    .bind(name)
                    .bind(stream_url)
                    .bind(genre)
                    .bind(country)
                    .bind(bitrate)
                    .bind(favicon)
                    .bind(is_custom)
                    .execute(pool)
                    .await;
                }
            }
        }
    }

    println!("[Turso] Cloud synchronization complete.");
}
