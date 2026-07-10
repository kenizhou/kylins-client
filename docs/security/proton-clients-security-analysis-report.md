# Proton Clients 安全架构与加密邮件实现分析

> 报告日期：2026-07-10  
> 分析源码：`D:\Projects\mailclient\opensource\Proton\clients`（Proton Mail/Account/Calendar Rust 客户端 monorepo）  
> 目标：为 Kylins Client 提供可借鉴的加密架构、流程与 UI/UX 设计

---

## 1. 执行摘要

Proton Clients monorepo 是 Proton 下一代 Rust 跨平台客户端核心，主要包含 `account`、`core`、`mail` 三大领域的 Rust crate。它把 `proton-crypto-rs`（已在此前报告分析）作为外部依赖，通过 `PGPProviderSync` trait 屏蔽 OpenPGP 后端，并在此基础上构建了邮件加密、密钥管理、账户安全、设备验证等完整上层逻辑。

**核心结论：**

1. **抽象层非常薄但有效**：整个 mail 代码只依赖 `PGPProviderSync` trait，后端在 workspace 级别通过 feature flag 选择（当前默认 `rustpgp`）。
2. **发送流程**：composer → per-recipient `SendPreferences` → `mail-package-builder` 构建 `Package` → 区分内部 Proton 用户、外部 PGP/MIME、明文、EncryptedOutside 四种投递路径 → API `POST /mail/v4/messages/{id}`。
3. **接收流程**：拉取加密 body → 用 address key 解密 → `crypto-inbox-mime` 解析 MIME → 单独验证签名 → 生成 `PrivacyLock` 状态 → HTML 转换与渲染。
4. **安全措施密集**：SRP 登录、KeySecret 派生、OS keychain 保护 DB 加密密钥、AES-GCM 加密本地 key secret、Argon2 PIN 哈希、10/5 分钟解锁 key cache TTL、`Sensitive`/`SecretSlice`/`ZeroizeOnDrop`、Signed Key Lists、key transparency、compromised key 过滤、device secret 人工校验码。
5. **UI/UX**：由于该仓库只有 Rust TUI，前端细节有限，但 `lock_icon.rs` 定义了一套完整的图标/颜色/提示语状态机，`mail-tui` 在 composer 和 reading pane 都渲染 per-recipient lock 与 privacy row。
6. **对 Kylins 的启示**：
   - 用统一的 `CryptoProvider` trait 屏蔽后端；
   - 发送前做 per-recipient readiness check；
   - 阅读窗用单一 `UiLock` 状态机；
   - 软私钥用 master key 加密后存 SQLite，OS keychain 保护 master key；
   - 自动发现的 key 先进 collected keys，用户显式接受后才进正式 keyring；
   - 加密草稿先本地加密再上传，并立即解密验证 round-trip。

---

## 2. 抽象层：如何屏蔽不同加密方式的差异

### 2.1 核心 trait：`PGPProviderSync`

整个 Proton Clients 的 mail 代码不直接依赖任何具体 OpenPGP 实现。所有加密操作都泛型化在 `proton_crypto_account::proton_crypto::crypto::PGPProviderSync` 上。

例如解密：`project/mail/rust/crypto/crypto-inbox/src/message/decrypt.rs:180`

```rust
fn decrypt<P>(
    &self,
    pgp: &P,
    decryption_keys: &[impl AsRef<P::PrivateKey>],
) -> Result<RawDecryptedBody, MessageError>
where
    P: PGPProviderSync,
```

再如 key manager：`project/mail/rust/core/core-key-manager/src/manager.rs:287`

```rust
pub async fn user_keys<P: PGPProviderSync>(&self, pgp: &P) -> Result<UserKeySelector<'_, P>>
```

`PGPProviderSync` 也用于附件、EO 密码、session key、package 加密、vCard contact keys 等所有场景。

### 2.2 后端依赖与 feature flag

外部 `proton-crypto` / `proton-crypto-account` 在 workspace root 中统一配置：`D:/Projects/mailclient/opensource/Proton/clients/Cargo.toml:308-324`

```toml
[workspace.dependencies.proton-crypto-account]
# Use experimental version based on rprp instead of gopenpgp-sys.
version = "0.19.0"
default-features = false
features = ["facet", "rustpgp"]
registry = "proton"

[workspace.dependencies.proton-crypto]
# Use experimental version based on rprp instead of gopenpgp-sys.
version = "0.13.0"
default-features = false
features = ["facet", "rustpgp"]
registry = "proton"
```

注释明确说明当前选的是 **rustpgp（纯 Rust）** 后端，而非默认的 `gopenpgp-sys`（Go FFI）。

调用方创建 provider：

```rust
let pgp = proton_crypto::new_pgp_provider();
```

出现在：
- `project/mail/rust/mail/mail-common/src/datatypes/mail_notifications.rs:133`
- `project/mail/rust/account/account-api/src/password/api.rs:76-77`

### 2.3 Key Manager 的 loader trait 抽象

`mail-core-key-manager` 把“如何获取密钥材料”与“如何使用”分离：`project/mail/rust/core/core-key-manager/src/traits.rs:60-134`

```rust
trait LockedPrivateKeyLoader   // 从本地模型加载 user/address 私钥
trait PublicKeyLoader          // 从 /core/v4/keys/all API 加载公钥
trait ContactPublicKeyLoader   // 从签名 vCard 加载 contact pinned keys
trait KeySecretLoader          // 加载解锁 user key 的 passphrase
trait CacheAccess              // 可选内存 key cache
```

`KeyManager` 通过 `Arc<dyn ...>` 组合这些 loader：`project/mail/rust/core/core-key-manager/src/manager.rs:161-272`

具体实现 `CryptoKeyService` 在 `project/mail/rust/core/core-common/src/user_context/services/crypto_key_service.rs:145-181`，对接本地 Stash DB 和 API session。

上层调用不直接访问 key manager，而是通过 `MailUserContext`：

```rust
let unlocked_keys = ctx
    .crypto_key_service()
    .load_with_tether(...)
    .address_keys(&pgp, address_id)
    .await?;
```

`project/mail/rust/mail/mail-common/src/draft/compose.rs:265-271`

### 2.4 对 Kylins 的映射

