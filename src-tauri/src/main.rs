#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    error::Error,
    io::{self, BufRead, BufReader, Read, Write},
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{mpsc, Mutex},
    thread,
    time::{Duration, Instant},
};

use serde::Deserialize;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager, WebviewWindow, WindowEvent,
};
use tauri_plugin_opener::OpenerExt;
use url::Url;

const LOCAL_URL: &str = "http://127.0.0.1:3000";
const READY_TIMEOUT: Duration = Duration::from_secs(15);

type DesktopResult<T> = Result<T, Box<dyn Error + Send + Sync>>;

#[derive(Debug, Clone, PartialEq, Eq)]
enum RuntimeProbe {
    Compatible(String),
    Free,
    Foreign,
}

#[derive(Default)]
struct RuntimeState {
    owned_child: Option<Child>,
    local_url: Option<String>,
}

#[derive(Default)]
struct DesktopState {
    runtime: Mutex<RuntimeState>,
}

#[derive(Deserialize)]
struct RuntimeResponse {
    product: String,
    version: u8,
    surface: String,
}

#[derive(Deserialize)]
struct ReadinessMessage {
    #[serde(rename = "type")]
    message_type: String,
    #[serde(rename = "localUrl")]
    local_url: String,
}

fn desktop_error(message: impl Into<String>) -> Box<dyn Error + Send + Sync> {
    Box::new(io::Error::new(io::ErrorKind::Other, message.into()))
}

fn is_compatible_runtime_body(body: &str) -> bool {
    serde_json::from_str::<RuntimeResponse>(body)
        .map(|runtime| {
            runtime.product == "agent-remote" && runtime.version == 1 && runtime.surface == "local"
        })
        .unwrap_or(false)
}

fn classify_probe_error(kind: io::ErrorKind) -> RuntimeProbe {
    if kind == io::ErrorKind::ConnectionRefused {
        RuntimeProbe::Free
    } else {
        RuntimeProbe::Foreign
    }
}

fn probe_runtime() -> RuntimeProbe {
    let address: SocketAddr = "127.0.0.1:3000"
        .parse()
        .expect("constant loopback address is valid");
    let mut stream = match TcpStream::connect_timeout(&address, Duration::from_millis(750)) {
        Ok(stream) => stream,
        Err(error) => return classify_probe_error(error.kind()),
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(1)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(1)));
    if stream
        .write_all(
            b"GET /api/runtime HTTP/1.1\r\nHost: 127.0.0.1:3000\r\nConnection: close\r\n\r\n",
        )
        .is_err()
    {
        return RuntimeProbe::Foreign;
    }

    let mut response = String::new();
    if stream.read_to_string(&mut response).is_err() {
        return RuntimeProbe::Foreign;
    }
    let Some((headers, body)) = response.split_once("\r\n\r\n") else {
        return RuntimeProbe::Foreign;
    };
    if headers.lines().next() != Some("HTTP/1.1 200 OK") || !is_compatible_runtime_body(body) {
        return RuntimeProbe::Foreign;
    }
    RuntimeProbe::Compatible(LOCAL_URL.to_owned())
}

fn parse_readiness_line(line: &str) -> Option<String> {
    let ready = serde_json::from_str::<ReadinessMessage>(line).ok()?;
    if ready.message_type == "ready" && ready.local_url.starts_with("http://127.0.0.1:") {
        Some(ready.local_url)
    } else {
        None
    }
}

fn sidecar_file_name(name: &str) -> String {
    format!("{name}-aarch64-apple-darwin")
}

fn resolve_development_sidecar_path(sidecar_dir: &Path, name: &str) -> PathBuf {
    sidecar_dir.join(sidecar_file_name(name))
}

fn resolve_packaged_sidecar_path(sidecar_dir: &Path, name: &str) -> PathBuf {
    sidecar_dir.join(name)
}

fn development_sidecar_dir() -> PathBuf {
    std::env::var_os("AGENT_REMOTE_TAURI_SIDECAR_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries"))
}

