//! ひだまり村のデスクトップアプリ。
//! 画面は Web 版と同じものを使い、ここでは「村人の頭（ローカルAI = Ollama）」の準備を受け持つ：
//! 入っているか・動いているかを調べ、なければダウンロードして入れ、起動し、モデルを取ってくる。

use futures_util::StreamExt;
use serde::Serialize;
use std::path::PathBuf;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

const OLLAMA_URL: &str = "http://127.0.0.1:11434";

#[derive(Serialize)]
struct OllamaStatus {
    installed: bool,
    running: bool,
}

/// 画面から頼まれた Ollama への問い合わせの結果
#[derive(Serialize)]
struct HttpReply {
    status: u16,
    body: String,
}

#[derive(Serialize, Clone)]
struct Progress {
    /// 今していること（表示用）
    stage: String,
    completed: u64,
    total: u64,
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(3))
        .build()
        .expect("http client")
}

async fn is_running() -> bool {
    client()
        .get(format!("{OLLAMA_URL}/api/version"))
        .timeout(Duration::from_secs(2))
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

/// Ollama のアプリが置かれていそうな場所
fn ollama_app_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    #[cfg(target_os = "macos")]
    {
        paths.push(PathBuf::from("/Applications/Ollama.app"));
        if let Some(home) = std::env::var_os("HOME") {
            paths.push(PathBuf::from(home).join("Applications/Ollama.app"));
        }
    }
    #[cfg(target_os = "windows")]
    {
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            paths.push(PathBuf::from(local).join("Programs\\Ollama\\ollama app.exe"));
        }
    }
    paths
}

fn installed_app() -> Option<PathBuf> {
    ollama_app_paths().into_iter().find(|p| p.exists())
}

#[tauri::command]
async fn ollama_status() -> OllamaStatus {
    let running = is_running().await;
    OllamaStatus {
        installed: running || installed_app().is_some(),
        running,
    }
}

/// 画面の代わりに Ollama へ問い合わせる（会話・計画など、AIへのすべての問い合わせはここを通る）。
/// 画面側の通信部品は Windows で応答の受け取りに失敗することがあるため、通信はアプリ本体で行う
#[tauri::command]
async fn ollama_fetch(method: String, path: String, body: Option<String>) -> Result<HttpReply, String> {
    if !path.starts_with("/api/") {
        return Err("使えない宛先です".into());
    }
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(300))
        .build()
        .map_err(|e| e.to_string())?;
    let url = format!("{OLLAMA_URL}{path}");
    let req = if method.eq_ignore_ascii_case("POST") {
        client
            .post(url)
            .header("Content-Type", "application/json")
            .body(body.unwrap_or_default())
    } else {
        client.get(url)
    };
    let res = req.send().await.map_err(|e| e.to_string())?;
    let status = res.status().as_u16();
    let body = res.text().await.map_err(|e| e.to_string())?;
    Ok(HttpReply { status, body })
}

/// 入っている Ollama を起動し、応答するまで少し待つ
#[tauri::command]
async fn start_ollama() -> Result<(), String> {
    if is_running().await {
        return Ok(());
    }
    let app = installed_app().ok_or("Ollama が見つかりません")?;
    #[cfg(target_os = "macos")]
    std::process::Command::new("open")
        .arg("-g")
        .arg(&app)
        .spawn()
        .map_err(|e| e.to_string())?;
    #[cfg(target_os = "windows")]
    std::process::Command::new(&app).spawn().map_err(|e| e.to_string())?;
    for _ in 0..60 {
        if is_running().await {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    Err("Ollama が起動しませんでした".into())
}

/// ファイルをダウンロードする（進み具合を画面へ送る）
async fn download(app: &AppHandle, url: &str, dest: &PathBuf, stage: &str) -> Result<(), String> {
    let res = client().get(url).send().await.map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("ダウンロードに失敗しました（{}）", res.status()));
    }
    let total = res.content_length().unwrap_or(0);
    let mut file = tokio::fs::File::create(dest).await.map_err(|e| e.to_string())?;
    let mut stream = res.bytes_stream();
    let mut completed: u64 = 0;
    let mut last_emit = 0u64;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        tokio::io::AsyncWriteExt::write_all(&mut file, &chunk)
            .await
            .map_err(|e| e.to_string())?;
        completed += chunk.len() as u64;
        if completed - last_emit > 512 * 1024 || completed == total {
            last_emit = completed;
            let _ = app.emit("setup-progress", Progress { stage: stage.into(), completed, total });
        }
    }
    Ok(())
}

