# Kylins Client 加密架构设计（OpenPGP / S/MIME / 国密 SM2/SM3/SM4）

> 基于 Thunderbird、proton-crypto-rs、rust-cryptoki 本地源码学习与 Web 深度研究的综合架构设计。  
> 版本：v1.0（2026-07-09）  
> 前置文档：`docs/superpowers/specs/2026-06-29-crypto-system-design.md`、`docs/superpowers/specs/2026-06-29-kylins-crypto-architecture-review.md`、`docs/openpgp-research-report.md`、`docs/proton-crypto-rs-learning-report.md`、`docs/thunderbird-smime-learning-report.md`

---

## 1. 设计目标与需求映射

| 需求 | 设计对策 |
|---|---|
| 全面支持 OpenPGP 与 S/MIME | 分别实现 `OpenPgpProvider` 与 `SmimeProvider`，统一封装在 `CryptoProvider` 抽象后 |
| 底层算法可配置（hash / 对称加密 / 非对称加密） | 引入版本化的 `CryptoPolicy` 策略表；所有后端在操作前与策略对齐 |
| 支持国密 SM2/SM3/SM4 | 优先评估 `libsm` 纯 Rust 方案；不满足 S/MIME/CMS 互操作时通过 `gmssl-rs`（FFI GmSSL）或自定义 FFI 实现 |
| 抽象层可替换 | `CryptoProvider` trait + 关联类型 + Builder 模式；上层只依赖 `crypto::provider` |
| 借鉴 proton-crypto-rs | 采用其 `Provider`/`Builder`/`Profile` 三层结构、`CryptoError` 擦除、`secrecy` 生命周期 |
| PKCS#11 / Smartcard / HSM | `rust-cryptoki` 封装 token 会话；S/MIME 走 token 原始 RSA/EC 运算；OpenPGP 走 `openpgp-card` 生态 |
| Web 最佳实践 | RFC 9580/8551/9980 算法基线、Argon2 S2K、contact pinning、explicit-consent key discovery、async crypto tasks |

---

## 2. 参考架构分析

### 2.1 Thunderbird 的关键启示

Thunderbird 的加密分层非常清晰：

```text
UI (JS) → XPCOM 抽象 (nsIMsgComposeSecure / nsIMsgOpenPGPSink / nsIMsgSMIMESink)
    → MIME 桥接 (PgpMimeHandler / nsPgpMimeProxy / mimecms)
    → 加密引擎 (RNP for OpenPGP, NSS CMS for S/MIME)
    → PKCS#11 (NSS 加载 token 模块)
```

**值得借鉴：**
1. **按技术独立的 `ComposeSecure` 抽象**——S/MIME 与 OpenPGP 共用同一发送接口，UI 不感知后端差异。
2. **异步 crypto task**——S/MIME 验证派发到后台线程，避免 OCSP/复杂验证阻塞 UI。
3. **独立 trust/acceptance 存储**——`openpgp.sqlite` 只存指纹+邮箱的接受状态，与密钥环正交。
4. **证书按 usage 与 email 索引**——`certUsageEmailSigner` / `certUsageEmailRecipient`。
5. **集中算法策略**——Thunderbird 当前硬编码 `AES256`/`SHA256` 并禁用 AEAD；我们应反过来把策略外置。

**应避免：**
- Thunderbird 的 RNP/GPGME 分支散落在多处，没有干净的 trait 边界。
- S/MIME 完全绑定 NSS，无法独立测试或替换。
- OpenPGP 智能卡依赖外部 GnuPG/gpg-agent，用户体验割裂。

### 2.2 proton-crypto-rs 的关键启示

proton-crypto-rs 是 **Proton 产品专用 SDK**，不能直接复用，但其架构模式高度可借鉴：

```text
proton-crypto (facade + trait)
    ├── gopenpgp-sys (Go FFI backend, feature gopgp)
    ├── proton-rpgp (pure-Rust backend, feature rustpgp)
    └── proton-crypto-account / proton-srp / proton-crypto-subtle
```

**可借鉴到 Kylins 的模式：**
1. **`PGPProvider` trait + 关联类型**——`type PublicKey`、`type PrivateKey`、`type SigningContext`。
2. **Builder 子 trait**——`Encryptor`/`Decryptor`/`Signer`/`Verifier`，链式 `with_*` 配置。
3. **Profile / CryptoPolicy**——`proton-rpgp/src/profile.rs` 集中管理允许/拒绝的算法列表、最小密钥长度、DoS 限制。
4. **`CryptoError` 类型擦除**——`Arc<dyn std::error::Error + Send + Sync>`，让后端错误跨 trait 边界。
5. **Sync/Async 镜像 trait**——同操作提供同步与异步两版。
6. **强类型标识符**——`OpenPGPFingerprint`、`KeyId` 等 newtype，避免字符串混用。
7. **`secrecy` + `zeroize`**——`KeySecret`、`AesGcmKey` 实现 `ZeroizeOnDrop`。
8. **Cargo feature 后端选择**——`gopgp`/`rustpgp`/`multi_be`。

**不能照搬：**
- Proton 的 account/user/address key 层级、SRP、SKL、device verification 与 Kylins 无关。
- README 明确声明 “Not intended or vetted for general usage outside Proton”。

### 2.3 rust-cryptoki 的关键启示

`rust-cryptoki` 是 Parsec 维护的 PKCS#11 安全封装：

```text
cryptoki-sys  (bindgen FFI)
cryptoki       (safe wrapper: Pkcs11, Slot, Session, ObjectHandle, Mechanism, Attribute)
```

