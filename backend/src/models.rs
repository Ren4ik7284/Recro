use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
pub struct SearchParams {
    pub q: String,
}

#[derive(Debug, Deserialize)]
pub struct ExtractParams {
    pub url: String,
}

fn deserialize_bool_lenient<'de, D>(deserializer: D) -> Result<Option<bool>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use serde::de::Visitor;
    use std::fmt;

    struct BoolLenientVisitor;

    impl<'de> Visitor<'de> for BoolLenientVisitor {
        type Value = Option<bool>;

        fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
            formatter.write_str("a boolean, 0, 1, '0', '1', 'true', or 'false'")
        }

        fn visit_bool<E>(self, v: bool) -> Result<Self::Value, E> {
            Ok(Some(v))
        }

        fn visit_i64<E>(self, v: i64) -> Result<Self::Value, E> {
            Ok(Some(v != 0))
        }

        fn visit_u64<E>(self, v: u64) -> Result<Self::Value, E> {
            Ok(Some(v != 0))
        }

        fn visit_str<E>(self, v: &str) -> Result<Self::Value, E> {
            match v.trim().to_lowercase().as_str() {
                "true" | "1" | "yes" | "on" => Ok(Some(true)),
                "false" | "0" | "no" | "off" => Ok(Some(false)),
                _ => Ok(None),
            }
        }

        fn visit_none<E>(self) -> Result<Self::Value, E> {
            Ok(None)
        }

        fn visit_some<D2>(self, deserializer: D2) -> Result<Self::Value, D2::Error>
        where
            D2: serde::Deserializer<'de>,
        {
            deserializer.deserialize_any(self)
        }
    }

    deserializer.deserialize_any(BoolLenientVisitor)
}

#[derive(Debug, Deserialize)]
pub struct StreamParams {
    pub url: Option<String>,
    pub id: Option<String>,
    pub ss: Option<u64>,
    pub title: Option<String>,
    pub artist: Option<String>,
    #[serde(default, deserialize_with = "deserialize_bool_lenient")]
    pub prefetch: Option<bool>,
    #[serde(default, deserialize_with = "deserialize_bool_lenient")]
    pub is_live: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct CoverParams {
    pub url: Option<String>,
    pub title: Option<String>,
    pub artist: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchTrack {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub duration: f64,
    pub audio_url: String,
    pub cover_url: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ExtractResponse {
    pub playlist_title: Option<String>,
    pub tracks: Vec<SearchTrack>,
    #[serde(default)]
    pub main_video: Option<SearchTrack>,
    #[serde(default)]
    pub is_radio_mix: bool,
    #[serde(default)]
    pub has_chapters: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChartArtist {
    pub position: usize,
    pub name: String,
    pub picture: Option<String>,
}