fn packaged_sidecar_dir() -> DesktopResult<PathBuf> {
    let executable = std::env::current_exe()?;
    executable
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| desktop_error("The packaged application has no executable directory"))
}

fn cloudflared_path() -> DesktopResult<PathBuf> {
    if cfg!(debug_assertions) {
        Ok(resolve_development_sidecar_path(
            &development_sidecar_dir(),
            "cloudflared",
        ))
    } else {
        Ok(resolve_packaged_sidecar_path(
            &packaged_sidecar_dir()?,
            "cloudflared",
        ))
    }
}

fn server_path() -> DesktopResult<PathBuf> {
    if cfg!(debug_assertions) {
        Ok(resolve_development_sidecar_path(
            &development_sidecar_dir(),
            "agent-remote-server",
        ))
    } else {
        Ok(resolve_packaged_sidecar_path(
            &packaged_sidecar_dir()?,
            "agent-remote-server",
        ))
    }
}

fn stop_child_gracefully(mut child: Child) {
    #[cfg(unix)]
    {
        let _ = Command::new("/bin/kill")
            .args(["-TERM", &child.id().to_string()])
            .status();
    }

    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        match child.try_wait() {
            Ok(Some(_)) | Err(_) => return,
            Ok(None) => thread::sleep(Duration::from_millis(50)),
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn stop_owned_child(state: &DesktopState) {
    let child = state
        .runtime
        .lock()
        .expect("desktop state lock poisoned")
        .owned_child
        .take();
    if let Some(child) = child {
        stop_child_gracefully(child);
    }
}

#[cfg(test)]
fn has_owned_child(state: &DesktopState) -> bool {
    state
        .runtime
        .lock()
        .expect("desktop state lock poisoned")
        .owned_child
        .is_some()
}

fn spawn_owned_backend(state: &DesktopState) -> DesktopResult<String> {
    let server = server_path()?;
    let cloudflared = cloudflared_path()?;
    let mut child = Command::new(&server)
        .env("AGENT_REMOTE_DESKTOP", "1")
        .env("CLOUDFLARED_BIN", &cloudflared)
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|error| desktop_error(format!("Could not start {}: {error}", server.display())))?;
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            stop_child_gracefully(child);
            return Err(desktop_error(
                "The Agent Remote sidecar did not expose stdout",
            ));
        }
    };
    let (lines, receiver) = mpsc::channel();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if lines.send(line).is_err() {
                break;
            }
        }
    });

    state
        .runtime
        .lock()
        .expect("desktop state lock poisoned")
        .owned_child = Some(child);
    let deadline = Instant::now() + READY_TIMEOUT;
    while Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(Instant::now());
        match receiver.recv_timeout(remaining) {
            Ok(line) => {
                if let Some(local_url) = parse_readiness_line(&line) {
                    return Ok(local_url);
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout | mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    stop_owned_child(state);
    Err(desktop_error(
        "Agent Remote did not emit its local readiness message",
    ))
}

fn ensure_backend(state: &DesktopState) -> DesktopResult<String> {
    let local_url = match probe_runtime() {
        RuntimeProbe::Compatible(local_url) => local_url,
        RuntimeProbe::Free => spawn_owned_backend(state)?,
        RuntimeProbe::Foreign => {
            return Err(desktop_error(
                "Port 3000 is already being used by another service. Agent Remote did not change it.",
            ));
        }
    };
    state
        .runtime
        .lock()
        .expect("desktop state lock poisoned")
        .local_url = Some(local_url.clone());
    Ok(local_url)
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn navigate_to_backend(window: &WebviewWindow, local_url: &str) -> DesktopResult<()> {
    window.navigate(Url::parse(local_url)?)?;
    Ok(())
}

fn show_startup_error(window: &WebviewWindow, message: &str) {
    let message = serde_json::to_string(message).expect("error text is serializable");
    let _ = window.eval(&format!("window.showDesktopError({message})"));
}

fn configure_window_lifecycle(window: &WebviewWindow) {
    let window_for_event = window.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = window_for_event.hide();
        }
    });
}

