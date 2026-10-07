use crossterm::{
    event::{self, DisableMouseCapture, EnableMouseCapture, Event, KeyCode},
    execute,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use ratatui::{
    backend::CrosstermBackend,
    layout::{Alignment, Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, BorderType, Borders, Clear, Gauge, List, ListItem, ListState, Paragraph, Wrap},
    Frame, Terminal,
};
use serde::{Deserialize, Serialize};
use std::{
    io,
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};
use tokio::sync::mpsc;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Track {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub duration: f64,
    pub audio_url: String,
    pub cover_url: Option<String>,
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

#[derive(Debug, Clone)]
pub struct LrcLine {
    pub time_sec: f64,
    pub text: String,
}

pub struct AudioPlayer {
    process: Option<Child>,
    current_track: Option<Track>,
    playback_start: Option<Instant>,
    playback_offset: Duration,
    is_paused: bool,
    volume: u32,
}

impl AudioPlayer {
    pub fn new() -> Self {
        Self {
            process: None,
            current_track: None,
            playback_start: None,
            playback_offset: Duration::ZERO,
            is_paused: false,
            volume: 100,
        }
    }

    pub fn play(&mut self, track: Track, stream_url: &str) {
        self.stop();

        let child = Command::new("ffplay")
            .arg("-nodisp")
            .arg("-autoexit")
            .arg("-volume")
            .arg(self.volume.to_string())
            .arg("-loglevel")
            .arg("quiet")
            .arg(stream_url)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();

        match child {
            Ok(p) => {
                self.process = Some(p);
                self.current_track = Some(track);
                self.playback_start = Some(Instant::now());
                self.playback_offset = Duration::ZERO;
                self.is_paused = false;
            }
            Err(_) => {
                self.process = None;
            }
        }
    }

    pub fn stop(&mut self) {
        if let Some(mut p) = self.process.take() {
            let _ = p.kill();
            let _ = p.wait();
        }
        self.current_track = None;
        self.playback_start = None;
        self.playback_offset = Duration::ZERO;
        self.is_paused = false;
    }

    pub fn toggle_pause(&mut self) {
        if self.process.is_none() {
            return;
        }

        if self.is_paused {
            self.playback_start = Some(Instant::now());
            self.is_paused = false;
        } else {
            if let Some(start) = self.playback_start {
                self.playback_offset += start.elapsed();
            }
            self.playback_start = None;
            self.is_paused = true;
        }
    }

    pub fn get_position_sec(&self) -> f64 {
        if self.is_paused {
            return self.playback_offset.as_secs_f64();
        }
        if let Some(start) = self.playback_start {
            return (self.playback_offset + start.elapsed()).as_secs_f64();
        }
        0.0
    }

    pub fn is_playing(&mut self) -> bool {
        if let Some(p) = &mut self.process {
            match p.try_wait() {
                Ok(Some(_)) => {
                    self.process = None;
                    self.playback_start = None;
                    false
                }
                Ok(None) => true,
                Err(_) => false,
            }
        } else {
            false
        }
    }
}

pub fn parse_lrc(raw: &str) -> Vec<LrcLine> {
    let mut lines = Vec::new();
    for l in raw.lines() {
        let trimmed = l.trim();
        if trimmed.is_empty() || trimmed.starts_with("[ar:") || trimmed.starts_with("[ti:") || trimmed.starts_with("[al:") || trimmed.starts_with("[by:") {
            continue;
        }

        let mut pos = 0;
        let bytes = trimmed.as_bytes();
        while pos < bytes.len() && bytes[pos] == b'[' {
            if let Some(close_idx) = trimmed[pos..].find(']') {
                let tag = &trimmed[pos + 1..pos + close_idx];
                let parts: Vec<&str> = tag.split(':').collect();
                if parts.len() == 2 {
                    if let (Ok(m), Ok(s)) = (parts[0].parse::<f64>(), parts[1].parse::<f64>()) {
                        let text = trimmed[pos + close_idx + 1..].trim();
                        let clean_text = text
                            .chars()
                            .filter(|c| *c != '<' && *c != '>')
                            .collect::<String>();
                        lines.push(LrcLine {
                            time_sec: m * 60.0 + s,
                            text: clean_text,
                        });
                    }
                }
                pos += close_idx + 1;
            } else {
                break;
            }
        }
    }
    lines.sort_by(|a, b| a.time_sec.partial_cmp(&b.time_sec).unwrap_or(std::cmp::Ordering::Equal));
    lines
}

#[derive(PartialEq)]
pub enum Mode {
    Normal,
    Search,
    Help,
}

pub enum AppEvent {
    SearchCompleted(Vec<Track>),
    LyricsLoaded(Vec<LrcLine>, String),
}

pub struct App {
    pub mode: Mode,
    pub backend_url: String,
    pub search_input: String,
    pub search_results: Vec<Track>,
    pub list_state: ListState,
    pub player: AudioPlayer,
    pub lyrics: Vec<LrcLine>,
    pub lyrics_source: String,
    pub lyrics_scroll: usize,
    pub status_message: String,
    pub is_searching: bool,
    pub is_lyrics_loading: bool,
    pub http_client: reqwest::Client,
    pub tx: mpsc::Sender<AppEvent>,
}

impl App {
    pub fn new(backend_url: String, tx: mpsc::Sender<AppEvent>) -> Self {
        let mut list_state = ListState::default();
        list_state.select(Some(0));

        Self {
            mode: Mode::Normal,
            backend_url,
            search_input: String::new(),
            search_results: Vec::new(),
            list_state,
            player: AudioPlayer::new(),
            lyrics: Vec::new(),
            lyrics_source: String::new(),
            lyrics_scroll: 0,
            status_message: "Нажмите '/' для поиска треков, '?' для помощи".to_string(),
            is_searching: false,
            is_lyrics_loading: false,
            http_client: reqwest::Client::new(),
            tx,
        }
    }

    pub fn trigger_search(&mut self) {
        let q = self.search_input.trim().to_string();
        if q.is_empty() {
            return;
        }

        self.is_searching = true;
        self.status_message = format!("Поиск '{}'...", q);
        let client = self.http_client.clone();
        let backend = self.backend_url.clone();
        let tx = self.tx.clone();

        tokio::spawn(async move {
            let url = format!("{}/api/search?q={}", backend, urlencoding::encode(&q));
            let tracks: Vec<Track> = match client.get(&url).timeout(Duration::from_secs(12)).send().await {
                Ok(r) if r.status().is_success() => r.json().await.unwrap_or_default(),
                _ => Vec::new(),
            };
            let _ = tx.send(AppEvent::SearchCompleted(tracks)).await;
        });
    }

    pub fn load_lyrics_for_track(&mut self, track: &Track) {
        self.is_lyrics_loading = true;
        self.lyrics.clear();
        self.lyrics_source.clear();

        let client = self.http_client.clone();
        let backend = self.backend_url.clone();
        let tx = self.tx.clone();
        let title = track.title.clone();
        let artist = track.artist.clone();
        let dur = track.duration;

        tokio::spawn(async move {
            let url = format!(
                "{}/api/lyrics?title={}&artist={}&duration={}",
                backend,
                urlencoding::encode(&title),
                urlencoding::encode(&artist),
                dur.round() as u64
            );
            if let Ok(r) = client.get(&url).timeout(Duration::from_secs(8)).send().await {
                if r.status().is_success() {
                    if let Ok(data) = r.json::<LyricsResponse>().await {
                        let parsed = parse_lrc(&data.lyrics);
                        let _ = tx.send(AppEvent::LyricsLoaded(parsed, data.source)).await;
                        return;
                    }
                }
            }
            let _ = tx.send(AppEvent::LyricsLoaded(Vec::new(), String::new())).await;
        });
    }

    pub fn play_selected(&mut self) {
        if let Some(sel) = self.list_state.selected() {
            if let Some(track) = self.search_results.get(sel).cloned() {
                let stream_url = format!(
                    "{}/api/stream?id={}&url={}&title={}&artist={}",
                    self.backend_url,
                    urlencoding::encode(&track.id),
                    urlencoding::encode(&track.audio_url),
                    urlencoding::encode(&track.title),
                    urlencoding::encode(&track.artist)
                );

                self.status_message = format!("Воспроизведение: {} - {}", track.artist, track.title);
                self.load_lyrics_for_track(&track);
                self.player.play(track, &stream_url);
            }
        }
    }

    pub fn next_track_in_list(&mut self) {
        if self.search_results.is_empty() {
            return;
        }
        let i = match self.list_state.selected() {
            Some(i) => {
                if i >= self.search_results.len() - 1 {
                    0
                } else {
                    i + 1
                }
            }
            None => 0,
        };
        self.list_state.select(Some(i));
    }

    pub fn prev_track_in_list(&mut self) {
        if self.search_results.is_empty() {
            return;
        }
        let i = match self.list_state.selected() {
            Some(i) => {
                if i == 0 {
                    self.search_results.len() - 1
                } else {
                    i - 1
                }
            }
            None => 0,
        };
        self.list_state.select(Some(i));
    }
}

fn format_time(sec: f64) -> String {
    let s = sec.max(0.0) as u64;
    let m = s / 60;
    let rem = s % 60;
    format!("{:02}:{:02}", m, rem)
}

fn ui(f: &mut Frame, app: &mut App) {
    let size = f.area();

    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3),
            Constraint::Min(10),
            Constraint::Length(4),
            Constraint::Length(1),
        ])
        .split(size);

    let header_rect = chunks[0];
    let main_rect = chunks[1];
    let player_rect = chunks[2];
    let footer_rect = chunks[3];

    let header_title = Span::styled(
        " 🎵 RECRO MUSIC TUI ",
        Style::default()
            .fg(Color::Cyan)
            .add_modifier(Modifier::BOLD),
    );
    let search_disp = if app.mode == Mode::Search {
        format!(" [Поиск]: {}_ ", app.search_input)
    } else if !app.search_input.is_empty() {
        format!(" [Запрос]: {} ", app.search_input)
    } else {
        " [/] Искать треки | [Пробел] Пауза | [Enter] Играть | [?] Справка ".to_string()
    };

    let header_widget = Paragraph::new(search_disp)
        .block(
            Block::default()
                .borders(Borders::ALL)
                .border_type(BorderType::Rounded)
                .border_style(if app.mode == Mode::Search {
                    Style::default().fg(Color::Yellow)
                } else {
                    Style::default().fg(Color::DarkGray)
                })
                .title(header_title),
        )
        .alignment(Alignment::Left);
    f.render_widget(header_widget, header_rect);

    let main_columns = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(50), Constraint::Percentage(50)])
        .split(main_rect);

    let results_rect = main_columns[0];
    let lyrics_rect = main_columns[1];

    let items: Vec<ListItem> = app
        .search_results
        .iter()
        .enumerate()
        .map(|(idx, track)| {
            let dur = format_time(track.duration);
            let line = Line::from(vec![
                Span::styled(
                    format!("{:2}. ", idx + 1),
                    Style::default().fg(Color::DarkGray),
                ),
                Span::styled(
                    &track.artist,
                    Style::default()
                        .fg(Color::White)
                        .add_modifier(Modifier::BOLD),
                ),
                Span::raw(" - "),
                Span::styled(&track.title, Style::default().fg(Color::Gray)),
                Span::raw(" "),
                Span::styled(
                    format!("[{}]", dur),
                    Style::default().fg(Color::DarkGray),
                ),
            ]);
            ListItem::new(line)
        })
        .collect();

    let list_widget = List::new(items)
        .block(
            Block::default()
                .borders(Borders::ALL)
                .border_type(BorderType::Rounded)
                .border_style(Style::default().fg(Color::DarkGray))
                .title(Span::styled(
                    format!(" Результаты ({}) ", app.search_results.len()),
                    Style::default()
                        .fg(Color::Green)
                        .add_modifier(Modifier::BOLD),
                )),
        )
        .highlight_style(
            Style::default()
                .bg(Color::Rgb(30, 41, 59))
                .fg(Color::Cyan)
                .add_modifier(Modifier::BOLD),
        )
        .highlight_symbol("▶ ");

    f.render_stateful_widget(list_widget, results_rect, &mut app.list_state);

    let cur_pos = app.player.get_position_sec();
    let mut active_idx: Option<usize> = None;
    if !app.lyrics.is_empty() {
        for (i, l) in app.lyrics.iter().enumerate() {
            if cur_pos >= l.time_sec {
                active_idx = Some(i);
            } else {
                break;
            }
        }
    }

    let lyrics_title = if app.is_lyrics_loading {
        " Текст песни (Загрузка...) ".to_string()
    } else if !app.lyrics_source.is_empty() {
        format!(" Текст песни [{}] ", app.lyrics_source)
    } else {
        " Текст песни ".to_string()
    };

    let mut lyrics_lines = Vec::new();
    if app.lyrics.is_empty() {
        if app.is_lyrics_loading {
            lyrics_lines.push(Line::from(Span::styled(
                "Поиск караоке таймингов...",
                Style::default().fg(Color::DarkGray),
            )));
        } else {
            lyrics_lines.push(Line::from(Span::styled(
                "Текст не загружен или не найден",
                Style::default().fg(Color::DarkGray),
            )));
        }
    } else {
        let view_height = lyrics_rect.height.saturating_sub(2) as usize;
        let center_offset = view_height / 2;
        let start_idx = active_idx
            .unwrap_or(0)
            .saturating_sub(center_offset);

        for (i, l) in app.lyrics.iter().enumerate().skip(start_idx).take(view_height) {
            let is_active = active_idx == Some(i);
            let time_tag = format_time(l.time_sec);

            let line = if is_active {
                Line::from(vec![
                    Span::styled(
                        format!("{} ▶ ", time_tag),
                        Style::default().fg(Color::Yellow),
                    ),
                    Span::styled(
                        &l.text,
                        Style::default()
                            .fg(Color::Yellow)
                            .add_modifier(Modifier::BOLD),
                    ),
                ])
            } else {
                Line::from(vec![
                    Span::styled(
                        format!("{}   ", time_tag),
                        Style::default().fg(Color::DarkGray),
                    ),
                    Span::styled(&l.text, Style::default().fg(Color::Gray)),
                ])
            };
            lyrics_lines.push(line);
        }
    }

    let lyrics_widget = Paragraph::new(lyrics_lines)
        .block(
            Block::default()
                .borders(Borders::ALL)
                .border_type(BorderType::Rounded)
                .border_style(Style::default().fg(Color::DarkGray))
                .title(Span::styled(
                    lyrics_title,
                    Style::default()
                        .fg(Color::Magenta)
                        .add_modifier(Modifier::BOLD),
                )),
        )
        .alignment(Alignment::Left);
    f.render_widget(lyrics_widget, lyrics_rect);

    let cur_track = app.player.current_track.as_ref();
    let track_title = cur_track
        .map(|t| format!("{} - {}", t.artist, t.title))
        .unwrap_or_else(|| "Нет активного воспроизведения".to_string());

    let total_dur = cur_track.map(|t| t.duration).unwrap_or(0.0);
    let ratio = if total_dur > 0.0 {
        (cur_pos / total_dur).min(1.0).max(0.0)
    } else {
        0.0
    };

    let status_str = if app.player.is_paused {
        "⏸ ПАУЗА"
    } else if cur_track.is_some() {
        "▶ ИГРАЕТ"
    } else {
        "⏹ СТОП"
    };

    let gauge_label = format!("{} / {}", format_time(cur_pos), format_time(total_dur));
    let player_block = Block::default()
        .borders(Borders::ALL)
        .border_type(BorderType::Rounded)
        .border_style(Style::default().fg(Color::DarkGray))
        .title(Span::styled(
            format!(" {} | {} ", status_str, track_title),
            Style::default()
                .fg(Color::Cyan)
                .add_modifier(Modifier::BOLD),
        ));

    let gauge = Gauge::default()
        .block(player_block)
        .gauge_style(
            Style::default()
                .fg(Color::Cyan)
                .bg(Color::Rgb(30, 41, 59)),
        )
        .ratio(ratio)
        .label(gauge_label);

    f.render_widget(gauge, player_rect);

    let footer_widget = Paragraph::new(Line::from(vec![
        Span::styled(" Статус: ", Style::default().fg(Color::DarkGray)),
        Span::styled(&app.status_message, Style::default().fg(Color::White)),
    ]))
    .alignment(Alignment::Left);
    f.render_widget(footer_widget, footer_rect);

    if app.mode == Mode::Help {
        let help_rect = centered_rect(60, 50, size);
        f.render_widget(Clear, help_rect);

        let help_text = vec![
            Line::from(Span::styled(
                "Горячие клавиши управления Recro TUI",
                Style::default()
                    .fg(Color::Yellow)
                    .add_modifier(Modifier::BOLD),
            )),
            Line::from(""),
            Line::from(vec![
                Span::styled(" /            ", Style::default().fg(Color::Cyan)),
                Span::raw("Активировать строку поиска"),
            ]),
            Line::from(vec![
                Span::styled(" Enter        ", Style::default().fg(Color::Cyan)),
                Span::raw("Подтвердить поиск или воспроизвести трек"),
            ]),
            Line::from(vec![
                Span::styled(" j / Down     ", Style::default().fg(Color::Cyan)),
                Span::raw("Следующий трек в списке"),
            ]),
            Line::from(vec![
                Span::styled(" k / Up       ", Style::default().fg(Color::Cyan)),
                Span::raw("Предыдущий трек в списке"),
            ]),
            Line::from(vec![
                Span::styled(" Space        ", Style::default().fg(Color::Cyan)),
                Span::raw("Пауза / Продолжить воспроизведение"),
            ]),
            Line::from(vec![
                Span::styled(" s            ", Style::default().fg(Color::Cyan)),
                Span::raw("Остановить трек"),
            ]),
            Line::from(vec![
                Span::styled(" ?            ", Style::default().fg(Color::Cyan)),
                Span::raw("Показать / скрыть эту справку"),
            ]),
            Line::from(vec![
                Span::styled(" q / Esc      ", Style::default().fg(Color::Cyan)),
                Span::raw("Выход из режима или выход из программы"),
            ]),
        ];

        let help_widget = Paragraph::new(help_text)
            .block(
                Block::default()
                    .borders(Borders::ALL)
                    .border_type(BorderType::Double)
                    .border_style(Style::default().fg(Color::Yellow))
                    .title(" Справка "),
            )
            .alignment(Alignment::Left)
            .wrap(Wrap { trim: true });

        f.render_widget(help_widget, help_rect);
    }
}

