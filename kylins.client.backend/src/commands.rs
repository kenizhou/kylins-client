use tauri::Manager;

#[tauri::command]
pub fn close_splashscreen(app: tauri::AppHandle) {
    if let Some(splash) = app.get_webview_window("splashscreen") {
        let _ = splash.close();
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[tauri::command]
pub fn encrypt_secret(plaintext: String) -> Result<String, String> {
    crate::crypto::encrypt(&plaintext)
}

#[tauri::command]
pub fn decrypt_secret(ciphertext: String) -> Result<String, String> {
    crate::crypto::decrypt(&ciphertext)
}