/// Ollama をダウンロードして入れ、起動する
#[tauri::command]
async fn install_ollama(app: AppHandle) -> Result<(), String> {
    let dir = std::env::temp_dir().join("hidamari-setup");
    tokio::fs::create_dir_all(&dir).await.map_err(|e| e.to_string())?;

    #[cfg(target_os = "macos")]
    {
        let zip = dir.join("Ollama-darwin.zip");
        download(&app, "https://ollama.com/download/Ollama-darwin.zip", &zip, "Ollama をダウンロードしています").await?;
        let _ = app.emit("setup-progress", Progress { stage: "Ollama を入れています".into(), completed: 0, total: 0 });
        // アプリケーションフォルダに置く（書けなければ、ホームのアプリケーションフォルダ）
        let mut target = PathBuf::from("/Applications");
        let probe = target.join(".hidamari-write-test");
        if std::fs::write(&probe, b"").is_err() {
            let home = std::env::var_os("HOME").ok_or("ホームフォルダが見つかりません")?;
            target = PathBuf::from(home).join("Applications");
            std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;
        } else {
            let _ = std::fs::remove_file(&probe);
        }
        let status = std::process::Command::new("ditto")
            .args(["-x", "-k"])
            .arg(&zip)
            .arg(&target)
            .status()
            .map_err(|e| e.to_string())?;
        if !status.success() {
            return Err("Ollama の展開に失敗しました".into());
        }
    }

    #[cfg(target_os = "windows")]
    {
        let exe = dir.join("OllamaSetup.exe");
        download(&app, "https://ollama.com/download/OllamaSetup.exe", &exe, "Ollama をダウンロードしています").await?;
        let _ = app.emit("setup-progress", Progress { stage: "Ollama を入れています".into(), completed: 0, total: 0 });
        // まずは画面を出さずに入れてみる。だめなら、ふつうにインストーラーを開く
        let silent = std::process::Command::new(&exe)
            .args(["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART"])
            .status();
        let ok = matches!(silent, Ok(s) if s.success());
        if !ok {
            let status = std::process::Command::new(&exe).status().map_err(|e| e.to_string())?;
            if !status.success() {
                return Err("Ollama のインストールが完了しませんでした".into());
            }
        }
    }

    start_ollama().await
}

/// モデルを取ってくる（Ollama に頼み、進み具合を画面へ送る）
#[tauri::command]
async fn pull_model(app: AppHandle, model: String) -> Result<(), String> {
    let res = client()
        .post(format!("{OLLAMA_URL}/api/pull"))
        .json(&serde_json::json!({ "model": model, "stream": true }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("モデルを取ってこられませんでした（{}）", res.status()));
    }
    let mut stream = res.bytes_stream();
    let mut buf = Vec::new();
    while let Some(chunk) = stream.next().await {
        buf.extend_from_slice(&chunk.map_err(|e| e.to_string())?);
        // 1行に1つの JSON が流れてくる
        while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = buf.drain(..=pos).collect();
            let Ok(v) = serde_json::from_slice::<serde_json::Value>(&line) else { continue };
            if let Some(err) = v.get("error").and_then(|e| e.as_str()) {
                return Err(err.to_string());
            }
            let status = v.get("status").and_then(|s| s.as_str()).unwrap_or("").to_string();
            let completed = v.get("completed").and_then(|n| n.as_u64()).unwrap_or(0);
            let total = v.get("total").and_then(|n| n.as_u64()).unwrap_or(0);
            let _ = app.emit("setup-progress", Progress { stage: status, completed, total });
        }
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![ollama_status, start_ollama, install_ollama, pull_model, ollama_fetch])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
