use axum::{
    extract::Query,
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
};
use std::time::Duration;

use crate::models::CoverParams;
use crate::security::check_url_ssrf;

pub async fn health_check() -> &'static str {
    "Recro // Rust Engine Online"
}

pub async fn proxy_cover(Query(params): Query<CoverParams>) -> Result<Response, StatusCode> {
    let target = params.url.trim();
    if target.is_empty() || (!target.starts_with("http://") && !target.starts_with("https://")) {
        return Err(StatusCode::BAD_REQUEST);
    }

    check_url_ssrf(target).await?;

    let redirect_policy = reqwest::redirect::Policy::custom(|attempt| {
        if attempt.previous().len() >= 5 {
            attempt.error("too many redirects")
        } else {
            if let Some(host) = attempt.url().host_str() {
                let lower = host.to_lowercase();
                if lower == "localhost"
                    || lower.ends_with(".local")
                    || lower.ends_with(".internal")
                    || lower.ends_with(".lan")
                {
                    return attempt.error("redirect to internal host forbidden");
                }
                if let Ok(ip) = host.parse::<std::net::IpAddr>() {
                    if crate::security::is_private_or_restricted_ip(ip) {
                        return attempt.error("redirect to private IP forbidden");
                    }
                }
            }
            attempt.follow()
        }
    });

    let client = reqwest::Client::builder()
        .redirect(redirect_policy)
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let resp = client
        .get(target)
        .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36")
        .send()
        .await
        .map_err(|_| StatusCode::BAD_GATEWAY)?;

    if !resp.status().is_success() {
        return Err(StatusCode::BAD_GATEWAY);
    }

    if let Some(len) = resp.content_length() {
        if len > 10 * 1024 * 1024 {
            return Err(StatusCode::PAYLOAD_TOO_LARGE);
        }
    }

    let content_type = resp
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("image/jpeg")
        .to_string();

    let ct_lower = content_type.to_lowercase();
    if !ct_lower.starts_with("image/") && ct_lower != "application/octet-stream" {
        return Err(StatusCode::BAD_REQUEST);
    }

    let bytes = resp.bytes().await.map_err(|_| StatusCode::BAD_GATEWAY)?;
    if bytes.len() > 10 * 1024 * 1024 {
        return Err(StatusCode::PAYLOAD_TOO_LARGE);
    }

    let mut res_headers = HeaderMap::new();
    let valid_ct = HeaderValue::from_str(&content_type)
        .unwrap_or_else(|_| HeaderValue::from_static("image/jpeg"));
    res_headers.insert(header::CONTENT_TYPE, valid_ct);
    res_headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=604800, immutable"),
    );
    res_headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));

    Ok((StatusCode::OK, res_headers, bytes).into_response())
}