**核心使用模式：**
1. **单进程一个 `Pkcs11` 上下文**——`Arc<Pkcs11Impl>`，可 `Clone`。
2. **按 token 枚举**——`get_slots_with_initialized_token()` + `TokenInfo` 检查 `login_required` / `protected_authentication_path`。
3. **Session 非 `Sync`**——同一 session handle 不能并发；长生命周期应用需要 session pool。
4. **私钥绝不导出**——只通过 `ObjectHandle` 调用 `sign`/`decrypt`。
5. **Mechanism 探测**——调用前用 `get_mechanism_list` / `get_mechanism_info` 确认 token 支持。
6. **`AuthPin` / `RawAuthPin`**——`secrecy::SecretString` 包装，避免 PIN 泄露到日志。
7. **登录状态按 session**——需处理 `UserAlreadyLoggedIn` / `UserNotLoggedIn`。

### 2.4 Web 研究验证的关键事实

| 结论 | 来源/标准 |
|---|---|
| RFC 9580（2024-07）是当前 OpenPGP 标准，废弃 RFC 4880/5581/6637 | RFC 9580 |
| RFC 9580 禁止生成 Simple S2K，推荐 Argon2 | RFC 9580 §3.7.2 |
| RFC 9980（2026-06）已发布，定义 OpenPGP 后量子算法：ML-KEM-768+X25519 (ID 35, MUST)、ML-DSA-65+Ed25519 (ID 30, MUST) | RFC 9980 |
| RFC 8551（S/MIME 4.0）强制 SHA-256/SHA-512、AES-128-GCM/AES-256-GCM；SHA-1/3DES 标记为 historic | RFC 8551 |
| RFC 8551 的 `SMIMECapabilities` 是算法协商机制 | RFC 8551 §2.5.2 |
| OpenPGP 的算法敏捷性通过 packet 中的算法标识符实现，但 v4→v6 迁移涉及结构变化（指纹、packet 版本） | RFC 9580, Sequoia guide |
| `sequoia-openpgp` 与 `rpgp` 均瞄准 RFC 9580；Sequoia 依赖 Nettle(C)，rPGP 纯 Rust | crates.io, project docs |
| `openpgp-pkcs11-sequoia`/`openpgp-card-rpgp` 提供 OpenPGP 智能卡路径 | lib.rs, Codeberg |
| `gmssl-rs` 是 GmSSL 的 Rust FFI 封装，声明 SM2/SM3/SM4/X.509 稳定、SM9 实验性 | crates.io, GitHub |
| `gmssl-rs` 非常新（0.1.1，2026-05），成熟度与独立审计不足 | crates.io, GmSSL issues |
| `rust-cryptoki` 是 Rust PKCS#11 主流封装，活跃维护 | GitHub, crates.io |
| `cms` (RustCrypto) 实现 RFC 5652 CMS，是 S/MIME 的 Rust 原生基础 | docs.rs |

---

## 3. Kylins 加密模块总体架构

### 3.1 分层设计

```text
┌─────────────────────────────────────────────────────────────────────┐
│  Frontend (React 19)                                                │
│  Composer 加密选项 / ReadingPane 安全状态 / SecurityPreferences     │
│  services/crypto/mailCrypto.ts                                      │
└───────────────────────────┬─────────────────────────────────────────┘
                            │ invoke / events
┌───────────────────────────┴─────────────────────────────────────────┐
│  Tauri v2 Rust backend                                              │
│  commands/crypto_commands.rs                                        │
│  crypto/                                                            │
│   ├── provider.rs          CryptoProvider trait + CryptoPolicy      │
│   ├── types.rs             共享类型、错误、算法枚举                  │
│   ├── mime/                S/MIME & PGP/MIME 包装/解包              │
│   ├── key_store.rs         KeyStore trait                          │
│   ├── trust.rs             TrustPolicy / pinning / TOFU            │
│   │                                                                 │
│   ├── openpgp/             OpenPGP 后端                            │
│   │   ├── engine.rs        Sequoia 或 rPGP 封装                     │
│   │   ├── provider.rs      OpenPgpProvider impl CryptoProvider      │
│   │   ├── key_store.rs     PGP keyring / WKD / Autocrypt            │
│   │   ├── smartcard.rs     openpgp-card 集成                        │
│   │   └── policy.rs        OpenPGP-specific policy                 │
│   │                                                                 │
│   ├── smime/               S/MIME 后端                             │
│   │   ├── engine.rs        CMS Signed/EnvelopedData                │
│   │   ├── provider.rs      SmimeProvider impl CryptoProvider        │
│   │   ├── cert_store.rs    X.509 证书存储+验证                     │
│   │   └── pkcs11.rs        rust-cryptoki token 封装                 │
│   │                                                                 │
│   └── sm/                  国密后端 (Phase 3)                       │
│       ├── engine.rs        SM2/SM3/SM4 CMS / OpenPGP SCA           │
│       ├── provider.rs      SmProvider impl CryptoProvider           │
│       ├── cert_store.rs    SM2 证书                                │
│       └── ffi.rs           GmSSL FFI 封装（如需要）                 │
│                                                                     │
│  db/                    证书/密钥/信任决策 SQLite 表                │
│  crypto.rs              现有 master key + AES-256-GCM               │
└─────────────────────────────────────────────────────────────────────┘
```

### 3.2 模块目录（推荐）

```text
kylins.client.backend/src/
├── crypto/
│   ├── mod.rs
│   ├── provider.rs
│   ├── types.rs
│   ├── error.rs
│   ├── policy.rs
│   ├── key_store.rs
│   ├── trust.rs
│   ├── mime.rs
│   ├── openpgp/
│   │   ├── mod.rs
│   │   ├── provider.rs
│   │   ├── engine.rs
│   │   ├── key_store.rs
│   │   ├── discovery.rs
│   │   ├── smartcard.rs
│   │   └── policy.rs
│   ├── smime/
│   │   ├── mod.rs
│   │   ├── provider.rs
│   │   ├── engine.rs
│   │   ├── cert_store.rs
│   │   ├── validation.rs
│   │   └── pkcs11.rs
│   └── sm/
│       ├── mod.rs
│       ├── provider.rs
│       ├── engine.rs
│       ├── cert_store.rs
│       └── ffi.rs
├── commands/
│   └── crypto_commands.rs
└── db/
    ├── certs.rs
    ├── pgp_keys.rs
    ├── sm_keys.rs
    └── trust_decisions.rs
```