| Proton 抽象 | Kylins 映射 |
|---|---|
| `PGPProviderSync` | Rust `CryptoProvider` trait（支持 S/MIME + OpenPGP） |
| workspace feature 后端切换 | Cargo feature 选择 `pgp` / `sequoia-openpgp` / `cms` |
| `KeyManager` + loader traits | `KeyStore` trait + SQLite / token / WKD 实现 |
| `MailUserContext::crypto_key_service()` | Tauri `AppState` 持有 `CryptoService` |
| `proton_crypto::new_pgp_provider()` | `resolve_provider(method: CryptoMethod)` |

---

## 3. 加密邮件发送流程

### 3.1 入口

Composer 提交后创建 `draft::Send` action，远程 handler 加载明文 body、解析 per-recipient 加密偏好、构建 `Package`、调用 Proton send API。

`project/mail/rust/mail/mail-common/src/actions/draft/send.rs:469-502`

```rust
let packages = build_packages(
    ctx,
    MailType::Draft,
    &pgp,
    &address_keys,
    send_preferences,
    action.mime_type.into(),
    str::from_utf8(stored_message_body.body())?,
    &attachments,
    eo_data,
    tether,
)
.await?;

let delivery_time = ctx
    .session()
    .send_mail(remote_message_id.clone(), packages, ...)
    .await;
```

### 3.2 解析每个收件人的发送偏好

`load_prefs` 为每个收件人调用 `MailUserContext::recipient_send_preferences`：`project/mail/rust/mail/mail-common/src/draft/send.rs:50-116`

```rust
let send_preference = context
    .recipient_send_preferences(
        pgp,
        tether,
        PrivateEmailRef::new(recipient.as_clear_text_str()),
        crypto_mail_settings,
        composer_preference,
        PublicAddressKeyApiFetchPolicy::RequireSync,
        PublicAddressKeyContactFetchPolicy::RequireSync,
    )
    .await?;
```

`recipient_send_preferences` 内部：

`project/mail/rust/mail/mail-common/src/user_context.rs:839-872`

```rust
let address_key_selector = self
    .crypto_key_service()
    .load_with_tether(self.user_context(), tether)
    .address_keys_for_email(pgp, email.as_clear_text_str(), false, fetch_policy, contact_fetch_policy)
    .await?;

let encryption_preferences = address_key_selector.for_inbox_encryption(true, settings, encryption_time)?;
let send_preferences = SendPreferences::from_preferences(encryption_preferences, composer_preference);
```

### 3.3 密钥查找逻辑

`KeySelector::address_keys_for_email`：`project/mail/rust/core/core-key-manager/src/manager.rs:367-416`

1. 先检查该 email 是否属于当前用户自己的 active address；如果是，返回 own address keys。
2. 否则并行拉取 API keys 和 contact pinned keys。

API keys 来自 `/core/v4/keys/all`：`project/mail/rust/core/core-common/src/user_context/services/crypto_key_service.rs:298-377`

Contact pinned keys 来自签名 vCard：`project/mail/rust/core/core-common/src/user_context/services/crypto_key_service.rs:380-472`

```rust
let signed_vcard = signed_vcard_from_cards(cards);
```

### 3.4 从偏好到具体投递方案

`SendPreferences`：`project/mail/rust/crypto/crypto-inbox/src/keys/encryption.rs:151-288`

```rust
pub struct SendPreferences<Pub: PublicKey> {
    pub encrypt: bool,
    pub sign: bool,
    pub pgp_scheme: PackageCryptoType,   // ProtonMail / PgpMime / PgpInline / Cleartext / EncryptedOutside
    pub mime_type: PackageMimeType,       // Html / PlainText / Multipart
    pub selected_key: Option<Pub>,
    pub is_selected_key_pinned: bool,
    pub encryption_disabled: bool,
    pub key_transparency_verification: KTVerificationResult,
}
```

内部选择逻辑：

```rust
let pgp_scheme = if encryption_preferences.contact_type == ContactType::Internal
    && !encryption_preferences.encryption_disabled_mail
{
    PackageCryptoType::ProtonMail
} else {
    let scheme = PackageCryptoType::from_scheme(
        encryption_preferences.pgp_scheme,
        encrypt, sign, composer_preferences.encrypt_to_outside,
    );
    if scheme == PackageCryptoType::PgpInline {
        PackageCryptoType::PgpMime
    } else {
        scheme
    }
};
```

### 3.5 构建 Package

`build_packages` 是 `mail-package-builder` 的薄封装：`project/mail/rust/mail/mail-common/src/draft/send.rs:120-154`

```rust
let loaded_attachments = adapter::hydrate_attachments::<P>(context, tether, attachments, &send_preferences).await?;

mail_package_builder::build_packages(
    pgp,
    ty.into(),
    address_keys,
    &send_preferences,
    adapter::to_shared_body(mime_type, stored_message_body),
    loaded_attachments,
    eo_container,
)
.await
```

`mail-package-builder::build_packages`：`project/mail/rust/shared/mail-package-builder/src/packages.rs:73-156`

1. 如有 EncryptedOutside 收件人，解析 EO modulus。
2. 确定需要的 body MIME 类型集合。
3. 用 sender primary key 加密每种 MIME 类型的 body。
4. 为每个匹配的收件人构建 `AddressSubPackage`。

### 3.6 Body 加密

`package_body_encrypt`：`project/mail/rust/crypto/crypto-inbox/src/message/packages.rs:136-176`

```rust
let session_key = pgp
    .session_key_generate(SessionKeyAlgorithm::default())
    .map_err(MessageError::Encryption)?;

let mut encryptor = pgp
    .new_encryptor()
    .with_session_key_ref(&session_key)
    .with_signing_keys(address_key.for_signing())
    .with_utf8();

if mime_type == PackageMimeType::Multipart && body.len() > MEGABYTE {
    encryptor = encryptor.with_compression();
}
```

### 3.7 不同收件人类型的处理

`build_top_package` / `build_address_sub_package`：`project/mail/rust/shared/mail-package-builder/src/packages.rs:252-385`

| 类型 | 处理方式 |
|---|---|
| **ProtonMail（内部用户）** | body 用共享 session key 加密；session key 再用收件人公钥加密到 `body_key_packet`；附件 session key 同样重加密。 |
| **PgpMime（外部 PGP 用户）** | 用 `InboxMimeBuilder` 构建完整 MIME（text/html + attachments），整体用收件人公钥加密；附件不再单独重加密。 |
| **Cleartext（明文）** | `top_package.body_key` 暴露 session key，后端解密后以明文投递。 |
| **EncryptedOutside** | body 和附件 session key 用用户密码重加密；生成 SRP verifier/challenge。 |
| **PgpInline** | 不支持，强制转 PgpMime。 |