fn install_tray(app: &tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show Agent Remote", true, None::<&str>)?;
    let open = MenuItem::with_id(app, "open", "Open in Browser", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &open, &quit])?;
    TrayIconBuilder::with_id("agent-remote-tray")
        .tooltip("Agent Remote")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_main_window(app),
            "open" => {
                let local_url = app
                    .state::<DesktopState>()
                    .runtime
                    .lock()
                    .expect("desktop state lock poisoned")
                    .local_url
                    .clone();
                if let Some(local_url) = local_url {
                    let _ = app.opener().open_url(local_url, None::<&str>);
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
}

fn main() {
    let app = tauri::Builder::default()
        .manage(DesktopState::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }))
        .setup(|app| -> Result<(), Box<dyn Error>> {
            let window = app.get_webview_window("main").ok_or_else(|| {
                io::Error::new(io::ErrorKind::Other, "The main window was not created")
            })?;
            configure_window_lifecycle(&window);
            install_tray(app)?;
            match ensure_backend(app.state::<DesktopState>().inner()) {
                Ok(local_url) => navigate_to_backend(&window, &local_url)
                    .map_err(|error| io::Error::new(io::ErrorKind::Other, error.to_string()))?,
                Err(error) => show_startup_error(&window, &error.to_string()),
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Agent Remote");
    app.run(|app: &AppHandle, event| {
        if let tauri::RunEvent::ExitRequested { .. } = event {
            stop_owned_child(app.state::<DesktopState>().inner());
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_a_compatible_runtime_probe() {
        assert!(is_compatible_runtime_body(
            r#"{"product":"agent-remote","version":1,"surface":"local","desktopMode":false}"#
        ));
        assert!(!is_compatible_runtime_body(
            r#"{"product":"another-app","version":1,"surface":"local"}"#
        ));
    }

    #[test]
    fn treats_connection_refusal_as_a_free_port_and_other_errors_as_foreign() {
        assert_eq!(
            classify_probe_error(io::ErrorKind::ConnectionRefused),
            RuntimeProbe::Free
        );
        assert_eq!(
            classify_probe_error(io::ErrorKind::TimedOut),
            RuntimeProbe::Foreign
        );
    }

    #[test]
    fn reads_only_the_machine_readiness_line() {
        assert_eq!(
            parse_readiness_line(r#"{"type":"ready","localUrl":"http://127.0.0.1:3000"}"#),
            Some(LOCAL_URL.to_owned())
        );
        assert_eq!(
            parse_readiness_line("Agent Remote listening on http://127.0.0.1:3000"),
            None
        );
        assert_eq!(
            parse_readiness_line(r#"{"type":"ready","localUrl":"https://example.test"}"#),
            None
        );
    }

    #[test]
    fn quit_stops_only_an_owned_child() {
        let state = DesktopState::default();
        assert!(!has_owned_child(&state));
        stop_owned_child(&state);
        assert!(!has_owned_child(&state));

        let child = Command::new("/bin/sh")
            .args(["-c", "trap 'exit 0' TERM; while :; do sleep 1; done"])
            .spawn()
            .expect("test shell starts");
        state
            .runtime
            .lock()
            .expect("desktop state lock poisoned")
            .owned_child = Some(child);
        assert!(has_owned_child(&state));
        stop_owned_child(&state);
        assert!(!has_owned_child(&state));
    }

    #[test]
    fn resolves_development_and_bundled_sidecar_names_for_apple_silicon() {
        assert_eq!(
            resolve_development_sidecar_path(Path::new("/tmp/agent-remote-dev"), "cloudflared"),
            PathBuf::from("/tmp/agent-remote-dev/cloudflared-aarch64-apple-darwin")
        );
        assert_eq!(
            resolve_packaged_sidecar_path(
                Path::new("/Applications/Agent Remote.app/Contents/MacOS"),
                "agent-remote-server"
            ),
            PathBuf::from("/Applications/Agent Remote.app/Contents/MacOS/agent-remote-server")
        );
    }
}
