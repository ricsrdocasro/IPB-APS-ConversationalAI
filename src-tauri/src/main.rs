#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use serde::{Deserialize, Serialize};
use tauri::api::process::Command;
use tauri::api::process::CommandEvent;

#[derive(Debug, Serialize, Deserialize, Clone)]
struct ApiKeys {
    deepgram: String,
    deepseek: String,
    elevenlabs: String,
}

#[tauri::command]
fn save_api_keys(keys: ApiKeys) -> Result<(), String> {
    let keyring = keyring::Entry::new("conversational-ai", "api-keys")
        .map_err(|e| e.to_string())?;
    
    let json = serde_json::to_string(&keys)
        .map_err(|e| e.to_string())?;
    
    keyring.set_password(&json)
        .map_err(|e| e.to_string())?;
    
    Ok(())
}

#[tauri::command]
fn get_api_keys() -> Result<ApiKeys, String> {
    let keyring = keyring::Entry::new("conversational-ai", "api-keys")
        .map_err(|e| e.to_string())?;
    
    match keyring.get_password() {
        Ok(json) => {
            serde_json::from_str(&json)
                .map_err(|e| e.to_string())
        }
        Err(_) => {
            Ok(ApiKeys {
                deepgram: String::new(),
                deepseek: String::new(),
                elevenlabs: String::new(),
            })
        }
    }
}

fn main() {
    tauri::Builder::default()
        .setup(|_app| {
            // Use Tauri's built-in Sidecar API
            // This will look for 'python-sidecar-<triple>.exe' in development
            // and bundle it as an internal resource in production.
            let (mut rx, _child) = Command::new_sidecar("python-sidecar")
                .expect("Failed to create sidecar command")
                .spawn()
                .expect("Failed to spawn sidecar");

            tauri::async_runtime::spawn(async move {
                while let Some(event) = rx.recv().await {
                    if let CommandEvent::Stdout(line) = event {
                        println!("Sidecar: {}", line);
                    } else if let CommandEvent::Stderr(line) = event {
                        eprintln!("Sidecar Error: {}", line);
                    }
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![save_api_keys, get_api_keys])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