---

## 4. 抽象层设计：CryptoProvider

### 4.1 核心 trait

借鉴 proton-crypto-rs 的 `PGPProvider` + 关联类型，但泛化为邮件加密标准无关：

```rust
// crypto/provider.rs
use async_trait::async_trait;

pub trait CryptoProvider: Send + Sync + 'static {
    type Key: CryptoKey;
    type PublicKey: PublicKey;
    type PrivateKey: PrivateKey;
    type SessionKey: SessionKey;
    type SignedMessage: SignedMessage;
    type EncryptedMessage: EncryptedMessage;

    fn name(&self) -> &'static str;
    fn version(&self) -> &str;

    fn policy(&self) -> &CryptoPolicy;

    fn new_signer(&self, key: &Self::PrivateKey) -> Result<Box<dyn Signer>, CryptoError>;
    fn new_verifier(&self) -> Result<Box<dyn Verifier>, CryptoError>;
    fn new_encryptor(&self) -> Result<Box<dyn Encryptor>, CryptoError>;
    fn new_decryptor(&self, key: &Self::PrivateKey) -> Result<Box<dyn Decryptor>, CryptoError>;

    fn generate_key(&self, params: KeyGenParams) -> Result<Self::Key, CryptoError>;
    fn import_key(&self, data: &[u8], passphrase: Option<&str>) -> Result<Self::Key, CryptoError>;
    fn export_public_key(&self, key: &Self::PublicKey) -> Result<Vec<u8>, CryptoError>;

    fn key_store(&self) -> &dyn KeyStore<Key = Self::Key>;

    fn supported_algorithms(&self) -> AlgorithmCapabilities;
}

#[async_trait]
pub trait CryptoProviderAsync: CryptoProvider {
    async fn sign(&self, op: SignOp) -> Result<Self::SignedMessage, CryptoError>;
    async fn verify(&self, op: VerifyOp) -> Result<VerificationResult, CryptoError>;
    async fn encrypt(&self, op: EncryptOp) -> Result<Self::EncryptedMessage, CryptoError>;
    async fn decrypt(&self, op: DecryptOp) -> Result<DecryptResult, CryptoError>;
}
```

### 4.2 Builder trait

```rust
// crypto/signer.rs
pub trait Signer: Send {
    fn with_detached(self: Box<Self>, detached: bool) -> Box<dyn Signer>;
    fn with_hash_alg(self: Box<Self>, alg: HashAlgorithm) -> Box<dyn Signer>;
    fn sign_file(self: Box<Self>, input: &Path, output: &Path) -> Result<SignedMessageData, CryptoError>;
    fn sign(self: Box<Self>, content: &[u8]) -> Result<SignedMessageData, CryptoError>;
}

// crypto/encryptor.rs
pub trait Encryptor: Send {
    fn for_recipient(self: Box<Self>, key: &dyn PublicKey) -> Box<dyn Encryptor>;
    fn with_symmetric_alg(self: Box<Self>, alg: SymmetricAlgorithm) -> Box<dyn Encryptor>;
    fn encrypt_file(self: Box<Self>, input: &Path, output: &Path) -> Result<EncryptedMessageData, CryptoError>;
    fn encrypt(self: Box<Self>, content: &[u8]) -> Result<EncryptedMessageData, CryptoError>;
}
```

`Decryptor` / `Verifier` 类似。所有 builder 都接收 `CryptoPolicy` 并在构建时校验算法是否被允许。

### 4.3 后端选择机制

运行时按 account 的 `crypto.method` 选择：

```rust
// crypto/mod.rs
pub enum CryptoBackend {
    OpenPgp(Arc<dyn CryptoProvider>),
    Smime(Arc<dyn CryptoProvider>),
    Sm(Arc<dyn CryptoProvider>),
}

pub fn resolve_provider(method: CryptoMethod) -> Arc<dyn CryptoProvider> {
    match method {
        CryptoMethod::OpenPgp => OPENPGP_PROVIDER.clone(),
        CryptoMethod::Smime => SMIME_PROVIDER.clone(),
        CryptoMethod::Sm => SM_PROVIDER.clone(),
    }
}
```

如果需要编译时切换 OpenPGP 引擎（Sequoia ↔ rPGP），再用 Cargo feature 控制 `openpgp/engine.rs` 的实现。

---

## 5. OpenPGP 后端设计

### 5.1 引擎选型：Sequoia vs rPGP

| 维度 | Sequoia (`sequoia-openpgp`) | rPGP (`pgp`) |
|---|---|---|
| 许可证 | LGPL-2.1+ / GPL-3+ | MIT/Apache-2.0（更宽松） |
| 依赖 | 依赖 Nettle (C) | 纯 Rust |
| RFC 9580 | 强 | 强 |
| 智能卡 | `openpgp-card-sequoia` | `openpgp-card-rpgp` |
| PKCS#11 | `openpgp-pkcs11-sequoia`（实验性） | `openpgp-pkcs11-tools`（围绕 rpgp/sequoia） |
| 工具链 | 完整 CLI/sq 生态 | 仅库 |
| Tauri v2 先例 | KeychainPGP 使用 Sequoia | Proton 使用 rpgp |

**推荐策略：**
- **默认引擎：rPGP**，原因：纯 Rust、MIT/Apache 许可、与 Proton 生产环境一致、与 `openpgp-card-rpgp` 配合成熟。
- **保留 Sequoia 作为可选编译后端**，通过 `CryptoProvider` trait 与 Cargo feature 切换。
- 如果未来需要 GnuPG 级互操作或 sq CLI 能力，再切 Sequoia。

