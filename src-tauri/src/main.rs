#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    env,
    error::Error,
    ffi::OsString,
    io::{self, BufRead, BufReader, Read, Write},
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

use serde::Deserialize;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    webview::PageLoadEvent,
    AppHandle, Manager, WebviewWindow, WindowEvent,
};
use tauri_plugin_opener::OpenerExt;
use url::Url;

const LOCAL_URL: &str = "http://127.0.0.1:3000";
const READY_TIMEOUT: Duration = Duration::from_secs(15);
const BACKEND_HEALTH_INTERVAL: Duration = Duration::from_secs(3);
const BACKEND_UNHEALTHY_GRACE: Duration = Duration::from_secs(6);
const STARTUP_URL: &str = "tauri://localhost/";

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
    unhealthy_since: Option<Instant>,
}

#[derive(Default)]
struct DesktopState {
    runtime: Mutex<RuntimeState>,
    ensure_lock: Mutex<()>,
    recovery_running: AtomicBool,
    stopping: AtomicBool,
}

#[derive(Deserialize)]
struct RuntimeResponse {
    product: String,
    version: u8,
    surface: String,
    #[serde(rename = "remoteReady")]
    remote_ready: bool,
}

#[derive(Deserialize)]
struct ReadinessMessage {
    #[serde(rename = "type")]
    message_type: String,
    #[serde(rename = "localUrl")]
    local_url: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct BackendOutcome {
    local_url: String,
    changed: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum RecoveryAction {
    Monitor,
    Resume,
    Show,
    OpenBrowser,
}

fn desktop_error(message: impl Into<String>) -> Box<dyn Error + Send + Sync> {
    Box::new(io::Error::new(io::ErrorKind::Other, message.into()))
}

fn is_compatible_runtime_body(body: &str) -> bool {
    serde_json::from_str::<RuntimeResponse>(body)
        .map(|runtime| {
            runtime.product == "agent-remote"
                && runtime.version == 1
                && runtime.surface == "local"
                && runtime.remote_ready
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

// Apps opened through Finder receive only macOS's minimal PATH. Keep the
// inherited order, then add the conventional locations for the tools that the
// persistent chat runtime needs. This is intentionally not a login shell: a
// user shell profile must not run while launching a background app sidecar.
fn command_search_path(inherited: Option<OsString>, home: Option<&Path>) -> OsString {
    let mut entries = inherited
        .as_deref()
        .map(env::split_paths)
        .map(Iterator::collect::<Vec<_>>)
        .unwrap_or_default();
    let mut candidates = vec![
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/opt/homebrew/sbin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/usr/local/sbin"),
    ];
    if let Some(home) = home {
        candidates.extend([
            home.join(".grok/bin"),
            home.join(".local/bin"),
            home.join(".cargo/bin"),
            home.join(".bun/bin"),
        ]);
    }
    for candidate in candidates {
        if !entries.contains(&candidate) {
            entries.push(candidate);
        }
    }
    env::join_paths(entries).unwrap_or_else(|_| OsString::from("/usr/bin:/bin:/usr/sbin:/sbin"))
}

fn desktop_command_path() -> OsString {
    let home = env::var_os("HOME").map(PathBuf::from);
    command_search_path(env::var_os("PATH"), home.as_deref())
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
    let child = {
        let mut runtime = state.runtime.lock().expect("desktop state lock poisoned");
        runtime.local_url = None;
        runtime.unhealthy_since = None;
        runtime.owned_child.take()
    };
    if let Some(child) = child {
        stop_child_gracefully(child);
    }
}

fn owned_child_is_running(state: &DesktopState) -> bool {
    let mut runtime = state.runtime.lock().expect("desktop state lock poisoned");
    let Some(child) = runtime.owned_child.as_mut() else {
        return false;
    };
    match child.try_wait() {
        Ok(None) => true,
        Ok(Some(_)) | Err(_) => {
            runtime.owned_child.take();
            runtime.local_url = None;
            runtime.unhealthy_since = None;
            false
        }
    }
}

fn owned_child_should_restart(state: &DesktopState) -> bool {
    let mut runtime = state.runtime.lock().expect("desktop state lock poisoned");
    let since = runtime.unhealthy_since.get_or_insert_with(Instant::now);
    since.elapsed() >= BACKEND_UNHEALTHY_GRACE
}

fn mark_backend_healthy(state: &DesktopState) {
    state
        .runtime
        .lock()
        .expect("desktop state lock poisoned")
        .unhealthy_since = None;
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
        .env("PATH", desktop_command_path())
        .env("CLOUDFLARED_BIN", &cloudflared)
        .env("HOST", "127.0.0.1")
        .env("PORT", "3000")
        .env("REMOTE_HOST", "127.0.0.1")
        .env("REMOTE_PORT", "3001")
        .env("AGENT_REMOTE_PARENT_PID", std::process::id().to_string())
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
            // Keep draining stdout for the entire child lifetime. Closing this
            // pipe after readiness can make a later Node log hit EPIPE and kill
            // an otherwise healthy background server.
            let _ = lines.send(line);
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

fn ensure_backend(state: &DesktopState) -> DesktopResult<BackendOutcome> {
    let _ensure = state
        .ensure_lock
        .lock()
        .expect("desktop ensure lock poisoned");
    if state.stopping.load(Ordering::Acquire) {
        return Err(desktop_error("Agent Remote is shutting down."));
    }

    let previous_url = state
        .runtime
        .lock()
        .expect("desktop state lock poisoned")
        .local_url
        .clone();
    let owned_running = owned_child_is_running(state);
    let mut probe = probe_runtime();

    if matches!(probe, RuntimeProbe::Compatible(_)) {
        mark_backend_healthy(state);
    } else if owned_running {
        if !owned_child_should_restart(state) {
            return Err(desktop_error(
                "The owned Agent Remote backend is temporarily unavailable.",
            ));
        }
        // Only recycle the child whose handle this wrapper owns. An attached
        // backend or a foreign listener is never signalled.
        stop_owned_child(state);
        probe = probe_runtime();
    }

    let (local_url, started) = match probe {
        RuntimeProbe::Compatible(local_url) => (local_url, false),
        RuntimeProbe::Free => (spawn_owned_backend(state)?, true),
        RuntimeProbe::Foreign => {
            return Err(desktop_error(
                "Port 3000 is already being used by another service, or its Remote listener is unavailable. Agent Remote did not change it.",
            ));
        }
    };
    let changed = started || previous_url.as_deref() != Some(local_url.as_str());
    let mut runtime = state.runtime.lock().expect("desktop state lock poisoned");
    runtime.local_url = Some(local_url.clone());
    runtime.unhealthy_since = None;
    Ok(BackendOutcome { local_url, changed })
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
    let Ok(mut url) = Url::parse(STARTUP_URL) else {
        return;
    };
    url.query_pairs_mut().append_pair("error", message);
    let _ = window.navigate(url);
}

fn notify_frontend_resume(window: &WebviewWindow) {
    let _ = window.eval("window.dispatchEvent(new Event('agent-remote-resume'))");
}

fn apply_recovery_result(
    app: &AppHandle,
    action: RecoveryAction,
    result: Result<BackendOutcome, String>,
) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    match result {
        Ok(outcome) => {
            if outcome.changed {
                let _ = navigate_to_backend(&window, &outcome.local_url);
            } else if action != RecoveryAction::Monitor {
                notify_frontend_resume(&window);
            }
            match action {
                RecoveryAction::Show => show_main_window(app),
                RecoveryAction::OpenBrowser => {
                    let _ = app.opener().open_url(outcome.local_url, None::<&str>);
                }
                RecoveryAction::Monitor | RecoveryAction::Resume => {}
            }
        }
        Err(message) => {
            if matches!(action, RecoveryAction::Show | RecoveryAction::OpenBrowser) {
                show_startup_error(&window, &message);
                show_main_window(app);
            }
        }
    }
}

fn request_backend_recovery(app: &AppHandle, action: RecoveryAction) {
    if action == RecoveryAction::Show {
        show_main_window(app);
    }
    let state = app.state::<DesktopState>();
    if state.stopping.load(Ordering::Acquire) {
        return;
    }
    if state.recovery_running.swap(true, Ordering::AcqRel) {
        if action == RecoveryAction::OpenBrowser {
            let local_url = state
                .runtime
                .lock()
                .expect("desktop state lock poisoned")
                .local_url
                .clone();
            if let Some(local_url) = local_url {
                let _ = app.opener().open_url(local_url, None::<&str>);
            }
        }
        return;
    }

    let app = app.clone();
    thread::spawn(move || {
        let result =
            ensure_backend(app.state::<DesktopState>().inner()).map_err(|error| error.to_string());
        app.state::<DesktopState>()
            .recovery_running
            .store(false, Ordering::Release);
        if app.state::<DesktopState>().stopping.load(Ordering::Acquire) {
            return;
        }
        let ui_app = app.clone();
        let _ = app.run_on_main_thread(move || apply_recovery_result(&ui_app, action, result));
    });
}

fn start_backend_supervisor(app: AppHandle) {
    thread::spawn(move || loop {
        thread::sleep(BACKEND_HEALTH_INTERVAL);
        if app.state::<DesktopState>().stopping.load(Ordering::Acquire) {
            break;
        }
        request_backend_recovery(&app, RecoveryAction::Monitor);
    });
}

fn shutdown_backend(state: &DesktopState) {
    state.stopping.store(true, Ordering::Release);
    let _ensure = state
        .ensure_lock
        .lock()
        .expect("desktop ensure lock poisoned");
    stop_owned_child(state);
}

#[cfg(target_os = "macos")]
fn keep_remote_service_active() {
    use objc2_foundation::{NSActivityOptions, NSProcessInfo, NSString};

    let reason = NSString::from_str("Keep Agent Remote reachable while its window is hidden");
    let activity = NSProcessInfo::processInfo().beginActivityWithOptions_reason(
        NSActivityOptions::UserInitiatedAllowingIdleSystemSleep,
        &reason,
    );
    // The assertion intentionally lasts until process exit. It prevents App
    // Nap while still allowing the Mac itself to sleep normally.
    std::mem::forget(activity);
}

#[cfg(not(target_os = "macos"))]
fn keep_remote_service_active() {}

fn configure_window_lifecycle(window: &WebviewWindow) {
    let window_for_event = window.clone();
    window.on_window_event(move |event| match event {
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            let _ = window_for_event.hide();
        }
        WindowEvent::Focused(true) => {
            request_backend_recovery(window_for_event.app_handle(), RecoveryAction::Monitor);
        }
        _ => {}
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
            "show" => request_backend_recovery(app, RecoveryAction::Show),
            "open" => request_backend_recovery(app, RecoveryAction::OpenBrowser),
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
}

fn main() {
    let app = tauri::Builder::default()
        .on_page_load(|webview, payload| {
            if payload.event() == PageLoadEvent::Finished {
                let _ = webview.eval("document.documentElement.dataset.desktopShell = 'tauri'");
            }
        })
        .manage(DesktopState::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            request_backend_recovery(app, RecoveryAction::Show);
        }))
        .setup(|app| -> Result<(), Box<dyn Error>> {
            let window = app.get_webview_window("main").ok_or_else(|| {
                io::Error::new(io::ErrorKind::Other, "The main window was not created")
            })?;
            configure_window_lifecycle(&window);
            install_tray(app)?;
            match ensure_backend(app.state::<DesktopState>().inner()) {
                Ok(outcome) => navigate_to_backend(&window, &outcome.local_url)
                    .map_err(|error| io::Error::new(io::ErrorKind::Other, error.to_string()))?,
                Err(error) => show_startup_error(&window, &error.to_string()),
            }
            start_backend_supervisor(app.handle().clone());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Agent Remote");
    keep_remote_service_active();
    app.run(|app: &AppHandle, event| match event {
        tauri::RunEvent::ExitRequested { .. } => {
            shutdown_backend(app.state::<DesktopState>().inner());
        }
        tauri::RunEvent::Exit => {
            shutdown_backend(app.state::<DesktopState>().inner());
        }
        tauri::RunEvent::Resumed => {
            request_backend_recovery(app, RecoveryAction::Resume);
        }
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen { .. } => {
            request_backend_recovery(app, RecoveryAction::Show);
        }
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_a_compatible_runtime_probe() {
        assert!(is_compatible_runtime_body(
            r#"{"product":"agent-remote","version":1,"surface":"local","desktopMode":true,"remoteReady":true}"#
        ));
        assert!(!is_compatible_runtime_body(
            r#"{"product":"another-app","version":1,"surface":"local"}"#
        ));
        assert!(!is_compatible_runtime_body(
            r#"{"product":"agent-remote","version":1,"surface":"local","remoteReady":false}"#
        ));
        assert!(!is_compatible_runtime_body(
            r#"{"product":"agent-remote","version":1,"surface":"local"}"#
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

    #[test]
    fn expands_the_finder_path_for_homebrew_and_agent_tools() {
        let path = command_search_path(
            Some(OsString::from("/usr/bin:/bin:/usr/sbin:/sbin")),
            Some(Path::new("/Users/agent")),
        );
        let entries = env::split_paths(&path).collect::<Vec<_>>();
        assert_eq!(entries[..4], [
            PathBuf::from("/usr/bin"),
            PathBuf::from("/bin"),
            PathBuf::from("/usr/sbin"),
            PathBuf::from("/sbin"),
        ]);
        assert!(entries.contains(&PathBuf::from("/opt/homebrew/bin")));
        assert!(entries.contains(&PathBuf::from("/Users/agent/.grok/bin")));
        assert!(entries.contains(&PathBuf::from("/Users/agent/.local/bin")));
    }
}