### 3.8 网络发送

`POST /mail/v4/messages/{message_id}`：`project/mail/rust/mail/mail-api/src/services/proton/proton_impl.rs:593-617`

```rust
let send_request = PostSendRequest {
    expiration_time,
    auto_save_contacts,
    delay_seconds: delay.map(|v| v.as_secs()),
    delivery_time,
    packages,
};
Ok(POST!("{MAIL_V4}/messages/{message_id}")
    .body_json(send_request)?
    .send_with(self)
    .await? ...)
```

### 3.9 对 Kylins 的映射

Kylins 是普通 IMAP/SMTP/EAS 客户端，不连接 Proton API，因此：

- 不需要 `Package` / `AddressSubPackage` wire format。
- 但需要同样的 per-recipient readiness check。
- 对于 SMTP：直接构建标准 PGP/MIME 或 S/MIME MIME，交给 SMTP 发送。
- 对于 EAS：需要把 MIME 作为 body 发送（EAS 对加密邮件支持有限，可能只能走 ActiveSync 的 MIME body）。

---

## 4. 加密邮件接收流程

### 4.1 拉取加密消息

`Message::fetch_message_body_impl` 先查本地缓存，缺失则调用 `sync_message_and_body` 从 `/mail/v4/messages/{id}` 拉取 metadata 和 body。

`project/mail/rust/mail/mail-common/src/models/message.rs:1084-1141`

```rust
let (_, encrypted_body) =
    Self::sync_message_and_body(remote_id, ctx.session(), tether, ctx.action_queue()).await?;

let decrypted = Self::decrypt_message_body(
    ctx, &self.remote_address_id, encrypted_body, tether, with_attachment_prefetching,
).await?;
```

### 4.2 解密 body

`decrypt_message_body` 加载 recipient address keys，调用 `EncryptedMessageBody::decrypt_and_store`：`project/mail/rust/mail/mail-common/src/models/message.rs:1687-1718`

```rust
let pgp = proton_crypto::new_pgp_provider();
let address_keys = ctx
    .crypto_key_service()
    .load_with_tether(ctx.user_context(), tether)
    .address_keys(&pgp, address_id)
    .await
    .map(AddressKeySelector::into_raw_keys)?;

encrypted_message_body
    .decrypt_and_store(ctx, address_id, address_keys, pgp, attachment_prefetch)
    .await
```

`EncryptedMessageBody` 实现 `DecryptableMessage`：`project/mail/rust/mail/mail-common/src/datatypes.rs:1115-1131`

```rust
impl GettablePGPMessage for EncryptedMessageBody {
    fn pgp_message(&self) -> &[u8] { self.encrypted_body.as_bytes() }
}

impl DecryptableMessage for EncryptedMessageBody {
    fn message_id(&self) -> Option<&str> { self.metadata.remote_message_id.as_ref().map(|v| v.as_ref()) }
    fn message_is_mime(&self) -> bool { self.metadata.mime_type == MimeType::MultipartMixed }
}
```

`DecryptableMessage::decrypt` 分派到 `decrypt_normal` 或 `decrypt_mime`：`project/mail/rust/crypto/crypto-inbox/src/message/decrypt.rs:163-246`

```rust
fn decrypt_mime<P>(...) -> Result<RawDecryptedBody, MessageError>
where P: PGPProviderSync,
{
    let decrypted_body = pgp
        .new_decryptor()
        .with_decryption_key_refs(decryption_keys)
        .decrypt(data, DataEncoding::Armor)
        .map_err(MessageError::Decryption)?;

    let signatures = decrypted_body.signatures().unwrap_or_default();
    let raw_mime_data = decrypted_body.into_vec();

    Ok(RawDecryptedBody::new_mime(message_id, raw_mime_data, signatures))
}
```

### 4.3 MIME 解析与附件提取

`RawDecryptedBody::processed_body` 调用 `MimeProcessor::process_mime`：`project/mail/rust/crypto/crypto-inbox-mime/src/read.rs:130-162`

```rust
impl ProcessMime for MimeProcessor {
    fn process_mime(message_id: &str, raw_data: &[u8]) -> ProcessedMimeResult {
        let mut parsed_message = MessageParser::default()
            .parse(raw_data)
            .ok_or(ProcessMimeError::Parse)?;
        let mut signatures = Vec::new();

        if let Some(root_signed_part) = extract_root_signed_part(&parsed_message) {
            parsed_message = MessageParser::default()
                .parse(&raw_data[root_signed_part.verify_data_range.clone()])
                .ok_or(ProcessMimeError::Parse)?;
            signatures.push(root_signed_part);
        };

        let (body, mime_body_type) = select_body(&parsed_message)?;
        let processed_attachments = process_attachments(message_id, &parsed_message);
        ...
    }
}
```

`extract_root_signed_part` 处理 `multipart/signed` PGP/MIME 签名：`project/mail/rust/crypto/crypto-inbox-mime/src/read.rs:228-266`

### 4.4 签名验证

签名验证与解密分离，以便 UI 可以先显示明文、再异步验证签名：`project/mail/rust/crypto/crypto-inbox/src/message/decrypt.rs:78-113`

```rust
pub fn verify_signature<P>(
    &self,
    pgp: &P,
    verification_keys: &[impl AsPublicKeyRef<P::PublicKey>],
) -> VerificationResult
where P: PGPProviderSync,
{
    match self {
        RawDecryptedBody::Plain { raw_body, signatures } =>
            message::verify_normal(pgp, verification_keys, raw_body, signatures),
        RawDecryptedBody::Mime { ... } =>
            message::verify_mime(pgp, verification_keys, raw_message, signatures, &internal_signatures),
    }
}
```

`verify_mime`：`project/mail/rust/crypto/crypto-inbox/src/message/verify.rs:10-60`

```rust
if !signatures.is_empty() {
    return pgp
        .new_verifier()
        .with_verification_key_refs(verification_keys)
        .verify_detached(data, signatures, DataEncoding::Bytes);
}
...
mime_verification_results.extend(
    mime_signatures
        .iter()
        .map(|verifier| verify_mime_signature(pgp, verification_keys, data, verifier)),
);
```

### 4.5 发送者验证 / 密钥查找

`DecryptedMessageBody::privacy_lock` 调用 `sender_verification_preferences`，使用与发送相同的路径查找验证密钥：`project/mail/rust/mail/mail-common/src/mailbox/decrypted_message.rs:777-820`