### 5.2 关键实现

```rust
// crypto/openpgp/provider.rs
pub struct OpenPgpProvider {
    engine: Arc<dyn OpenPgpEngine>,
    policy: OpenPgpPolicy,
    key_store: Arc<PgpKeyStore>,
}

impl CryptoProvider for OpenPgpProvider {
    type Key = PgpKey;
    type PublicKey = PgpPublicKey;
    type PrivateKey = PgpPrivateKey;
    type SessionKey = PgpSessionKey;
    type SignedMessage = PgpSignedMessage;
    type EncryptedMessage = PgpEncryptedMessage;

    // ... 工厂方法委托给 engine
}
```

### 5.3 算法基线（默认 Policy）

```rust
// crypto/openpgp/policy.rs
pub fn default_policy() -> OpenPgpPolicy {
    OpenPgpPolicy {
        allowed_hashes: vec![HashAlgorithm::Sha256, HashAlgorithm::Sha384, HashAlgorithm::Sha512, HashAlgorithm::Sha3_256],
        allowed_symmetric: vec![SymmetricAlgorithm::Aes256, SymmetricAlgorithm::Aes128],
        allowed_aead: vec![AeadAlgorithm::Ocb, AeadAlgorithm::Eax],
        allowed_pk: vec![PkAlgorithm::Ed25519, PkAlgorithm::EcdhX25519, PkAlgorithm::Rsa3072Plus],
        rejected: vec![HashAlgorithm::Md5, HashAlgorithm::Sha1, HashAlgorithm::Ripemd160,
                       SymmetricAlgorithm::TripleDes, SymmetricAlgorithm::Idea, SymmetricAlgorithm::Cast5,
                       PkAlgorithm::Dsa, PkAlgorithm::Elgamal],
        min_rsa_bits: 3072,
        prefer_aead: true,
        s2k: S2kPolicy::Argon2 { t: 1, p: 4, m: 21 },
        dos_limits: DosLimits { max_message_size: 50 * 1024 * 1024, max_s2k_trials: 5 },
    }
}
```

### 5.4 密钥生命周期

- 生成：默认 Ed25519 主密钥 + X25519 加密子密钥；兼容选项 RSA 4096。
- 存储：私钥 armored 后用 master key AES-256-GCM 加密存 `pgp_keys` 表。
- 解锁：内存缓存 10 分钟 TTL，显式 lock 命令；`zeroize` 敏感数据。
- 发现：WKD、keyserver、Autocrypt header 均显式同意；忽略 `prefer-encrypt=mutual` 自动加密。
- 信任：contact pinning + TOFU + compromised key 过滤。

### 5.5 智能卡支持

```rust
// crypto/openpgp/smartcard.rs
pub struct OpenPgpCardBackend {
    card: Arc<Mutex<Card<PcscBackend>>>,
}

impl OpenPgpEngine for OpenPgpCardBackend {
    fn sign(&self, key: &PgpPrivateKey, data: &[u8]) -> Result<Vec<u8>, CryptoError> {
        // 通过 openpgp-card-rpgp 将签名委托到卡
    }
}
```

第一阶段只支持软件密钥；第二阶段引入 `openpgp-card-rpgp`。

---

## 6. S/MIME 后端设计

### 6.1 引擎选型

- **CMS / PKCS#7**：RustCrypto `cms` crate（RFC 5652/5911/3274 纯 Rust 实现）。
- **X.509**：`x509-cert` + `x509-parser`。
- **PKI 验证**：`rustls-webpki` 或平台证书存储（`rustls-native-certs`）；CRL/OCSP 后续补充。
- **原始非对称运算**：软件用 `rsa`/`p256`/`p384`/`p521`；token 用 `rust-cryptoki`。

### 6.2 核心设计原则

沿用 Thunderbird 的教训，但避免绑定 NSS：

1. **CMS 结构纯 Rust 构建/解析**；token 只执行原始 RSA/EC 签名或解密。
2. **证书按 email + usage 索引**，与 Thunderbird 的 `certUsageEmailSigner`/`certUsageEmailRecipient` 对齐。
3. **链验证异步化**，避免 UI 阻塞。
4. **私钥软证书**用 master key 加密存储；**token 私钥**永不离开 token。

### 6.3 关键实现

```rust
// crypto/smime/provider.rs
pub struct SmimeProvider {
    cert_store: Arc<SmimeCertStore>,
    token: Option<Arc<Pkcs11Token>>,
    policy: SmimePolicy,
}

impl CryptoProvider for SmimeProvider {
    type Key = SmimeCertKey;      // 证书 + 可选私钥引用
    type PublicKey = X509PublicKey;
    type PrivateKey = SmimePrivateKey; // 软私钥 或 token handle
    // ...
}
```

### 6.4 S/MIME 算法策略

```rust
// crypto/smime/policy.rs
pub fn default_smime_policy() -> SmimePolicy {
    SmimePolicy {
        must_support_hashes: vec![HashAlgorithm::Sha256, HashAlgorithm::Sha512],
        must_support_symmetric: vec![SymmetricAlgorithm::Aes256Gcm, SymmetricAlgorithm::Aes128Gcm],
        must_support_signature: vec![SignatureAlgorithm::EcdsaP256Sha256, SignatureAlgorithm::Ed25519, SignatureAlgorithm::RsaPssSha256],
        legacy: vec![SymmetricAlgorithm::Aes128Cbc], // MUST- 兼容
        historic: vec![HashAlgorithm::Sha1, HashAlgorithm::Md5, SymmetricAlgorithm::TripleDes],
    }
}
```

### 6.5 MIME 包装

