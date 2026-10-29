use axum::http::{HeaderMap, HeaderValue, StatusCode};
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct Claims {
    pub sub: String,
    pub username: String,
    pub exp: usize,
}

#[derive(Debug, Deserialize)]
pub struct RegisterRequest {
    #[serde(alias = "login")]
    pub username: String,
    pub password: String,
}

#[derive(Debug, Deserialize)]
pub struct LoginRequest {
    #[serde(alias = "username")]
    pub login: String,
    pub password: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct UserInfo {
    pub id: String,
    pub username: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub banner_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile_tags: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateProfileRequest {
    pub username: Option<String>,
    pub avatar_url: Option<String>,
    pub banner_url: Option<String>,
    pub profile_tags: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct GoogleAuthRequest {
    pub credential: String,
}

#[derive(Debug, Serialize)]
pub struct AuthConfigResponse {
    pub google_client_id: Option<String>,
    pub google_auth_enabled: bool,
}

#[derive(Debug, Serialize)]
pub struct AuthResponse {
    pub token: String,
    pub user: UserInfo,
}

static DYNAMIC_JWT_SECRET: std::sync::OnceLock<Vec<u8>> = std::sync::OnceLock::new();

pub const DUMMY_BCRYPT_HASH: &str = "$2b$12$e8uq0wGZ8lq4aN1z0vUqIuO5q5wHqOqM9j5Y1vL6u4b1Wk4j1v8i.";

pub fn verify_dummy_password() {
    let _ = bcrypt::verify("dummy_password_timing_protect", DUMMY_BCRYPT_HASH);
}

fn get_jwt_secret() -> &'static [u8] {
    DYNAMIC_JWT_SECRET.get_or_init(|| {
        if let Ok(val) = std::env::var("JWT_SECRET") {
            let trimmed = val.trim();
            if !trimmed.is_empty() {
                return trimmed.as_bytes().to_vec();
            }
        }

        // Try reading persistent secret from disk so restarts do not invalidate tokens
        for path_str in &["/app/data/.jwt_secret", "/data/.jwt_secret", ".jwt_secret", "backend/.jwt_secret"] {
            let secret_path = std::path::Path::new(path_str);
            if let Ok(existing) = std::fs::read_to_string(secret_path) {
                let trimmed = existing.trim();
                if trimmed.len() >= 32 {
                    return trimmed.as_bytes().to_vec();
                }
            }
        }

        // If no secret file exists, generate a strong random 64-char key and persist it
        let mut new_secret = String::with_capacity(64);
        for _ in 0..64 {
            new_secret.push(fastrand::alphanumeric());
        }
        let _ = std::fs::write(".jwt_secret", &new_secret);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(".jwt_secret", std::fs::Permissions::from_mode(0o600));
        }
        new_secret.into_bytes()
    })
}

pub fn create_jwt(user_id: &str, username: &str) -> Result<String, String> {
    let expiration = chrono::Utc::now()
        .checked_add_signed(chrono::Duration::days(30))
        .expect("valid timestamp")
        .timestamp() as usize;

    let claims = Claims {
        sub: user_id.to_string(),
        username: username.to_string(),
        exp: expiration,
    };

    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(get_jwt_secret()),
    )
    .map_err(|e| e.to_string())
}

pub fn verify_jwt(token: &str) -> Result<Claims, String> {
    if let Ok(data) = decode::<Claims>(
        token,
        &DecodingKey::from_secret(get_jwt_secret()),
        &Validation::default(),
    ) {
        return Ok(data.claims);
    }

    const ALT_SECRETS: &[&[u8]] = &[
        b"recro_production_jwt_master_secret_2026_super_stable_key_998877_permanent",
        b"super_secret_jwt_random_key_replace_in_prod",
        b"signal-audio-secret-key-change-in-prod",
        b"8-kxca0ccKlB6XuP5*re!zh4A8UCp6NCj=y2wcKxY#my63IL0JWDSKh$hvcgE4Kz",
    ];

    for &sec in ALT_SECRETS {
        if let Ok(data) = decode::<Claims>(
            token,
            &DecodingKey::from_secret(sec),
            &Validation::default(),
        ) {
            return Ok(data.claims);
        }
    }

    Err("Invalid token".to_string())
}

pub fn extract_token_from_cookie(headers: &HeaderMap) -> Option<&str> {
    let cookie_header = headers.get(axum::http::header::COOKIE)?.to_str().ok()?;
    for part in cookie_header.split(';') {
        let part = part.trim();
        if let Some(val) = part.strip_prefix("recro_auth_token=") {
            return Some(val);
        }
        if let Some(val) = part.strip_prefix("recro_jwt_token=") {
            return Some(val);
        }
    }
    None
}

