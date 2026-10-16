use std::convert::Infallible;
use std::time::Duration;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::Json;
use futures_util::stream::Stream;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::StreamExt;
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::Row;

use crate::auth::extract_claims_from_headers;
use crate::security::check_rate_limit;
use crate::AppState;

pub async fn get_library(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, StatusCode> {
    let claims = extract_claims_from_headers(&headers)
        .map_err(|_| StatusCode::UNAUTHORIZED)?;
    let user_id = claims.sub;

    let meta_row = sqlx::query("SELECT updated_at, mix_settings, disliked_tracks FROM user_sync_meta WHERE user_id = ?")
        .bind(&user_id)
        .fetch_optional(&state.pool)
        .await
        .unwrap_or(None);

    let updated_at: i64 = meta_row.as_ref().and_then(|r| r.try_get("updated_at").ok()).unwrap_or(0);
    let mix_config: Value = meta_row
        .as_ref()
        .and_then(|r| r.try_get::<String, _>("mix_settings").ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| json!({ "mood": "all", "source": "balanced", "language": "all" }));
    let disliked_ids: Value = meta_row
        .as_ref()
        .and_then(|r| r.try_get::<String, _>("disliked_tracks").ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| json!([]));

    let track_rows = sqlx::query(
        r#"
        SELECT id, title, artist, album, duration, audio_url, cover_url, genre, format, bitrate,
               plays, is_favorite, is_live_stream, is_local_upload, is_offline, playlist_only, added_at
        FROM tracks
        WHERE user_id = ?
        ORDER BY rowid DESC
        "#,
    )
    .bind(&user_id)
    .fetch_all(&state.pool)
    .await
    .unwrap_or_default();

    let mut tracks = Vec::new();
    for r in track_rows {
        let id: String = r.get("id");
        let title: String = r.get("title");
        let artist: String = r.get("artist");
        let album: Option<String> = r.get("album");
        let duration: f64 = r.get("duration");
        let audio_url: String = r.get("audio_url");
        let cover_url: Option<String> = r.get("cover_url");
        let genre: Option<String> = r.get("genre");
        let format: Option<String> = r.get("format");
        let bitrate: Option<String> = r.get("bitrate");
        let plays: i64 = r.get("plays");
        let is_favorite: i64 = r.get("is_favorite");
        let is_live_stream: i64 = r.get("is_live_stream");
        let is_local_upload: i64 = r.get("is_local_upload");
        let is_offline: i64 = r.try_get("is_offline").unwrap_or(0);
        let playlist_only: i64 = r.get("playlist_only");
        let added_at: Option<String> = r.get("added_at");

        tracks.push(json!({
            "id": id,
            "title": title,
            "artist": artist,
            "album": album,
            "duration": duration,
            "audioUrl": audio_url,
            "coverUrl": cover_url,
            "genre": genre.unwrap_or_else(|| "Music".to_string()),
            "format": format.unwrap_or_else(|| "mp3".to_string()),
            "bitrate": bitrate,
            "plays": plays,
            "isFavorite": is_favorite == 1,
            "isLiveStream": is_live_stream == 1,
            "isLocalUpload": is_local_upload == 1,
            "isOffline": is_offline == 1,
            "playlistOnly": playlist_only == 1,
            "addedAt": added_at.unwrap_or_default(),
        }));
    }

    let playlist_rows = sqlx::query(
        r#"
        SELECT id, title, description, cover_text, cover_url, track_ids
        FROM playlists
        WHERE user_id = ?
        "#,
    )
    .bind(&user_id)
    .fetch_all(&state.pool)
    .await
    .unwrap_or_default();

    let mut playlists = Vec::new();
    for r in playlist_rows {
        let id: String = r.get("id");
        let title: String = r.get("title");
        let description: Option<String> = r.get("description");
        let cover_text: Option<String> = r.get("cover_text");
        let cover_url: Option<String> = r.try_get("cover_url").ok().and_then(|s: String| {
            let t = s.trim();
            if t.is_empty() { None } else { Some(t.to_string()) }
        });
        let track_ids_raw: String = r.get("track_ids");
        let track_ids: Vec<String> = serde_json::from_str(&track_ids_raw).unwrap_or_default();

        playlists.push(json!({
            "id": id,
            "title": title,
            "description": description.unwrap_or_default(),
            "coverText": cover_text.unwrap_or_else(|| "PL".to_string()),
            "coverUrl": cover_url,
            "trackIds": track_ids,
        }));
    }


    let station_rows = sqlx::query(
        r#"
        SELECT id, name, stream_url, genre, country, bitrate, favicon, is_custom
        FROM radio_stations
        WHERE user_id = ?
        "#,
    )
    .bind(&user_id)
    .fetch_all(&state.pool)
    .await
    .unwrap_or_default();

    let mut radio_stations = Vec::new();
    for r in station_rows {
        let id: String = r.get("id");
        let name: String = r.get("name");
        let stream_url: String = r.get("stream_url");
        let genre: Option<String> = r.get("genre");
        let country: Option<String> = r.get("country");
        let bitrate: Option<String> = r.get("bitrate");
        let favicon: Option<String> = r.get("favicon");
        let is_custom: i64 = r.get("is_custom");

        radio_stations.push(json!({
            "id": id,
            "name": name,
            "streamUrl": stream_url,
            "genre": genre.unwrap_or_else(|| "Radio".to_string()),
            "country": country,
            "bitrate": bitrate,
            "favicon": favicon,
            "isCustom": is_custom == 1,
        }));
    }

    Ok(Json(json!({
        "updated_at": updated_at,
        "tracks": tracks,
        "playlists": playlists,
        "radio_stations": radio_stations,
        "mix_config": mix_config,
        "disliked_ids": disliked_ids,
    })))
}

pub async fn save_library(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(data): Json<Value>,
) -> Result<StatusCode, (StatusCode, Json<Value>)> {
    let claims = extract_claims_from_headers(&headers)
        .map_err(|(code, msg)| (code, Json(json!({ "error": msg }))))?;
    let user_id = claims.sub;

    check_rate_limit(
        &state.endpoint_rate_limits,
        &format!("sync_save:{}", user_id),
        20,
        60,
    )
    .map_err(|c| (c, Json(json!({ "error": "Слишком частые сохранения библиотеки" }))))?;

    let updated_at = data
        .get("updated_at")
        .and_then(|v| v.as_i64())
        .unwrap_or_else(|| chrono::Utc::now().timestamp_millis());

    let mut tx = state.pool.begin().await.map_err(|e| {
        eprintln!("Transaction start error: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "Ошибка базы данных" })),
        )
    })?;

    let mix_settings_str = data.get("mix_config").map(|v| v.to_string());
    let disliked_str = data.get("disliked_ids").map(|v| v.to_string());

    sqlx::query(
        r#"
        INSERT INTO user_sync_meta (user_id, updated_at, mix_settings, disliked_tracks)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET 
            updated_at = excluded.updated_at,
            mix_settings = COALESCE(excluded.mix_settings, user_sync_meta.mix_settings),
            disliked_tracks = COALESCE(excluded.disliked_tracks, user_sync_meta.disliked_tracks)
        "#,
    )
    .bind(&user_id)
    .bind(updated_at)
    .bind(&mix_settings_str)
    .bind(&disliked_str)
    .execute(&mut *tx)
    .await
    .map_err(|e| {
        eprintln!("Error saving sync meta: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "Ошибка обновления метаданных" })),
        )
    })?;

    if let Some(tracks_arr) = data.get("tracks").and_then(|v| v.as_array()) {
        if tracks_arr.len() > 3000 {
            return Err((
                StatusCode::PAYLOAD_TOO_LARGE,
                Json(json!({ "error": "Превышен лимит количества треков (максимум 3000)" })),
            ));
        }

        sqlx::query("DELETE FROM tracks WHERE user_id = ?")
            .bind(&user_id)
            .execute(&mut *tx)
            .await
            .map_err(|_| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({ "error": "Ошибка очистки треков" })),
                )
            })?;

        for item in tracks_arr {
            let id = item.get("id").and_then(|v| v.as_str()).unwrap_or_default();
            let title = item.get("title").and_then(|v| v.as_str()).unwrap_or_default();
            let artist = item.get("artist").and_then(|v| v.as_str()).unwrap_or_default();
            let album = item.get("album").and_then(|v| v.as_str());
            let duration = item.get("duration").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let audio_url = item.get("audioUrl").and_then(|v| v.as_str()).unwrap_or_default();
            let cover_url = item.get("coverUrl").and_then(|v| v.as_str());
            let genre = item.get("genre").and_then(|v| v.as_str()).unwrap_or("Music");
            let format = item.get("format").and_then(|v| v.as_str()).unwrap_or("mp3");
            let bitrate = item.get("bitrate").and_then(|v| v.as_str());
            let plays = item.get("plays").and_then(|v| v.as_i64()).unwrap_or(0);
            let is_fav = if item.get("isFavorite").and_then(|v| v.as_bool()).unwrap_or(false) { 1 } else { 0 };
            let is_live = if item.get("isLiveStream").and_then(|v| v.as_bool()).unwrap_or(false) { 1 } else { 0 };
            let is_upload = if item.get("isLocalUpload").and_then(|v| v.as_bool()).unwrap_or(false) { 1 } else { 0 };
            let is_offline = if item.get("isOffline").and_then(|v| v.as_bool()).unwrap_or(false) { 1 } else { 0 };
            let is_pl_only = if item.get("playlistOnly").and_then(|v| v.as_bool()).unwrap_or(false) { 1 } else { 0 };
            let added_at = item.get("addedAt").and_then(|v| v.as_str()).unwrap_or_default();

            if !id.is_empty() && !audio_url.is_empty() {
                sqlx::query(
                    r#"
                    INSERT OR REPLACE INTO tracks
                    (id, user_id, title, artist, album, duration, audio_url, cover_url, genre, format, bitrate, plays, is_favorite, is_live_stream, is_local_upload, is_offline, playlist_only, added_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    "#,
                )
                .bind(id)
                .bind(&user_id)
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
                .bind(is_fav)
                .bind(is_live)
                .bind(is_upload)
                .bind(is_offline)
                .bind(is_pl_only)
                .bind(added_at)
                .execute(&mut *tx)
                .await
                .map_err(|_| {
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(json!({ "error": "Ошибка сохранения трека" })),
                    )
                })?;
            }
        }
    }

    if let Some(pl_arr) = data.get("playlists").and_then(|v| v.as_array()) {
        if pl_arr.len() > 300 {
            return Err((
                StatusCode::PAYLOAD_TOO_LARGE,
                Json(json!({ "error": "Превышен лимит количества плейлистов (максимум 300)" })),
            ));
        }

        sqlx::query("DELETE FROM playlists WHERE user_id = ?")
            .bind(&user_id)
            .execute(&mut *tx)
            .await
            .map_err(|_| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({ "error": "Ошибка очистки плейлистов" })),
                )
            })?;

        for item in pl_arr {
            let id = item.get("id").and_then(|v| v.as_str()).unwrap_or_default();
            let title = item.get("title").and_then(|v| v.as_str()).unwrap_or_default();
            let desc = item.get("description").and_then(|v| v.as_str()).unwrap_or_default();
            let cover_text = item.get("coverText").and_then(|v| v.as_str()).unwrap_or("PL");
            let cover_url = item.get("coverUrl")
                .and_then(|v| v.as_str())
                .map(|s| s.trim())
                .filter(|s| !s.is_empty());
            let track_ids = item.get("trackIds").map(|v| v.to_string()).unwrap_or_else(|| "[]".to_string());
            let now = chrono::Utc::now().timestamp();

            if !id.is_empty() {
                sqlx::query(
                    r#"
                    INSERT OR REPLACE INTO playlists (id, user_id, title, description, cover_text, cover_url, track_ids, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    "#,
                )
                .bind(id)
                .bind(&user_id)
                .bind(title)
                .bind(desc)
                .bind(cover_text)
                .bind(cover_url)
                .bind(track_ids)
                .bind(now)
                .execute(&mut *tx)
                .await
                .map_err(|_| {
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(json!({ "error": "Ошибка сохранения плейлиста" })),
                    )
                })?;
            }
        }
    }

    if let Some(st_arr) = data.get("radio_stations").and_then(|v| v.as_array()) {
        if st_arr.len() > 300 {
            return Err((
                StatusCode::PAYLOAD_TOO_LARGE,
                Json(json!({ "error": "Превышен лимит радиостанций (максимум 300)" })),
            ));
        }

        sqlx::query("DELETE FROM radio_stations WHERE user_id = ?")
            .bind(&user_id)
            .execute(&mut *tx)
            .await
            .map_err(|_| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({ "error": "Ошибка очистки радиостанций" })),
                )
            })?;

        for item in st_arr {
            let id = item.get("id").and_then(|v| v.as_str()).unwrap_or_default();
            let name = item.get("name").and_then(|v| v.as_str()).unwrap_or_default();
            let stream_url = item.get("streamUrl").and_then(|v| v.as_str()).unwrap_or_default();
            let genre = item.get("genre").and_then(|v| v.as_str());
            let country = item.get("country").and_then(|v| v.as_str());
            let bitrate = item.get("bitrate").and_then(|v| v.as_str());
            let favicon = item.get("favicon").and_then(|v| v.as_str());
            let is_custom = if item.get("isCustom").and_then(|v| v.as_bool()).unwrap_or(true) { 1 } else { 0 };

            if !id.is_empty() && !stream_url.is_empty() {
                sqlx::query(
                    r#"
                    INSERT OR REPLACE INTO radio_stations (id, user_id, name, stream_url, genre, country, bitrate, favicon, is_custom)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    "#,
                )
                .bind(id)
                .bind(&user_id)
                .bind(name)
                .bind(stream_url)
                .bind(genre)
                .bind(country)
                .bind(bitrate)
                .bind(favicon)
                .bind(is_custom)
                .execute(&mut *tx)
                .await
                .map_err(|_| {
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(json!({ "error": "Ошибка сохранения радиостанции" })),
                    )
                })?;
            }
        }
    }

    tx.commit().await.map_err(|e| {
        eprintln!("Transaction commit error: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "Ошибка сохранения библиотеки" })),
        )
    })?;

    // Replicate changes to Turso cloud
    crate::turso::execute_write(
        r#"
        INSERT INTO user_sync_meta (user_id, updated_at, mix_settings, disliked_tracks)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET 
            updated_at = excluded.updated_at,
            mix_settings = COALESCE(excluded.mix_settings, user_sync_meta.mix_settings),
            disliked_tracks = COALESCE(excluded.disliked_tracks, user_sync_meta.disliked_tracks)
        "#,
        vec![
            crate::turso::TursoValue::text(&user_id),
            crate::turso::TursoValue::int(updated_at),
            crate::turso::TursoValue::text_opt(mix_settings_str),
            crate::turso::TursoValue::text_opt(disliked_str),
        ],
    );

    if let Some(tracks_arr) = data.get("tracks").and_then(|v| v.as_array()) {
        let mut stmts = vec![(
            "DELETE FROM tracks WHERE user_id = ?".to_string(),
            vec![crate::turso::TursoValue::text(&user_id)],
        )];
        for item in tracks_arr {
            let id = item.get("id").and_then(|v| v.as_str()).unwrap_or_default();
            let title = item.get("title").and_then(|v| v.as_str()).unwrap_or_default();
            let artist = item.get("artist").and_then(|v| v.as_str()).unwrap_or_default();
            let album = item.get("album").and_then(|v| v.as_str()).map(|s| s.to_string());
            let duration = item.get("duration").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let audio_url = item.get("audioUrl").and_then(|v| v.as_str()).unwrap_or_default();
            let cover_url = item.get("coverUrl").and_then(|v| v.as_str()).map(|s| s.to_string());
            let genre = item.get("genre").and_then(|v| v.as_str()).unwrap_or("Music");
            let format = item.get("format").and_then(|v| v.as_str()).unwrap_or("mp3");
            let bitrate = item.get("bitrate").and_then(|v| v.as_str()).map(|s| s.to_string());
            let plays = item.get("plays").and_then(|v| v.as_i64()).unwrap_or(0);
            let is_fav = if item.get("isFavorite").and_then(|v| v.as_bool()).unwrap_or(false) { 1 } else { 0 };
            let is_live = if item.get("isLiveStream").and_then(|v| v.as_bool()).unwrap_or(false) { 1 } else { 0 };
            let is_upload = if item.get("isLocalUpload").and_then(|v| v.as_bool()).unwrap_or(false) { 1 } else { 0 };
            let is_offline = if item.get("isOffline").and_then(|v| v.as_bool()).unwrap_or(false) { 1 } else { 0 };
            let is_pl_only = if item.get("playlistOnly").and_then(|v| v.as_bool()).unwrap_or(false) { 1 } else { 0 };
            let added_at = item.get("addedAt").and_then(|v| v.as_str()).unwrap_or_default();

            if !id.is_empty() && !audio_url.is_empty() {
                stmts.push((
                    r#"
                    INSERT OR REPLACE INTO tracks
                    (id, user_id, title, artist, album, duration, audio_url, cover_url, genre, format, bitrate, plays, is_favorite, is_live_stream, is_local_upload, is_offline, playlist_only, added_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    "#.to_string(),
                    vec![
                        crate::turso::TursoValue::text(id),
                        crate::turso::TursoValue::text(&user_id),
                        crate::turso::TursoValue::text(title),
                        crate::turso::TursoValue::text(artist),
                        crate::turso::TursoValue::text_opt(album),
                        crate::turso::TursoValue::float(duration),
                        crate::turso::TursoValue::text(audio_url),
                        crate::turso::TursoValue::text_opt(cover_url),
                        crate::turso::TursoValue::text(genre),
                        crate::turso::TursoValue::text(format),
                        crate::turso::TursoValue::text_opt(bitrate),
                        crate::turso::TursoValue::int(plays),
                        crate::turso::TursoValue::int(is_fav),
                        crate::turso::TursoValue::int(is_live),
                        crate::turso::TursoValue::int(is_upload),
                        crate::turso::TursoValue::int(is_offline),
                        crate::turso::TursoValue::int(is_pl_only),
                        crate::turso::TursoValue::text(added_at),
                    ],
                ));
            }
        }
        crate::turso::execute_batch_writes(stmts);
    }

    if let Some(pl_arr) = data.get("playlists").and_then(|v| v.as_array()) {
        let mut stmts = vec![(
            "DELETE FROM playlists WHERE user_id = ?".to_string(),
            vec![crate::turso::TursoValue::text(&user_id)],
        )];
        let now = chrono::Utc::now().timestamp();
        for item in pl_arr {
            let id = item.get("id").and_then(|v| v.as_str()).unwrap_or_default();
            let title = item.get("title").and_then(|v| v.as_str()).unwrap_or_default();
            let desc = item.get("description").and_then(|v| v.as_str()).unwrap_or_default();
            let cover_text = item.get("coverText").and_then(|v| v.as_str()).unwrap_or("PL");
            let cover_url = item.get("coverUrl")
                .and_then(|v| v.as_str())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
            let track_ids = item.get("trackIds").map(|v| v.to_string()).unwrap_or_else(|| "[]".to_string());

            if !id.is_empty() {
                stmts.push((
                    r#"
                    INSERT OR REPLACE INTO playlists (id, user_id, title, description, cover_text, cover_url, track_ids, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    "#.to_string(),
                    vec![
                        crate::turso::TursoValue::text(id),
                        crate::turso::TursoValue::text(&user_id),
                        crate::turso::TursoValue::text(title),
                        crate::turso::TursoValue::text(desc),
                        crate::turso::TursoValue::text(cover_text),
                        crate::turso::TursoValue::text_opt(cover_url),
                        crate::turso::TursoValue::text(track_ids),
                        crate::turso::TursoValue::int(now),
                    ],
                ));
            }
        }
        crate::turso::execute_batch_writes(stmts);
    }

    if let Some(st_arr) = data.get("radio_stations").and_then(|v| v.as_array()) {
        let mut stmts = vec![(
            "DELETE FROM radio_stations WHERE user_id = ?".to_string(),
            vec![crate::turso::TursoValue::text(&user_id)],
        )];
        for item in st_arr {
            let id = item.get("id").and_then(|v| v.as_str()).unwrap_or_default();
            let name = item.get("name").and_then(|v| v.as_str()).unwrap_or_default();
            let stream_url = item.get("streamUrl").and_then(|v| v.as_str()).unwrap_or_default();
            let genre = item.get("genre").and_then(|v| v.as_str()).map(|s| s.to_string());
            let country = item.get("country").and_then(|v| v.as_str()).map(|s| s.to_string());
            let bitrate = item.get("bitrate").and_then(|v| v.as_str()).map(|s| s.to_string());
            let favicon = item.get("favicon").and_then(|v| v.as_str()).map(|s| s.to_string());
            let is_custom = if item.get("isCustom").and_then(|v| v.as_bool()).unwrap_or(true) { 1 } else { 0 };

            if !id.is_empty() && !stream_url.is_empty() {
                stmts.push((
                    r#"
                    INSERT OR REPLACE INTO radio_stations (id, user_id, name, stream_url, genre, country, bitrate, favicon, is_custom)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    "#.to_string(),
                    vec![
                        crate::turso::TursoValue::text(id),
                        crate::turso::TursoValue::text(&user_id),
                        crate::turso::TursoValue::text(name),
                        crate::turso::TursoValue::text(stream_url),
                        crate::turso::TursoValue::text_opt(genre),
                        crate::turso::TursoValue::text_opt(country),
                        crate::turso::TursoValue::text_opt(bitrate),
                        crate::turso::TursoValue::text_opt(favicon),
                        crate::turso::TursoValue::int(is_custom),
                    ],
                ));
            }
        }
        crate::turso::execute_batch_writes(stmts);
    }

    let _ = state.sync_channel.send(format!("{}:library_updated", user_id));

    Ok(StatusCode::OK)
}

#[derive(Debug, Deserialize)]
pub struct SyncEventsQuery {
    pub token: Option<String>,
}

pub async fn sync_events(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<SyncEventsQuery>,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, StatusCode> {
    let user_id = if let Some(ref t) = query.token {
        crate::auth::verify_jwt(t)
            .map(|claims| claims.sub)
            .map_err(|_| StatusCode::UNAUTHORIZED)?
    } else {
        crate::auth::extract_claims_from_headers(&headers)
            .map(|claims| claims.sub)
            .map_err(|_| StatusCode::UNAUTHORIZED)?
    };

    let rx = state.sync_channel.subscribe();
    let initial = futures_util::stream::once(async {
        Ok(Event::default().event("connected").data("ok"))
    });

    let updates = BroadcastStream::new(rx).filter_map(move |result| {
        let user_id = user_id.clone();
        match result {
            Ok(msg) => {
                if let Some((target_user, event_name)) = msg.split_once(':') {
                    if target_user == user_id {
                        return Some(Ok(Event::default().event(event_name).data(event_name)));
                    }
                }
                None
            }
            Err(_) => None,
        }
    });

    let stream = initial.chain(updates);
    Ok(Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(15))))
}