```rust
let verification_prefs = ctx
    .sender_verification_preferences(
        &pgp,
        &tether,
        message.sender.address.as_ref(),
        PublicAddressKeyApiFetchPolicy::AllowCachedFallback,
        PublicAddressKeyContactFetchPolicy::AllowCachedFallback,
    )
    .await?;

let verification_result = raw_decrypted_message
    .verify_signature(&pgp, verification_prefs.signature_verification_keys())
    ...
```

### 4.6 渲染

解密后的 HTML/text 由 `mail-html-transformer` 处理：`project/mail/rust/mail/mail-common/src/mailbox/decrypted_message.rs:484-534`

```rust
let mut output = transform_message_with_banners(
    sender,
    &[],
    &self.body,
    resolved,
    self.mime_type,
    banners,
    opts.highlight_query.as_deref(),
);
```

`mail-html-transformer`：`project/mail/rust/mail/mail-html-transformer/src/lib.rs:139-263`

- `strip_utm()`
- `disable_content(no_remote, no_embedded)`
- `strip_whitelist(...)`
- `inject_dark_mode(...)`

### 4.7 对 Kylins 的映射

| Proton 步骤 | Kylins 映射 |
|---|---|
| IMAP 拉取加密 body | 已有 IMAP client 拉取原始 MIME |
| 用 address key 解密 | Rust `crypto::openpgp::decrypt` / `crypto::smime::decrypt` |
| MIME 解析 | `mail-parser` + `crypto-inbox-mime` 思路 |
| 签名验证 | 单独 `verify_signature`，异步执行 |
| 发送者密钥查找 | WKD / keyserver / contact pinned keys |
| privacy lock 状态 | React `CryptoBadge` 组件 |
| HTML 转换 | 现有 `SafeHtmlFrame` + DOMPurify |

---

## 5. 安全措施与 rationale

### 5.1 内存清零与敏感数据包装

**`Sensitive<T>`**：`project/core/rust/core-sensitive-data/src/lib.rs:19-44`

- 包装任何 `Zeroize` 类型
- `Debug` 输出脱敏
- `Drop` 时 zeroize

**`SecureString`**：`project/mail/rust/account/account-api/src/shared/mod.rs:7-13`

```rust
#[derive(Debug, Display, Deref, Clone, From, Zeroize, ZeroizeOnDrop)]
pub struct SecureString(#[debug(skip)] #[display(skip)] String);
```

**Session key 暴露类型**：`project/mail/rust/crypto/crypto-inbox/src/keys/session_key.rs:32-65`

```rust
pub struct SessionKeyExposed(pub(crate) String);
impl ZeroizeOnDrop for SessionKeyExposed {}
impl Drop for SessionKeyExposed {
    fn drop(&mut self) { self.0.zeroize(); }
}

#[derive(Clone, Eq, PartialEq, Zeroize, ZeroizeOnDrop)]
pub(crate) struct SessionKeyBytes(pub(crate) Vec<u8>);
```

**缓存私钥**：`project/mail/rust/core/core-key-manager/src/cache.rs:26-89`

```rust
pub(crate) struct CachedKey {
    private_key: SecretSlice<u8>,
    created_at: Instant,
}
```

Why：防止密钥、口令、session key 在内存中长时间残留，避免 core dump / memory dump 泄露。

### 5.2 密钥分离

- User Key：顶级身份密钥，由 SRP+salt 派生的 passphrase 加密。
- Address Keys：每个邮箱地址一个，由 user key 签名并加密。
- Session Keys：每封邮件的对称密钥。
- Device Secret：每设备 32 字节随机密钥。

`project/mail/rust/core/core-key-manager/src/manager.rs:628-660`：address key 由 unlocked user key 解锁。

Why：减少单点泄露影响；即使 address key 泄露，user key 仍独立。

### 5.3 SRP 密码认证

`project/mail/rust/account/account-api/src/password/api.rs:49-72`

```rust
let client_proof = srp.generate_client_proof(
    username, password, auth_info.version, &auth_info.salt,
    &auth_info.modulus, &auth_info.server_ephemeral,
)?;
if response.server_proof == client_proof.expected_server_proof { ... }
```

EO challenge 也用 SRP：`project/mail/rust/crypto/crypto-inbox/src/eo.rs:66-68`

Why：客户端不向服务器发送明文密码；同时验证服务器身份（通过 `expected_server_proof`）。

### 5.4 本地密钥保护链

```text
Mailbox password
    ↓ SRP + KeySalt
KeySecret
    ↓ 解锁 User Key
Unlocked User Key
    ↓ 解密 Address Keys
Unlocked Address Keys
    ↓ 解密邮件/草稿/附件
```

`KeySecret` 本身存在 SQLite 中，但用 `SessionEncryptionKey` AES-GCM 加密：`project/mail/rust/core/core-common/src/db/account/types.rs:464-492`

```rust
pub fn new(key_secret: &UserKeySecret, key: &SessionEncryptionKey) -> Result<Self, aes_gcm::Error> {
    key.encrypt(key_secret.expose_secret().as_bytes()).map(Self)
}
```

`SessionEncryptionKey` 存在 OS keychain：`project/mail/rust/core/core-common/src/db/account/types.rs:525-577`

TUI 实现：`project/mail/rust/mail/mail-tui/src/keychain.rs:8-21`（使用 `keyring` crate）

Why：即使本地 SQLite 被拷贝，没有 OS keychain 中的 key 也无法解密 key secret。

### 5.5 PIN / 应用锁

`project/mail/rust/core/core-common/src/pin_code.rs:50-221`

- Argon2 哈希存 keychain
- 长度 4–20
- 失败次数限制
- 过多失败 wipe

注意：PIN 不用于派生 KeySecret，只是应用锁屏。

### 5.6 解锁密钥缓存 TTL

`project/mail/rust/core/core-key-manager/src/cache.rs:14-19`

```rust
pub const USER_KEY_LIFETIME: Duration = Duration::from_secs(600);    // 10 min
pub const ADDRESS_KEY_LIFETIME: Duration = Duration::from_secs(300); // 5 min
```

Why：平衡安全与性能；用户不必每次操作都输密码，但密钥不会无限期留在内存。

### 5.7 AEAD 与 context binding

AES-GCM 用于：

- QR 登录 payload：`project/mail/rust/account/account-api/src/login/state/want_qr_confirmation.rs:17, 214-221`
- Device secret 加密本地 passphrase：`project/core/rust/core-key/src/sso_device/encrypted_secret.rs:27-42`

