#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use serde::{Deserialize, Serialize};

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
        .setup(|app| {
            let handle = app.handle();
            
            // Spawn the sidecar
            tauri::async_runtime::spawn(async move {
                // In production, Tauri bundles the sidecar. In dev, we can still use this API
                // as long as the binary exists in src-tauri/binaries/
                let (mut rx, _child) = tauri::api::process::Command::new_sidecar("python-sidecar")
                    .expect("failed to setup sidecar")
                    .spawn()
                    .expect("failed to spawn sidecar");

                while let Some(event) = rx.recv().await {
                    if let tauri::api::process::CommandEvent::Stdout(line) = event {
                        println!("Sidecar: {}", line);
                    }
                }
            });
            
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![save_api_keys, get_api_keys])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