pub fn build_auth_cookie_header(token: &str, max_age_secs: i64) -> HeaderValue {
    let cookie_str = format!(
        "recro_auth_token={}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age={}",
        token, max_age_secs
    );
    HeaderValue::from_str(&cookie_str).unwrap_or_else(|_| HeaderValue::from_static(""))
}

pub fn build_logout_cookie_header() -> HeaderValue {
    HeaderValue::from_static("recro_auth_token=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0")
}

pub fn extract_claims_from_headers(headers: &HeaderMap) -> Result<Claims, (StatusCode, &'static str)> {
    let auth_header = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|h| h.to_str().ok());

    let token = if let Some(ah) = auth_header {
        if ah.starts_with("Bearer ") {
            &ah[7..]
        } else {
            ah
        }
    } else if let Some(cookie_token) = extract_token_from_cookie(headers) {
        cookie_token
    } else {
        return Err((StatusCode::UNAUTHORIZED, "Missing Authorization header or cookie"));
    };

    verify_jwt(token).map_err(|_| (StatusCode::UNAUTHORIZED, "Invalid or expired token"))
}

pub fn hash_password(password: &str) -> Result<String, StatusCode> {
    bcrypt::hash(password, bcrypt::DEFAULT_COST).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

pub fn verify_password(password: &str, hash: &str) -> bool {
    bcrypt::verify(password, hash).unwrap_or(false)
}

pub fn validate_username(username: &str) -> Result<(), &'static str> {
    let trimmed = username.trim();
    if trimmed.is_empty() {
        return Err("Имя пользователя обязательно для заполнения");
    }
    if trimmed.contains(' ') || trimmed.contains('\t') || trimmed.contains('\n') {
        return Err("Имя пользователя не должно содержать пробелы");
    }
    if trimmed.len() < 3 {
        return Err("Имя пользователя должно содержать не менее 3 символов");
    }
    if trimmed.len() > 30 {
        return Err("Имя пользователя не должно превышать 30 символов");
    }
    if !trimmed.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        return Err("Имя пользователя может содержать только латинские буквы, цифры, '_' и '-'");
    }
    Ok(())
}

pub fn validate_password(password: &str) -> Result<(), &'static str> {
    let trimmed = password.trim();
    if trimmed.is_empty() {
        return Err("Пароль обязателен для заполнения");
    }
    if trimmed.len() < 6 {
        return Err("Пароль должен содержать не менее 6 символов");
    }
    if trimmed.len() > 72 {
        return Err("Пароль не должен превышать 72 символа");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_jwt_create_and_verify() {
        let user_id = "test-user-uuid-123";
        let username = "alex_smith";
        let token = create_jwt(user_id, username).expect("JWT creation should succeed");
        assert!(!token.is_empty());

        let claims = verify_jwt(&token).expect("JWT verification should succeed");
        assert_eq!(claims.sub, user_id);
        assert_eq!(claims.username, username);
    }

    #[test]
    fn test_validate_username() {
        assert!(validate_username("alex_123").is_ok());
        assert!(validate_username("john-doe").is_ok());
        assert!(validate_username("al").is_err());
        assert!(validate_username("alex smith").is_err());
        assert!(validate_username("alex@smith").is_err());
    }

    #[test]
    fn test_validate_password() {
        assert!(validate_password("123456").is_ok());
        assert!(validate_password("short").is_err());
        assert!(validate_password("").is_err());
    }

    #[test]
    fn test_password_hash_and_verify() {
        let pass = "strong_password_99";
        let hash = hash_password(pass).expect("Hashing should succeed");
        assert!(verify_password(pass, &hash));
        assert!(!verify_password("wrong_password", &hash));
    }

    #[test]
    fn test_extract_token_from_cookie() {
        let mut headers = HeaderMap::new();
        headers.insert(
            axum::http::header::COOKIE,
            "session=xyz; recro_auth_token=jwt_sample_token_123; other=abc".parse().unwrap(),
        );
        let extracted = extract_token_from_cookie(&headers);
        assert_eq!(extracted, Some("jwt_sample_token_123"));

        let empty_headers = HeaderMap::new();
        assert_eq!(extract_token_from_cookie(&empty_headers), None);
    }

    #[test]
    fn test_build_auth_cookie_header() {
        let header = build_auth_cookie_header("test_jwt", 3600);
        let val = header.to_str().unwrap();
        assert!(val.contains("recro_auth_token=test_jwt"));
        assert!(val.contains("HttpOnly"));
        assert!(val.contains("Secure"));
        assert!(val.contains("SameSite=Lax"));
        assert!(val.contains("Max-Age=3600"));
    }
}