```text
签名（detached）:  multipart/signed; protocol="application/pkcs7-signature"; micalg=sha-256
签名（opaque）:   application/pkcs7-mime; smime-type=signed-data
加密:             application/pkcs7-mime; smime-type=enveloped-data
签名+加密:        先签后加密，外层 enveloped-data
```

---

## 7. 国密 SM2/SM3/SM4 后端设计

### 7.1 需求分析

国密支持需要同时覆盖：
1. **S/MIME 国密变体**：SM2 证书 + SM3 摘要 + SM4 对称加密，封装在 CMS 中。
2. **OpenPGP 国密扩展**：参考 draft-ribose-openpgp-sca（SM2/SM3/SM4 算法 ID），但该 draft 已过期；更活跃的是 draft-liu-sm-for-openpgp-01（2024-11）。
3. **底层算法**：SM2 签名/密钥交换、SM3 哈希、SM4-CBC/GCM 对称加密。

### 7.2 实现路径

#### 方案 A：纯 Rust `libsm`（优先评估）

- `libsm` crate 提供 SM2/SM3/SM4 纯 Rust 实现。
- 优点：无 FFI，易跨平台，易集成。
- 风险：
  - CMS/SMIME 的国密 OID 与结构需要自行扩展 RustCrypto `cms`。
  - OpenPGP 国密算法 ID 尚未成为正式 RFC，需要自己维护 draft 兼容。
  - `libsm` 的 S/MIME/CMS 互操作测试数据有限。

#### 方案 B：`gmssl-rs` FFI（推荐作为 S/MIME 国密主力）

- `gmssl-rs`（2026-05 发布 0.1.1）是 GmSSL 的安全 Rust FFI 封装，已声明 SM2/SM3/SM4/X.509 稳定。
- 优点：
  - 直接支持国密 X.509、CMS、TLS 等完整协议栈。
  - 与国内 CA/企业邮件系统（Coremail 等）互操作性最好。
- 风险：
  - 非常新的 crate（0.1.x），无独立安全审计。
  - 依赖 GmSSL C 库，CMake 构建，Windows/macOS 分发复杂。
  - GmSSL 上游存在若干 open issues（SM2 CSR/cert 解析、握手 segfault 等）。

#### 方案 C：直接 FFI GmSSL / 商用 SDK

- 如果 `gmssl-rs` 不满足，可以直接用 `bindgen` 绑定 GmSSL 或国产加密机 SDK。
- 灵活但维护成本高。

### 7.3 推荐策略

| 场景 | 推荐方案 |
|---|---|
| 底层 SM2/SM3/SM4 原语 | 优先 `libsm` 纯 Rust；如 CMS/SMIME 国密封装复杂再切 `gmssl-rs` |
| S/MIME 国密完整互操作 | `gmssl-rs` FFI 或直接使用 GmSSL C API |
| OpenPGP 国密 | 在 `rpgp` 基础上扩展 SM2/SM3/SM4 packet 解析，底层用 `libsm`；算法 ID 跟随最新 draft |
| 生产部署 | 至少保留 `gmssl` feature gate，便于替换为国密合规硬件/token |

### 7.4 SM Provider 抽象

```rust
// crypto/sm/provider.rs
pub struct SmProvider {
    inner: Arc<dyn SmEngine>, // libsm-engine 或 gmssl-engine
    cert_store: Arc<SmCertStore>,
    policy: SmPolicy,
}

pub trait SmEngine: Send + Sync {
    fn sm2_sign(&self, privkey: &Sm2PrivateKey, id: &[u8], msg: &[u8]) -> Result<Vec<u8>, CryptoError>;
    fn sm2_verify(&self, pubkey: &Sm2PublicKey, id: &[u8], msg: &[u8], sig: &[u8]) -> Result<bool, CryptoError>;
    fn sm2_encrypt(&self, pubkey: &Sm2PublicKey, plain: &[u8]) -> Result<Vec<u8>, CryptoError>;
    fn sm2_decrypt(&self, privkey: &Sm2PrivateKey, cipher: &[u8]) -> Result<Vec<u8>, CryptoError>;
    fn sm3(&self, data: &[u8]) -> Result<[u8; 32], CryptoError>;
    fn sm4_cbc_encrypt(&self, key: &[u8; 16], iv: &[u8; 16], plain: &[u8]) -> Result<Vec<u8>, CryptoError>;
    fn sm4_cbc_decrypt(&self, key: &[u8; 16], iv: &[u8; 16], cipher: &[u8]) -> Result<Vec<u8>, CryptoError>;
}
```

### 7.5 国密 OID 表

| 用途 | OID |
|---|---|
| SM2 签名 | 1.2.156.10197.1.501 |
| SM2 密钥交换/加密 | 1.2.156.10197.1.301 |
| SM3 哈希 | 1.2.156.10197.1.401 |
| SM4-CBC | 1.2.156.10197.1.104 |
| SM4-GCM | 1.2.156.10197.1.104.8（需确认目标系统） |

---

## 8. PKCS#11 / HSM / Smartcard 集成

### 8.1 S/MIME  through PKCS#11

核心原则：**token 只做原始 RSA/EC 运算，CMS 结构在 Rust 中构建**。

```rust
// crypto/smime/pkcs11.rs
pub struct Pkcs11Token {
    pkcs11: Arc<Pkcs11>,
    slot: Slot,
    session_pool: Mutex<Vec<Session>>,
}

impl Pkcs11Token {
    pub fn load(lib_path: &str) -> Result<Self, CryptoError> {
        let pkcs11 = Pkcs11::new(lib_path)?;
        pkcs11.initialize(CInitializeArgs::new(CInitializeFlags::OS_LOCKING_OK))?;
        let slot = pkcs11.get_slots_with_initialized_token()?
            .into_iter().next().ok_or(CryptoError::NoToken)?;
        Ok(Self { pkcs11: Arc::new(pkcs11), slot, session_pool: Mutex::new(vec![]) })
    }

    pub fn find_certs(&self) -> Result<Vec<CertInfo>, CryptoError> { /* ... */ }

    pub fn sign_digest(&self, handle: ObjectHandle, mechanism: Mechanism, digest_info: &[u8])
        -> Result<Vec<u8>, CryptoError>
    {
        let mut session = self.acquire_session(false)?;
        session.sign(&mechanism, handle, digest_info)
    }

    pub fn decrypt_kek(&self, handle: ObjectHandle, mechanism: Mechanism, encrypted_kek: &[u8])
        -> Result<Vec<u8>, CryptoError>
    {
        let mut session = self.acquire_session(false)?;
        session.decrypt(&mechanism, handle, encrypted_kek)
    }
}
```