```rust
let key = AesGcmKey::from_bytes(device_secret)?;
let ciphertext = key.encrypt(passphrase.as_ref(), Some(ENCRYPTED_SECRET_CONTEXT))?;
```

Why：AEAD 提供机密性 + 完整性；context string 防止密文被用于其他用途（misuse resistance）。

### 5.8 Signed Key Lists 与 Key Transparency

- 每个 address key 生成时产生 `LocalSignedKeyList`，由 user key 签名：`project/core/rust/core-key/src/keys/new_addr_key.rs:69-79`
- API 返回 `AddressSignedKeyList`，含 `data`、`signature`、`min/max_epoch_id`、`obsolescence_token`、`revision`：`project/mail/rust/account/account-api/src/responses.rs:604-629`
- `KTVerificationResult` 贯穿发送偏好和收件箱验证偏好：
  - `project/mail/rust/crypto/crypto-inbox/src/keys/encryption.rs:191`
  - `project/mail/rust/crypto/crypto-inbox/src/keys/verification.rs:33`
- Self-owned keys 标记 `KT_VERIFIED`，外部 key 默认 `KT_UNVERIFIED`：`verification.rs:64-91`
- Compromised fingerprint 过滤：`verification.rs:31-34, 74-85, 100-136`

Why：防止服务器静默替换攻击者密钥；提供可审计的 key history；pinned/contact keys 提供带外信任锚。

### 5.9 Device Secret 与 SSO 设备验证

`project/core/rust/core-key/src/sso_device/device_secret.rs:28-121`

- `DeviceSecret([u8; 32])` 由 CSPRNG 生成。
- Activation token 用用户主 address 公钥加密。
- 用户通过比较 display code（从 device secret 派生）来验证设备。
- display code 不匹配则中止激活（`:78-80`）。

`EncryptedSecret`：`project/core/rust/core-key/src/sso_device/encrypted_secret.rs:10-42`

```rust
let key = AesGcmKey::from_bytes(device_secret)?;
let ciphertext = key.encrypt(passphrase.as_ref(), Some("account.device-secret"))?;
```

Why：防止未授权设备加入账户；人工校验码防止设备激活阶段的 MITM。

### 5.10 Argon2 PIN/Local Password Hash

`project/mail/rust/crypto/crypto-pin-hash/src/argon2.rs:22-62`

```rust
#[derive(Clone, Debug, PartialEq, Zeroize, ZeroizeOnDrop)]
pub struct ProtonArgon2Hash(String);

pub fn hash<P: AsRef<[u8]>>(password: P) -> Result<Self, Argon2HashingError>
pub fn verify<P: AsRef<[u8]>>(&self, password: P) -> Result<bool, Argon2HashingError>
```

Why：Argon2 是内存困难型密码哈希，抗 GPU/ASIC；salt 防彩虹表；`ZeroizeOnDrop` 清除 hash string。

### 5.11 签名与加密分离

- 草稿和 package 用 sender address key 签名：`project/mail/rust/crypto/crypto-inbox/src/message/encrypt.rs:60-64`
- 签名验证与解密分离，UI 可先显示明文、再异步显示信任状态：`project/mail/rust/crypto/crypto-inbox/src/message/decrypt.rs:73-113`

Why：提升用户体验；避免等待密钥查找/验证完成才能显示内容。

### 5.12 随机数生成

`proton_crypto::generate_secure_random_bytes` 用于：

- EO challenge：`project/mail/rust/crypto/crypto-inbox/src/eo.rs:55`
- QR login 加密 key：`project/mail/rust/account/account-api/src/login/state/want_login.rs:108`
- Device secret：`project/core/rust/core-key/src/sso_device/device_secret.rs:48`

Why：nonce、key、challenge 必须不可预测。

---

## 6. 密钥管理、交换与存储

### 6.1 密钥生成

**User Key**：`project/core/rust/core-key/src/keys/new_user_key.rs:35-47`

```rust
let algo = KeyGeneratorAlgorithm::ECC;
let salt = KeySalt::generate();
let pass = salt.salted_key_passphrase(srp, pass.as_ref())?;
let key = LocalUserKey::generate(pgp, algo, &pass)?;
```

**Address Key**：`project/core/rust/core-key/src/keys/new_addr_key.rs:21-41`

```rust
let local_address_key =
    LocalAddressKey::generate(pgp, address.email.as_str(), algo, flags, primary, user_key)?;
let signed_key_list = create_addr_skl(pgp, user_key, &local_address_key)?;
```

登录流程会自动为没有 key 的用户/地址创建 key：`project/mail/rust/account/account-api/src/login/state/mod.rs:456-516`

### 6.2 导入/导出

- 公钥从 API 响应导入：`project/mail/rust/core/core-key-manager/src/manager.rs:477-493`
- 内存缓存把解锁私钥导出为 bytes 再重新导入：`project/mail/rust/core/core-key-manager/src/cache.rs:35-60`
- 改密码时重新导出私钥：`project/mail/rust/account/account-api/src/password/api.rs:116-130`

### 6.3 存储位置

| 密钥材料 | 存储位置 |
|---|---|
| Locked user private keys | SQLite `User.keys`：`project/mail/rust/core/core-common/src/models/user.rs:25-53` |
| Locked address private keys | SQLite `Address.keys`：`project/mail/rust/core/core-common/src/models/address.rs:25-73` |
| 其他收件人公钥 | `/core/v4/keys/all` API 响应，本地 `PublicAddressKeysResponseCache` 缓存 |
| Contact pinned keys | 签名 vCard（contacts DB），由 `crypto-contact-keys` 提取 |
| Session/KeySecret 加密密钥 | OS keychain：`project/mail/rust/core/core-common/src/os/keychain.rs:32-44` |

### 6.4 Keyring 结构

- 每个账户一个 `UserKeys`
- 每个 address 一个 `AddressKeys`
- Address keys 从属于 user key
- 每个 address 有 `AddressSignedKeyList`

### 6.5 密钥发现

**Proton API `keys/all`**：

- Request：`project/mail/rust/account/account-api/src/protocol/proton.rs:745-754`
- Response：`project/mail/rust/core/core-api/src/services/proton/core/responses.rs:56-88`

响应结构：