fn centered_rect(percent_x: u16, percent_y: u16, r: Rect) -> Rect {
    let popup_layout = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Percentage((100 - percent_y) / 2),
            Constraint::Percentage(percent_y),
            Constraint::Percentage((100 - percent_y) / 2),
        ])
        .split(r);

    Layout::default()
        .direction(Direction::Horizontal)
        .constraints([
            Constraint::Percentage((100 - percent_x) / 2),
            Constraint::Percentage(percent_x),
            Constraint::Percentage((100 - percent_x) / 2),
        ])
        .split(popup_layout[1])[1]
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let backend_url = std::env::var("RECRO_BACKEND_URL")
        .unwrap_or_else(|_| "https://signal-audio-backend-production.up.railway.app".to_string());

    enable_raw_mode()?;
    let mut stdout = io::stdout();
    execute!(stdout, EnterAlternateScreen, EnableMouseCapture)?;
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;

    let (tx, mut rx) = mpsc::channel::<AppEvent>(32);
    let mut app = App::new(backend_url, tx);

    let tick_rate = Duration::from_millis(50);
    let mut last_tick = Instant::now();

    loop {
        terminal.draw(|f| ui(f, &mut app))?;

        let _ = app.player.is_playing();

        while let Ok(ev) = rx.try_recv() {
            match ev {
                AppEvent::SearchCompleted(tracks) => {
                    app.is_searching = false;
                    app.status_message = format!("Найдено {} треков", tracks.len());
                    app.search_results = tracks;
                    if !app.search_results.is_empty() {
                        app.list_state.select(Some(0));
                    }
                }
                AppEvent::LyricsLoaded(lines, source) => {
                    app.is_lyrics_loading = false;
                    app.lyrics = lines;
                    app.lyrics_source = source;
                }
            }
        }

        let timeout = tick_rate
            .checked_sub(last_tick.elapsed())
            .unwrap_or_else(|| Duration::from_secs(0));

        if crossterm::event::poll(timeout)? {
            if let Event::Key(key) = event::read()? {
                match app.mode {
                    Mode::Search => match key.code {
                        KeyCode::Enter => {
                            app.mode = Mode::Normal;
                            app.trigger_search();
                        }
                        KeyCode::Esc => {
                            app.mode = Mode::Normal;
                        }
                        KeyCode::Backspace => {
                            app.search_input.pop();
                        }
                        KeyCode::Char(c) => {
                            app.search_input.push(c);
                        }
                        _ => {}
                    },
                    Mode::Help => match key.code {
                        KeyCode::Esc | KeyCode::Char('q') | KeyCode::Char('?') => {
                            app.mode = Mode::Normal;
                        }
                        _ => {}
                    },
                    Mode::Normal => match key.code {
                        KeyCode::Char('q') => {
                            break;
                        }
                        KeyCode::Char('/') => {
                            app.mode = Mode::Search;
                            app.search_input.clear();
                        }
                        KeyCode::Char('?') => {
                            app.mode = Mode::Help;
                        }
                        KeyCode::Char(' ') => {
                            app.player.toggle_pause();
                        }
                        KeyCode::Char('s') => {
                            app.player.stop();
                            app.lyrics.clear();
                            app.lyrics_source.clear();
                            app.status_message = "Воспроизведение остановлено".to_string();
                        }
                        KeyCode::Down | KeyCode::Char('j') => {
                            app.next_track_in_list();
                        }
                        KeyCode::Up | KeyCode::Char('k') => {
                            app.prev_track_in_list();
                        }
                        KeyCode::Enter => {
                            app.play_selected();
                        }
                        _ => {}
                    },
                }
            }
        }

        if last_tick.elapsed() >= tick_rate {
            last_tick = Instant::now();
        }
    }

    app.player.stop();

    disable_raw_mode()?;
    execute!(
        terminal.backend_mut(),
        LeaveAlternateScreen,
        DisableMouseCapture
    )?;
    terminal.show_cursor()?;

    Ok(())
}