### 8.2 OpenPGP through PKCS#11 / OpenPGP card

- 优先使用 `openpgp-card-rpgp`（PC/SC 后端）。
- 对于仅暴露 PKCS#11 的 HSM（如 SafeNet、YubiHSM），使用 `openpgp-pkcs11-sequoia` 或自研 bridge：
  - 将 OpenPGP 子密钥加载到 HSM；
  - 签名/解密时通过 `rust-cryptoki` 调用 token；
  - OpenPGP 证书本体仍由本地维护。

### 8.3 Token 发现与 PIN UX

```rust
pub enum PinEntry {
    Provided(SecretString),
    ProtectedAuthPath, // 让 vendor PIN 对话框处理
}

pub fn login_if_needed(session: &mut Session, token_info: &TokenInfo, pin: PinEntry) -> Result<()> {
    if !token_info.login_required() { return Ok(()); }
    if token_info.protected_authentication_path() {
        session.login(UserType::User, None)?;
    } else {
        session.login(UserType::User, Some(&AuthPin::new(pin.expose_secret().into())))?;
    }
    Ok(())
}
```

### 8.4 SafeNet Token 特别注意事项

- SafeNet 驱动通常提供多个 slot；按 `TokenInfo::token_present()` + label/serial 选择。
- 优先 RSA-PSS/OAEP SHA-256 或 ECDSA P-256/P-384；用 `get_mechanism_list` 确认。
- Windows 上库路径可能为 `C:\Program Files\SafeNet\Authentication\Softhsm2.dll` 或类似；提供 UI 配置。

---

## 9. 算法可配置性与策略

### 9.1 CryptoPolicy 统一结构

```rust
// crypto/policy.rs
#[derive(Clone, Debug)]
pub struct CryptoPolicy {
    pub hash: HashPolicy,
    pub symmetric: SymmetricPolicy,
    pub aead: AeadPolicy,
    pub public_key: PkPolicy,
    pub key_derivation: KdfPolicy,
    pub dos: DosPolicy,
}

pub struct HashPolicy {
    pub allowed: Vec<HashAlgorithm>,
    pub rejected: Vec<HashAlgorithm>,
    pub default: HashAlgorithm,
}

pub struct SymmetricPolicy {
    pub allowed: Vec<SymmetricAlgorithm>,
    pub rejected: Vec<SymmetricAlgorithm>,
    pub default: SymmetricAlgorithm,
}

pub struct PkPolicy {
    pub allowed: Vec<PkAlgorithm>,
    pub rejected: Vec<PkAlgorithm>,
    pub min_rsa_bits: u32,
    pub prefer_curve: EllipticCurve,
}
```

### 9.2 配置来源（优先级由低到高）

1. **内置默认值**：符合 RFC 9580 / RFC 8551 / 国密标准。
2. **全局配置文件**：`settings.crypto.policy`（JSON 子集）。
3. **每账户覆盖**：`account.crypto.policy_overrides`。
4. **每次操作显式参数**：Builder `with_hash_alg(...)`，但必须在 Policy 允许范围内。

### 9.3 算法协商

- **OpenPGP**：使用 key 的 `PreferredSymmetricAlgorithms` / `PreferredHashAlgorithms` 子包与 Policy 取交集。
- **S/MIME**：解析收件人证书的 `SMIMECapabilities` 扩展，选择共同支持的最强算法。
- **国密 S/MIME**：直接按国密 profile 固定 SM2/SM3/SM4，不与国际算法协商。

---

## 10. 密钥管理与存储

### 10.1 密钥层级

```text
Layer 0: OS Keyring — Master Secret (256-bit，已存在)
Layer 1: Account Master Key — HKDF(master_secret, account_id)
Layer 2: Crypto Identity Key — S/MIME cert、PGP key、SM2 key
Layer 3: Message Session Key — 每封邮件随机生成
```

### 10.2 数据表扩展

```sql
-- 统一密钥/证书表
CREATE TABLE crypto_keys (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    backend TEXT NOT NULL CHECK(backend IN ('openpgp','smime','sm')),
    key_type TEXT NOT NULL CHECK(key_type IN ('public','private','cert')),
    email TEXT,
    fingerprint TEXT NOT NULL,
    public_data BLOB NOT NULL,          -- armored PGP / DER cert / SM2 cert
    private_data_enc BLOB,              -- AES-GCM 加密私钥（软密钥）
    token_serial TEXT,                  -- 若私钥在 token 上
    token_key_id TEXT,                  -- token 内 ObjectHandle 标识
    origin TEXT NOT NULL,               -- generated/imported/wkd/keyserver/autocrypt/contact
    is_default_sign INTEGER DEFAULT 0,
    is_default_encrypt INTEGER DEFAULT 0,
    created_at TEXT NOT NULL,
    expires_at TEXT,
    policy_json TEXT                    -- 该 key 声明的算法偏好
);

CREATE TABLE trust_decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT NOT NULL,
    peer_email TEXT NOT NULL,
    backend TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    decision TEXT NOT NULL CHECK(decision IN ('undecided','unverified','verified','trusted','rejected')),
    evidence_json TEXT,
    decided_at TEXT NOT NULL
);

ALTER TABLE accounts ADD COLUMN crypto_method TEXT DEFAULT 'none';
ALTER TABLE accounts ADD COLUMN crypto_policy_json TEXT;
ALTER TABLE contacts ADD COLUMN pinned_keys_json TEXT; -- [{backend, fingerprint, armored}]
```