```rust
pub struct PublicAddressKeysResponse {
    pub address_keys: APIPublicAddressKeyGroup,      // 验证过的地址 key（含 SKL）
    pub catch_all: Option<APIPublicAddressKeyGroup>, // catch-all
    pub unverified: Vec<APIUnverifiedPublicAddressKeyGroup>, // 遗留或 WKD key
    pub is_proton: bool,
    pub proton_mx: bool,
    pub warnings: Vec<String>,
}
```

**WKD**：在 `Unverified` 组中以 `APIPublicKeySource::WKD` 出现（测试见 `project/mail/rust/crypto/crypto-inbox/tests/keys.rs:538-557`），没有独立 WKD 客户端实现。

**Keyserver / Autocrypt**：在当前 Rust 代码中未找到实现；Autocrypt 只出现在 MIME 测试数据中。

**Contact pinned keys**：

- 加载签名 vCard：`project/mail/rust/core/core-common/src/user_context/services/crypto_key_service.rs:380-472`
- 验证签名并提取 key：`project/mail/rust/crypto/crypto-contact-keys/src/vcard_crypto.rs:21-48`
- 提取偏好：`vcard_crypto.rs:117-155`（`encrypt_to_pinned`、`encrypt_to_untrusted`、`sign`、`scheme`、`mime_type`）

### 6.6 信任模型

**选择优先级**：`project/mail/rust/crypto/crypto-inbox/src/keys/verification.rs:145-150`

1. Pinned contact keys 优先于 API keys
2. API verified address keys（`address_keys`）视为 Proton/internal
3. Unverified keys（legacy/WKD）仅在没有 verified key 时使用
4. 标记 compromised 的 key 被过滤

**冲突处理**：

- 如果 pinned keys 存在但 API keys 不匹配，抛出 `EncryptionPreferencesError::ApiKeyNotPinned`：`project/mail/rust/crypto/crypto-inbox/src/keys/encryption.rs:302-305`
- 预期 UX：弹窗强制用户选择信任哪个 API key 后再发送

**验证状态**：`project/mail/rust/crypto/crypto-inbox/src/lock_icon.rs:121-127`

```rust
pub enum MailVerificationStatus {
    NotVerified,
    NotSigned,
    SignedAndValid,
    SignedAndInvalid,
    SignedNoPublicKey,
}
```

---

## 7. 前端 UI/UX 设计

### 7.1 限制说明

该仓库只有 Rust TUI（`mail-tui`），没有 React/Web/Android/iOS UI。因此 UI 分析基于：

1. `lock_icon.rs` 的状态机模型
2. `mail-tui` 的渲染代码
3. API/event 类型设计
4. 与 Thunderbird/Proton Web 的对比推断

### 7.2 Lock Icon 状态机

`project/mail/rust/crypto/crypto-inbox/src/lock_icon.rs:11-98`

```rust
pub enum LockIcon {
    ClosedLock,
    ClosedLockWithTick,
    ClosedLockWithPen,
    ClosedLockWarning,
    OpenLockWithPen,
    OpenLockWithTick,
    OpenLockWarning,
}

pub enum LockColor {
    Black,
    Green,
    Blue,
}

pub struct UiLock {
    pub icon: LockIcon,
    pub color: LockColor,
    pub tooltip: LockTooltip,
}
```

颜色含义：

- **Blue**：Proton/internal 端到端加密
- **Green**：外部 PGP 端到端加密
- **Black**：zero-access（仅服务器端加密，非端到端）

勾选/警告：

- Tick：pinned/verified recipient
- Warning：验证失败或缺少签名

### 7.3 Composer 收件人状态

每个收件人携带 `PrivacyLockState` 和 `ValidationState`：`project/mail/rust/mail/mail-common/src/draft/recipients.rs:60-91, 143-150`

Lock 通过 `recipient_send_preferences` 异步计算，支持缓存回退策略：`project/mail/rust/mail/mail-common/src/draft/recipients.rs:1089-1162`

TUI 在收件人列表旁渲染 lock icon + tooltip：`project/mail/rust/mail/mail-tui/src/app_model/mailbox/composer/recipient_list.rs:239-256`

### 7.4 阅读窗隐私指示器

`project/mail/rust/mail/mail-tui/src/app_model/mailbox/messages.rs:1132-1225`

```rust
let lock_builder = body.privacy_lock(&tether).await;
...
let (lock_str, lock_style) = lock_icon_to_text(self.lock);
...
if let Some(lock) = self.lock {
    headers.push(Row::new([
        Cell::from("Privacy:").bold(),
        Cell::from(lock.tooltip.to_string()),
    ]));
}
```

Lock 显示在 `From:` 行和独立的 `Privacy:` 行。

### 7.5 登录/解锁界面

- `project/mail/rust/mail/mail-tui/src/app_model/login.rs`：用户名/密码 + 2FA
- `project/mail/rust/mail/mail-tui/src/app_model/mbox_password.rs`：mailbox password 输入（"Unlocking mailbox ..."）
- `project/mail/rust/mail/mail-tui/src/app_model/context_init.rs`：解锁后初始化 user context

### 7.6 缺少的 TUI 功能

`mail-tui` 没有完整的 key manager UI；key setup 在登录/注册时自动完成，信任/pinning 主要通过 contacts 后端驱动。

### 7.7 对 Kylins 前端（React/Tauri）的借鉴

| 区域 | 可借鉴的 Proton 模式 |
|---|---|
| **Compose 收件人 readiness** | 每个收件人 pill 旁显示 async `PrivacyLockState`；支持 `RequireSync` / `AllowCachedFallback` 策略；未就绪时禁用发送。 |
| **Reading pane 加密状态** | 单一 `UiLock` 状态机；在发件人行和独立 `Privacy:` 行显示；用颜色区分 internal/external/zero-access。 |
| **Key setup wizard** | 登录时自动生成 ECC user key → SRP+salt 派生 KeySecret → 创建 address keys → 生成 SKL → 上传。 |
| **Key manager** | 展示 user keys / address keys / primary flag / active flag / fingerprints / SKL epoch / 来源（Proton/contact pinned/WKD unverified）。 |
| **Trust dialog** | pinned keys 与 API keys 冲突时阻断发送，弹窗让用户对比 fingerprint 后选择信任。 |
| **Encrypted drafts** | 上传前用 primary address key 加密 draft body，立即解密验证 round-trip。 |
| **Local security** | OS keychain 存随机 DB 加密密钥；SQLite 中的 key secret 和 token 用该密钥 AES-GCM 加密；可选 PIN 应用锁；解锁 key 内存缓存 TTL。 |
| **Event-driven updates** | 通过 `CoreEvent` 轮询刷新 keys/addresses/contacts/labels，UI 不信任过期 key 材料。 |

