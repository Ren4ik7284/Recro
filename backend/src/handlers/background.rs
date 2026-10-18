use axum::{
    extract::{Multipart, State},
    http::StatusCode,
    response::{IntoResponse, Json},
};
use serde_json::json;
use std::path::PathBuf;
use std::process::Stdio;
use tokio::fs;
use tokio::process::Command;
use uuid::Uuid;

use crate::AppState;

fn get_backgrounds_dir() -> PathBuf {
    let prod_path = PathBuf::from("/var/www/recro/cache/backgrounds");
    if prod_path.parent().map(|p| p.exists()).unwrap_or(false) {
        prod_path
    } else {
        PathBuf::from("cache/backgrounds")
    }
}

pub async fn upload_background(
    State(_state): State<AppState>,
    mut multipart: Multipart,
) -> Result<impl IntoResponse, (StatusCode, Json<serde_json::Value>)> {
    let bg_dir = get_backgrounds_dir();
    let _ = fs::create_dir_all(&bg_dir).await;

    let mut original_name = String::from("wallpaper");
    let mut uploaded_bytes: Option<Vec<u8>> = None;
    let mut content_type = String::new();

    while let Ok(Some(field)) = multipart.next_field().await {
        if let Some(name) = field.file_name() {
            original_name = name.to_string();
        }
        if let Some(ct) = field.content_type() {
            content_type = ct.to_string();
        }
        if let Ok(data) = field.bytes().await {
            uploaded_bytes = Some(data.to_vec());
            break;
        }
    }

    let raw_data = match uploaded_bytes {
        Some(b) if !b.is_empty() => b,
        _ => {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "No file data received" })),
            ));
        }
    };

    let file_id = Uuid::new_v4().to_string();
    let lower_name = original_name.to_lowercase();
    let is_video = content_type.starts_with("video/")
        || lower_name.ends_with(".mp4")
        || lower_name.ends_with(".webm")
        || lower_name.ends_with(".mov")
        || lower_name.ends_with(".mkv");
    let is_gif = content_type.contains("gif") || lower_name.ends_with(".gif");

    let tmp_input = std::env::temp_dir().join(format!("raw_bg_{}", file_id));
    if let Err(e) = fs::write(&tmp_input, &raw_data).await {
        eprintln!("[BG_UPLOAD] Failed to write temp file: {}", e);
        return Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "Failed to buffer file" })),
        ));
    }

    if is_video || is_gif {
        // Transcode and compress video or GIF into lightweight web-ready MP4 (scale to max 1920, H.264, silent, faststart)
        let out_filename = format!("{}.mp4", file_id);
        let out_path = bg_dir.join(&out_filename);

        eprintln!("[BG_UPLOAD] Compressing video/gif to {}", out_path.display());
        let mut cmd = Command::new("ffmpeg");
        cmd.args([
            "-y",
            "-i",
            tmp_input.to_str().unwrap_or(""),
            "-c:v",
            "libx264",
            "-crf",
            "26",
            "-preset",
            "fast",
            "-pix_fmt",
            "yuv420p",
            "-vf",
            "scale=min(1920\\,iw):-2",
            "-an",
            "-movflags",
            "+faststart",
            out_path.to_str().unwrap_or(""),
        ]);
        cmd.stdout(Stdio::null());
        cmd.stderr(Stdio::null());

        let success = match cmd.status().await {
            Ok(status) => status.success(),
            Err(e) => {
                eprintln!("[BG_UPLOAD] ffmpeg spawn failed: {}", e);
                false
            }
        };

        let _ = fs::remove_file(&tmp_input).await;

        if success && out_path.exists() {
            let final_size = fs::metadata(&out_path).await.map(|m| m.len()).unwrap_or(0);
            return Ok(Json(json!({
                "status": "ok",
                "url": format!("/cache/backgrounds/{}", out_filename),
                "mediaType": "video",
                "name": original_name,
                "size": final_size
            })));
        } else {
            // Fallback: save raw data
            let fallback_name = format!("{}.mp4", file_id);
            let fallback_path = bg_dir.join(&fallback_name);
            let _ = fs::write(&fallback_path, &raw_data).await;
            return Ok(Json(json!({
                "status": "ok",
                "url": format!("/cache/backgrounds/{}", fallback_name),
                "mediaType": "video",
                "name": original_name,
                "size": raw_data.len()
            })));
        }
    } else {
        // Static image (PNG/JPEG/WEBP)
        let ext = if lower_name.ends_with(".png") {
            "png"
        } else if lower_name.ends_with(".webp") {
            "webp"
        } else {
            "jpg"
        };
        let out_filename = format!("{}.{}", file_id, ext);
        let out_path = bg_dir.join(&out_filename);
        let _ = fs::write(&out_path, &raw_data).await;
        let _ = fs::remove_file(&tmp_input).await;

        return Ok(Json(json!({
            "status": "ok",
            "url": format!("/cache/backgrounds/{}", out_filename),
            "mediaType": "image",
            "name": original_name,
            "size": raw_data.len()
        })));
    }
}