### 10.3 私钥保护

- 软私钥：明文 → `crypto::encrypt_secret` → hex(nonce‖ct) → `private_data_enc`。
- Token 私钥：`private_data_enc` 为空，`token_serial` + `token_key_id` 指向 token。
- 内存：用 `secrecy::SecretVec` / `SecretString`；drop 时 `zeroize`。

---

## 11. MIME 集成与数据流

### 11.1 发送路径

```text
Composer 设置 isSigned / isEncrypted / cryptoMethod
    ↓
buildRawEmail() → 原始 MIME 文件
    ↓
crypto_sign(input, signed_output, account_id, detached=true)
    ↓ (若启用加密)
crypto_encrypt(signed_output, encrypted_output, recipients, account_id)
    ↓
base64url encode → sync_apply_mutation { type: "send" }
    ↓
SMTP / EAS
```

### 11.2 接收路径

```text
IMAP 拉取原始 MIME
    ↓
detect_crypto_type(content_type)
    ↓
crypto_decrypt(input, decrypted, account_id)  [若加密]
    ↓
crypto_verify(decrypted, detached?, account_id) [若签名]
    ↓
DOMPurify → sandboxed iframe 渲染
    ↓
LockIcon + 签名状态
```

### 11.3 检测规则

| Content-Type | 处理 |
|---|---|
| `application/pkcs7-mime; smime-type=enveloped-data` | S/MIME 加密 |
| `application/pkcs7-mime; smime-type=signed-data` | S/MIME opaque 签名 |
| `multipart/signed; protocol="application/pkcs7-signature"` | S/MIME detached 签名 |
| `multipart/encrypted; protocol="application/pgp-encrypted"` | PGP/MIME 加密 |
| `multipart/signed; protocol="application/pgp-signature"` | PGP/MIME 签名 |
| inline PGP blocks | PGP inline（兼容只读） |

---

## 12. 前端集成

### 12.1 新增服务

```typescript
// kylins.client.frontend/src/services/crypto/mailCrypto.ts
export async function signEmail(accountId: string, inputPath: string, outputPath: string, detached: boolean): Promise<void>;
export async function encryptEmail(accountId: string, inputPath: string, outputPath: string, recipients: string[]): Promise<void>;
export async function decryptEmail(accountId: string, inputPath: string, outputPath: string): Promise<DecryptResult>;
export async function verifyEmail(accountId: string, signedPath: string, detachedDataPath?: string): Promise<VerificationResult>;
```

### 12.2 新增 UI 组件

- `CryptoPreferences`：全局/每账户加密方法、策略配置。
- `CertManager` / `KeyManager`：证书/密钥导入、导出、默认选择。
- `LockIcon`：邮件列表与阅读窗格加密状态。
- `TrustDialog`：首次收到签名邮件时的信任决策。
- `ComposerCryptoSelector`：发送前选择签名/加密方式。

### 12.3 Settings keys

```typescript
crypto_method: 'crypto.method',                    // 'none' | 'smime' | 'openpgp' | 'sm'
crypto_policy: 'crypto.policy',                    // JSON
crypto_smime_pkcs11_lib: 'crypto.smime.pkcs11_lib',
crypto_smime_default_sign_cert: 'crypto.smime.default_sign_cert',
crypto_smime_default_encrypt_cert: 'crypto.smime.default_encrypt_cert',
crypto_openpgp_keyring: 'crypto.openpgp.keyring',
```

---

## 13. 依赖选型

### 13.1 必须新增

| crate | 用途 | 阶段 |
|---|---|---|
| `pgp` (rpgp) | OpenPGP 引擎 | Phase 2 |
| `sequoia-openpgp` | OpenPGP 可选引擎 | Phase 2（feature gated） |
| `cms` | CMS/PKCS#7 构建解析 | Phase 1 |
| `x509-cert` | X.509 证书 | Phase 1 |
| `x509-parser` | X.509 解析 | Phase 1 |
| `rsa` | 软件 RSA | Phase 1 |
| `p256`/`p384`/`p521` | 软件 ECDSA/ECDH | Phase 1 |
| `sha2`/`sha3` | 哈希 | Phase 1 |
| `aes`/`aes-gcm`/`cbc` | 对称加密 | Phase 1 |
| `cryptoki` | PKCS#11 | Phase 1 |
| `secrecy` | 秘密零化 | Phase 1 |
| `zeroize` | 敏感内存清零 | Phase 1 |
| `subtle` | 常量时间比较 | Phase 1 |
| `libsm` | 国密原语 | Phase 3 |
| `gmssl-rs` | 国密 FFI（备选） | Phase 3 |
| `openpgp-card-rpgp` | OpenPGP 智能卡 | Phase 3-4 |
| `openpgp-pkcs11-sequoia` | PKCS#11 OpenPGP bridge | Phase 4 |

### 13.2 与现有依赖关系

- `mail-builder` / `mail-parser`：已存在，继续用于 MIME 构建与解析。
- `sqlx`：已存在，用于证书/密钥表。
- `keyring`：已存在，用于 master secret。
- `reqwest`：已存在，用于 WKD/keyserver/OCSP。

---

## 14. 实施路线图

### Phase 1 — S/MIME 基础（高优先级）