---

## 8. 草稿加密处理

### 8.1 本地编辑期

草稿 body 以**明文**存在本地 `raw_message_body` 表：`project/mail/rust/mail/mail-common/src/actions/draft/save.rs:366-371`

```rust
RawMessageBody::local_draft(&action.body)
    .store_and_consume(message.id(), ctx.search_service(), bond)
    .await
```

```rust
pub fn local_draft(body: impl Into<String>) -> Self {
    Self::ok(RawDecryptedBody::Plain {
        raw_body: body.into().into_bytes(),
        signatures: vec![],
    })
}
```

### 8.2 上传到服务器前

`encrypt_draft_body` 用 sender primary address key 加密+签名 body，然后立即解密以捕获 signature bytes 存本地：`project/mail/rust/mail/mail-common/src/draft/compose.rs:256-305`

```rust
let encrypted = draft_body
    .encrypt_draft_body(&pgp, &draft_encryption_key)?;

let encrypted_draft = EncryptedDraftMessage { body: &encrypted };
let RawDecryptedBody::Plain { signatures, .. } = encrypted_draft
    .decrypt(&pgp, unlocked_keys.for_decryption())?;
```

### 8.3 草稿附件

附件在本地就用 address key 加密：`project/mail/rust/mail/mail-common/src/models/attachment.rs:450-488`

上传时发送加密 blob、key packets、signature、encrypted signature：`project/mail/rust/mail/mail-common/src/actions/draft/attachment_upload.rs:356-422`

### 8.4 API 草稿

```rust
POST /mail/v4/messages        // create draft
PUT  /mail/v4/messages/{id}   // update draft
```

`project/mail/rust/mail/mail-api/src/services/proton/proton_impl.rs:555-591`

### 8.5 对 Kylins 的映射

Kylins 是普通 IMAP 客户端，草稿通常以明文或加密形式存储在 IMAP Drafts 文件夹：

- **推荐**：本地草稿明文编辑；保存到 IMAP 前若启用加密，则用 sender key 加密成 PGP/MIME 或 S/MIME 格式。
- **安全选项**：支持“本地草稿始终加密”模式，用 sender key 加密本地草稿。

---

## 9. 对 Kylins 的综合设计建议

> **权威设计文档：** 本节为基于 Proton Rust Clients 源码学习得出的方向性建议；Kylins 加密模块的权威设计以 [`crypto-architecture-design.md`](crypto-architecture-design.md) 为准。两者冲突时以设计文档为准。

### 9.1 架构层

1. **统一 `CryptoProvider` trait**：屏蔽 OpenPGP/S-MIME/国密，定义 `sign`、`encrypt`、`decrypt`、`verify`、`generate_key`、`import_key`。
2. **Backend feature flags**：`crypto-rpgp`（默认）、`crypto-sequoia`、`crypto-sm`。
3. **`KeyStore` trait**：SQLite / token / WKD / keyserver 多种实现。
4. **`ComposeSecure` trait**：抽象发送时的 encapsulation（begin/write/finish）。
5. **事件驱动**：加密/验证结果通过 Tauri event 推送给前端，前端不直接调用 crypto。

### 9.2 发送流程

1. Composer 设置 `isSigned`、`isEncrypted`、`cryptoMethod`。
2. 发送前调用 `checkSendReadiness(accountId, recipients, cryptoMethod)`。
3. 后端返回每个收件人的 `RecipientReadiness`（ready / no_key / expired / rejected / alias / ...）。
4. 前端展示 Key Assistant 式弹窗，分 ready / problematic 两栏，提供 Discover / Import / Disable Encryption 按钮。
5. 所有收件人 ready 后才启用发送。
6. 后端根据 crypto method 构建标准 PGP/MIME 或 S/MIME，交给 SMTP/EAS 发送。

### 9.3 接收流程

1. IMAP 拉取原始 MIME。
2. 后端 `detectCryptoType(contentType)` 识别类型。
3. 解密/验证后返回 `CryptoStatusEvent`：

```typescript
interface CryptoStatusEvent {
  messageId: string;
  tech: 'openpgp' | 'smime' | null;
  encryption: 'ok' | 'notok' | null;
  signature: 'ok' | 'verified' | 'unverified' | 'mismatch' | 'unknown' | null;
  lockColor?: 'blue' | 'green' | 'black';
  details: {
    signerKeyId?: string;
    signerFingerprint?: string;
    signerEmail?: string;
    encryptionKeyId?: string;
    recipientKeys?: Array<{ email: string; fingerprint: string }>;
    error?: string;
    dateMismatch?: boolean;
    uidMismatch?: boolean;
    ktVerified?: boolean;
  };
}
```

4. 前端 `CryptoBadge` 渲染；详情面板按 tech 分派。

### 9.4 密钥管理

1. **密钥层级**：Account Master Key → Identity Key（OpenPGP/S-MIME/SM2）→ Message Session Key。
2. **私钥保护**：软私钥用 master key AES-GCM 加密存 SQLite；master key 存 OS keychain。
3. **解锁缓存**：10 min user key / 5 min address key；显式 lock 命令立即清除。
4. **自动发现 key**：先进 `collected_keys`，用户显式 accept 后进 `crypto_keys`。
5. **信任决策**：rejected / undecided / unverified / verified / personal。
6. **冲突处理**：已有 accepted key 时新 key 不自动替换，显示冲突对话框。

### 9.5 UI/UX

1. **Compose**：per-recipient lock icon + tooltip；未就绪禁用发送；Key Assistant 弹窗。
2. **Reading pane**：crypto badge + `Privacy:` row；颜色区分 internal/external/plain；详情面板展示 signer/encryption key + trust actions。
3. **Key Manager**：表格展示 keys，搜索过滤，右键 View/Export/Delete/Set Default/Change Expiry。
4. **Key Details**：Overview / Acceptance / Email Addresses / Passphrase / Certifications / Structure tabs。
5. **Backup/Restore**：密码强度条 + 二次确认。
6. **Trust Dialog**：首次收到签名邮件弹出；fingerprint 对比；接受/拒绝。
7. **Encrypted Drafts**：本地明文编辑；保存到 IMAP 前可选加密；或本地草稿也加密。

### 9.6 安全措施

