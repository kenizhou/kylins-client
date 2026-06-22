use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use rand::RngCore;
use std::sync::Mutex;

static KEY: Mutex<Option<[u8; 32]>> = Mutex::new(None);

fn get_or_create_key() -> Result<[u8; 32], String> {
    let mut guard = KEY.lock().map_err(|e| format!("key mutex poisoned: {e}"))?;
    if let Some(key) = *guard {
        return Ok(key);
    }

    let entry = keyring::Entry::new("mailclient", "master-key")
        .map_err(|e| format!("keyring entry: {e}"))?;

    let key = match entry.get_password() {
        Ok(hex_key) => {
            let mut key = [0u8; 32];
            hex::decode_to_slice(hex_key, &mut key)
                .map_err(|e| format!("decode key: {e}"))?;
            key
        }
        Err(keyring::Error::NoEntry) => {
            let mut key = [0u8; 32];
            rand::thread_rng().fill_bytes(&mut key);
            let hex_key = hex::encode(key);
            entry
                .set_password(&hex_key)
                .map_err(|e| format!("store key: {e}"))?;
            key
        }
        Err(e) => return Err(format!("keyring read: {e}")),
    };

    *guard = Some(key);
    Ok(key)
}

pub fn encrypt(plaintext: &str) -> Result<String, String> {
    let key = get_or_create_key()?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| e.to_string())?;

    let mut nonce_bytes = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);

    let ciphertext = cipher
        .encrypt(nonce, plaintext.as_bytes())
        .map_err(|e| e.to_string())?;

    let mut combined = nonce_bytes.to_vec();
    combined.extend_from_slice(&ciphertext);
    Ok(hex::encode(combined))
}

pub fn decrypt(ciphertext_hex: &str) -> Result<String, String> {
    let key = get_or_create_key()?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| e.to_string())?;

    let combined = hex::decode(ciphertext_hex).map_err(|e| e.to_string())?;
    if combined.len() < 12 {
        return Err("ciphertext too short".to_string());
    }
    let (nonce_bytes, ciphertext) = combined.split_at(12);
    let nonce = Nonce::from_slice(nonce_bytes);

    let plaintext = cipher
        .decrypt(nonce, ciphertext)
        .map_err(|e| e.to_string())?;
    String::from_utf8(plaintext).map_err(|e| e.to_string())
}