1. `crypto/` 模块骨架 + `CryptoProvider` trait + `CryptoPolicy`。
2. `crypto/smime/`：CMS SignedData / EnvelopedData 构建解析。
3. `crypto/smime/cert_store.rs`：X.509 导入、存储、按 email 查找。
4. `crypto/smime/pkcs11.rs`：rust-cryptoki token 封装，原始 RSA sign/decrypt。
5. `crypto/mime.rs`：S/MIME MIME 包装。
6. `db/certs.rs` + `db/trust_decisions.rs` + migration。
7. `commands/crypto_commands.rs`：sign / encrypt / decrypt / verify。
8. Frontend `services/crypto/mailCrypto.ts` + SecurityPreferences UI。
9. 发送/接收管线 hook。

### Phase 2 — OpenPGP

1. 集成 `pgp`（rpgp）并定义 `OpenPgpProvider`。
2. `crypto/openpgp/key_store.rs`：keyring / WKD / keyserver。
3. `crypto/openpgp/trust.rs`：pinning / TOFU。
4. RFC 3156 PGP/MIME 包装。
5. Composer/ReadingPane 状态显示。

### Phase 3 — 国密 SM2/SM3/SM4

1. 评估 `libsm` CMS 国密扩展；如不足则引入 `gmssl-rs`。
2. 实现 `SmProvider`。
3. SM2 证书管理、SM4-CBC/GCM 内容加密。
4. OpenPGP 国密算法扩展（跟随最新 draft）。

### Phase 4 — 高级与合规

1. `openpgp-card-rpgp` 智能卡支持。
2. OCSP/CRL 完整验证。
3. RFC 9980 后量子算法（ML-KEM / ML-DSA）实验支持。
4. 企业 CA / LDAP / GAL 集成。
5. 加密邮件搜索（本地索引解密后缓存）。

---

## 15. 风险与最佳实践

### 15.1 主要风险

| 风险 | 缓解 |
|---|---|
| `gmssl-rs` 成熟度不足 | feature gated 引入；保留 `libsm`  fallback；不默认启用 |
| OpenPGP 国密算法 ID 未标准化 | 跟随最新 IETF draft；提供配置开关 |
| PKCS#11 token 驱动差异大 | 机制探测 + 清晰错误日志 + 用户可配置库路径 |
| 长耗时 crypto 阻塞 UI | 所有 crypto command 走 `async` + tokio blocking pool |
| 弱算法被误接受 | `CryptoPolicy` 默认拒绝 MD5/SHA1/3DES/DSA/Elgamal；策略版本化 |
| 私钥在 IPC 中泄露 | 私钥永不序列化到 `invoke` payload；只传文件路径 |
| 用户误信自签名证书 | 显式 trust dialog；默认 untrusted |

### 15.2 最佳实践清单

- [ ] 所有 crypto 操作 `async`，默认在 `tokio::task::spawn_blocking` 执行。
- [ ] 敏感缓冲区使用 `secrecy::SecretVec` / `SecretString` + `zeroize`。
- [ ] 常量时间比较 MAC、指纹（`subtle`）。
- [ ] 临时文件写入系统 temp dir，完成后立即删除。
- [ ] 200MB 附件流式处理，内存峰值 < 100MB。
- [ ] 信任决策表仅追加，完整审计历史。
- [ ] 解密后的 HTML 仍走 DOMPurify + sandboxed iframe。
- [ ] key discovery 必须显式用户同意，不自动加密。
- [ ] 单元测试 + mock token + 真实 token feature gate。

---

## 16. 参考来源

### 本地源码

- Thunderbird OpenPGP：`D:\Projects\mailclient\opensource\thunderbird-desktop\mail\extensions\openpgp\`
- Thunderbird S/MIME：`D:\Projects\mailclient\opensource\thunderbird-desktop\mailnews\extensions\smime\`
- proton-crypto-rs：`D:\Projects\mailclient\opensource\Proton\proton-crypto-rs\`
- rust-cryptoki：`D:\Projects\mailclient\opensource\pkcs11\rust-cryptoki\`

### Web / 标准

- RFC 9580 OpenPGP: https://datatracker.ietf.org/doc/rfc9580/
- RFC 9980 Post-Quantum Cryptography in OpenPGP: https://datatracker.ietf.org/doc/rfc9980/
- RFC 8551 S/MIME 4.0: https://datatracker.ietf.org/doc/rfc8551/
- RFC 5652 CMS: https://datatracker.ietf.org/doc/rfc5652/
- RFC 3156 PGP/MIME: https://datatracker.ietf.org/doc/rfc3156/
- draft-ribose-openpgp-sca (SM2/SM3/SM4 OpenPGP): https://datatracker.ietf.org/doc/html/draft-ribose-openpgp-sca/
- draft-liu-sm-for-openpgp-01: https://datatracker.ietf.org/doc/html/draft-liu-sm-for-openpgp-01/
- RNP: https://github.com/rnpgp/rnp
- rpgp: https://github.com/rpgp/rpgp
- Sequoia-PGP: https://sequoia-pgp.org/
- rust-cryptoki: https://github.com/parallaxsecond/rust-cryptoki
- RustCrypto CMS: https://docs.rs/cms/latest/cms/
- gmssl-rs: https://crates.io/crates/gmssl-rs
- libsm: https://crates.io/crates/libsm
- openpgp-card-rpgp: https://codeberg.org/openpgp-card/rpgp
- openpgp-pkcs11-sequoia: https://codeberg.org/heiko/openpgp-pkcs11

### Kylins 现有文档

- `docs/superpowers/specs/2026-06-29-crypto-system-design.md`
- `docs/superpowers/specs/2026-06-29-kylins-crypto-architecture-review.md`
- `docs/openpgp-research-report.md`
- `docs/proton-crypto-rs-learning-report.md`
- `docs/thunderbird-smime-learning-report.md`

---

*文档由 `/deep-research` + 本地源码学习共同生成，整合了 Thunderbird、proton-crypto-rs、rust-cryptoki 的架构经验与 RFC 9580/8551/9980 的当前算法基线。*