1. 所有 secrets 用 `secrecy` + `zeroize`。
2. AES-GCM 加 AAD 绑定 account/field/version。
3. 常量时间比较 MAC/fingerprint。
4. 解锁 key cache TTL。
5. OS keychain 保护 master key。
6. 可选 PIN/生物识别应用锁（Argon2 哈希）。
7. 不信任 Autocrypt `prefer-encrypt=mutual` 自动加密。
8. WKD 优先，keyserver 回退。
9. Key transparency / contact pinning 用于信任决策。
10. 所有 crypto 操作 async + spawn_blocking。

---

## 10. 关键文件索引

### 加密抽象与核心安全

| 用途 | 路径 |
|---|---|
| Workspace crypto deps | `Cargo.toml:308-324` |
| `PGPProviderSync` 使用示例 | `project/mail/rust/crypto/crypto-inbox/src/message/decrypt.rs:180` |
| Key Manager | `project/mail/rust/core/core-key-manager/src/manager.rs:161-660` |
| Key Manager traits | `project/mail/rust/core/core-key-manager/src/traits.rs:60-134` |
| CryptoKeyService 实现 | `project/mail/rust/core/core-common/src/user_context/services/crypto_key_service.rs:145-486` |
| 敏感数据包装 | `project/core/rust/core-sensitive-data/src/lib.rs:19-44` |
| 内存 key cache | `project/mail/rust/core/core-key-manager/src/cache.rs:14-191` |
| PIN/应用锁 | `project/mail/rust/core/core-common/src/pin_code.rs:50-221` |
| SRP 认证 | `project/mail/rust/account/account-api/src/password/api.rs:49-72` |
| Argon2 哈希 | `project/mail/rust/crypto/crypto-pin-hash/src/argon2.rs:22-62` |
| Device Secret | `project/core/rust/core-key/src/sso_device/device_secret.rs:28-121` |
| Encrypted Secret | `project/core/rust/core-key/src/sso_device/encrypted_secret.rs:10-42` |
| New User Key | `project/core/rust/core-key/src/keys/new_user_key.rs:35-107` |
| New Address Key | `project/core/rust/core-key/src/keys/new_addr_key.rs:21-79` |

### 邮件发送/接收

| 用途 | 路径 |
|---|---|
| Send action | `project/mail/rust/mail/mail-common/src/actions/draft/send.rs:469-502` |
| load_prefs | `project/mail/rust/mail/mail-common/src/draft/send.rs:50-116` |
| build_packages | `project/mail/rust/mail/mail-common/src/draft/send.rs:120-154` |
| Package builder | `project/mail/rust/shared/mail-package-builder/src/packages.rs:73-385` |
| Body encryption | `project/mail/rust/crypto/crypto-inbox/src/message/packages.rs:136-176` |
| SendPreferences | `project/mail/rust/crypto/crypto-inbox/src/keys/encryption.rs:151-288` |
| Recipient key model | `project/mail/rust/crypto/crypto-inbox/src/keys/verification.rs:69-171` |
| Decrypt message body | `project/mail/rust/mail/mail-common/src/models/message.rs:1687-1718` |
| DecryptableMessage | `project/mail/rust/crypto/crypto-inbox/src/message/decrypt.rs:73-246` |
| MIME read | `project/mail/rust/crypto/crypto-inbox-mime/src/read.rs:130-266` |
| Signature verify | `project/mail/rust/crypto/crypto-inbox/src/message/verify.rs:10-60` |
| HTML transformer | `project/mail/rust/mail/mail-html-transformer/src/lib.rs:139-263` |
| Send API | `project/mail/rust/mail/mail-api/src/services/proton/proton_impl.rs:593-617` |

### UI/UX

| 用途 | 路径 |
|---|---|
| Lock icon 状态机 | `project/mail/rust/crypto/crypto-inbox/src/lock_icon.rs:11-98` |
| Lock icon 颜色/提示 | `project/mail/rust/crypto/crypto-inbox/src/lock_icon.rs:401-573` |
| Verification status | `project/mail/rust/crypto/crypto-inbox/src/lock_icon.rs:121-127` |
| Composer recipient locks | `project/mail/rust/mail/mail-common/src/draft/recipients.rs:60-150, 1089-1162` |
| TUI recipient list | `project/mail/rust/mail/mail-tui/src/app_model/mailbox/composer/recipient_list.rs:239-256` |
| Reading pane privacy | `project/mail/rust/mail/mail-tui/src/app_model/mailbox/messages.rs:1132-1225` |
| TUI keychain | `project/mail/rust/mail/mail-tui/src/keychain.rs:8-21` |
| Mailbox password screen | `project/mail/rust/mail/mail-tui/src/app_model/mbox_password.rs` |
| Login screen | `project/mail/rust/mail/mail-tui/src/app_model/login.rs` |

---

## 11. 与 Thunderbird 的对比

| 维度 | Thunderbird | Proton Clients |
|---|---|---|
| 抽象层 | XPCOM `nsIMsgComposeSecure` + sink | Rust `PGPProviderSync` trait |
| 后端 | RNP (C++) / NSS CMS | `proton-crypto-account` with rustpgp |
| 后端切换 | 编译时 / 运行时有限 | Workspace feature flag |
| 密钥模型 | 独立 PGP keys / S/MIME certs | User Key → Address Key hierarchy |
| 服务器依赖 | 无，纯本地 | Proton API 提供 keys/all + SKL |
| 信任模型 | TOFU + pinning | Pinned + API verified + SKL + KT |
| Key discovery | WKD/keyserver/Autocrypt | API + contact vCards + WKD（仅作为 API unverified） |
| 草稿加密 | 本地明文，发送时加密 | 本地明文，上传前加密 |
| 本地密钥保护 | NSS DB + master password | OS keychain + AES-GCM SQLite |
| UI 丰富度 | 完整 GUI（wizard/manager/details） | TUI 有限，但状态机模型清晰 |

**对 Kylins 的启示：**

- 如果 Kylins 是本地优先的通用客户端，Thunderbird 的 UI 工作流更完整可借鉴。
- Proton 的密钥层级、SKL/KT、API 集成模式更适合 SaaS/端到端加密服务。
- Kylins 可以结合两者：用 Thunderbird 的 UI 模式 + Proton 的本地密钥保护链 + 通用的 WKD/keyserver 发现。

---

*报告由三个子代理并行分析 Proton Clients 的加密抽象层、邮件加解密流程、密钥管理与 TUI UI/UX 后整合生成。*
