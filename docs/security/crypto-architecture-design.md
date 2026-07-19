# Kylins Client 加密架构设计（OpenPGP / S/MIME / 国密 SM2/SM3/SM4）

> 基于 Thunderbird、proton-crypto-rs、rust-cryptoki 本地源码学习与 Web 深度研究的综合架构设计。  
> 版本：v1.0（2026-07-09）  
> 前置文档：`docs/superpowers/specs/2026-06-29-crypto-system-design.md`、`docs/superpowers/specs/2026-06-29-kylins-crypto-architecture-review.md`、`docs/security/openpgp-crypto-ecosystem-analysis-report.md`、`docs/security/proton-crypto-rs-source-learning-report.md`、`docs/security/thunderbird-crypto-implementation-analysis-report.md`、`docs/security/proton-clients-security-analysis-report.md`、`docs/security/proton-webclients-security-analysis-report.md`

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
| 部署形态 | A 形态（Kylins 客户端 + 第三方标准服务器）；邮件 E2EE；联系人/日历/任务**暂缓加密**（§11.6） |

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
Layer 2.5: Object Key — 每联系人/日历一把（ContactKey/CalendarKey；邮件可复用 body session key 作为 object key），私钥被 Layer 2 identity key 加密；其下包裹各 part/card session key（见 §11.5）
Layer 3: Part Session Key — 每个 part（body + 每个 attachment）独立随机生成；密文与接收方无关，仅 key wrapping 按接收方（见 §11.4）。**part 数由 `EncryptionGranularity` 决定**：WholeMessage→1；BodyInlineAndPerAttachment→1(body+inline)+N(附件)；BodyInlineAndMergedAttachments→1(body+inline)+1(merged)（见 §11.4.1）
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
ALTER TABLE accounts ADD COLUMN crypto_granularity TEXT DEFAULT 'whole_message'; -- whole_message | body_inline_per_attachment | body_inline_merged_attachments（见 §11.4.1）
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

**粒度解析（发送侧）。** `apply_crypto` 之前新增 composition 步骤：从 `account.crypto_granularity` 读取粒度，把 `SendDraft{htmlBody, textBody, inlineImages[], attachments[]}` 组装为 `Vec<Part>`——inline images **始终折进 body unit**（`multipart/related{HTML + inline image parts}`）；粒度 `BodyInlineAndPerAttachment` 下常规附件各自一 part；粒度 `BodyInlineAndMergedAttachments` 下常规附件打包成单个 `multipart/mixed` 实体作为一 part；`WholeMessage` 下整棵 MIME 一 part。随后按 `SerializationStrategy` 喂后端（见 §11.4.1）。`SendDraft` 本身不变，粒度不进 IPC payload。

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

**粒度解析（接收侧）。** `SingleMimeBlob` 路径（S/MIME / PGP-MIME 互操作）不变：解一个 blob → `parse_plaintext_mime` 抽取 body+附件；`extract_attachments` 已能遍历 `multipart/mixed` 子树，故粒度 B 的合并单元**天然可解、零改动**。`SplitPerPart` 路径（未来 E2EE-内部）：先解 body unit 懒渲染（inline images 随 body 一并就绪），附件按需独立解密——per-part 懒加载（§11.4 能力 1）。

### 11.3 检测规则

| Content-Type | 处理 |
|---|---|
| `application/pkcs7-mime; smime-type=enveloped-data` | S/MIME 加密 |
| `application/pkcs7-mime; smime-type=signed-data` | S/MIME opaque 签名 |
| `multipart/signed; protocol="application/pkcs7-signature"` | S/MIME detached 签名 |
| `multipart/encrypted; protocol="application/pgp-encrypted"` | PGP/MIME 加密 |
| `multipart/signed; protocol="application/pgp-signature"` | PGP/MIME 签名 |
| inline PGP blocks | PGP inline（兼容只读） |

### 11.4 分片加密：让"加密粒度"对齐"存储/传输粒度"（借鉴 Proton split packages）

**核心原则。** 一封邮件在 API/存储层是"一个 body + N 个独立 attachment 资源"，加密层应当一对一映射成"一个 body part + N 个 attachment part"，而不是把整棵 MIME 树揉成一个密文 blob。密文结构与存储/传输结构同构，是后续所有能力的前提。Proton 的实现正是如此：body 走 `crypto-inbox/src/message/*`，附件走 `crypto-inbox/src/attachment/*`，由 `mail-package-builder/src/packages.rs` 编排成 `Package{ body, addresses{ body_key_packet, attachment_key_packets } }`，几乎就是 `POST /mail/v4/messages` 的线格式。

**模型：每 part 一把 session key，密文与接收方无关。**

```text
Message = { body: Part, attachments: Part[] }

每个 Part:
  plaintext ──(随机 session key SK_i, AES-256-GCM)──▶ ciphertext_i   (接收方无关，上传一次)
  SK_i      ──(按接收方公钥/口令包装)─────────────▶ key_packet_i,r   (每接收方一份，几十字节)

发送/转发：只重包 SK_i → key_packet_i,r'，ciphertext_i 原样复用，绝不对密文解密再重加密。
草稿→发送：从草稿密文中 extract SK_i，重包给正式接收方即可。
```

对应到 Proton 代码：body 在 `message/packages.rs` 每次 `package_body_encrypt` 生成新 session key；附件在 `attachment/encrypt.rs:119-132` 单独 `generate_session_key()` 并自包 `key_packets`；`process_attachments`（`packages.rs:436-498`）按接收方只调 `encrypt_session_key_to_recipient`，附件 `data` 字节对每个接收方原样复用。

**这样设计换来的能力（Kylins 应继承）：**

1. **按 part 懒加载、按需解密。** 先拉 body 立刻渲染，附件按需下载/解密；不必为了看正文而下载 30MB 附件。解密路径必须因此解耦（body decryptor 与 attachment decryptor 独立）。
2. **多接收方/转发零密文重传。** 同一 part 的 ciphertext 对所有接收方复用，差异只在 key packet；转发单个附件给新接收方只需重包那一把 `SK_i`。
3. **大附件流式 + 按 part 施策。** 附件走 streaming（`encrypt_and_sign_to_writer` / `decrypt_from_reader`），分块、有进度、内存恒定；压缩/编码策略按 part 区分（body 文本可压、已压缩的媒体附件绝不压——压缩既浪费又泄漏尺寸）。§15.2 的"200MB 附件流式"依赖此解耦。
4. **隔离爆破半径（compartmentalization）。** 把某附件转发给明文接收方时须向服务器暴露该 part 的 session key；因为 body 是另一把 key，**暴露附件 key 不连带暴露 body 或其它附件**。若整封邮件一把 key，"让某明文接收方能看附件"会同时失守整封邮件。
5. **签名按 part 独立。** 每个附件自带 detached signature（及一份加密副本），被转发/引用时真实性可单独验证，不与 body 签名耦合；`LockIcon`/verification 按 part 聚合。
6. **服务端可在不碰正文的前提下处理附件**（扫描、配额、过期、CDN 分发），E2EE 接收方下服务器仍学不到任何 session key。

**对 Kylins 抽象的约束。** `CryptoProvider` 不应有"分片"与"单 blob"两套互不相干的加密逻辑；应统一以 **part 集合** 为输入，再按接收方能力选择**序列化策略**：

```rust
// crypto/types.rs（示意）
pub enum PartKind { Body, Attachment { filename: String, mime: String, content_id: Option<String> } }
pub struct Part { pub id: PartId, pub kind: PartKind, pub source: DataSource } // DataSource: bytes | stream
pub struct EncryptedPart {
    pub id: PartId,
    pub ciphertext: DataSink,                 // 接收方无关
    pub session_key: SessionKeyHandle,        // 仅用于按接收方重包
    pub signature: Option<DetachedSignature>, // 按 part 独立
}
pub enum SerializationStrategy {
    SplitPerPart,   // Proton 式：每 part 独立密文 + 每接收方 key wrap（E2EE 默认）
    SingleMimeBlob, // RFC 3156 PGP/MIME 或 S/MIME EnvelopedData：整棵 MIME 一把 key（互操作）
}

pub trait CryptoProvider { /* ... */
    fn encrypt_parts(&self, parts: &[Part], strategy: SerializationStrategy,
                     recipients: &[Recipient]) -> Result<EncryptedMessage, CryptoError>;
    fn decrypt_part(&self, part: &EncryptedPart, key: &Self::PrivateKey) -> Result<Part, CryptoError>;
}
```

- **策略选择**复刻 Proton 在 `build_packages` 里按 `pgp_scheme` 分发的做法（`packages.rs:316-377`）：E2EE 给支持分片的对端用 `SplitPerPart`；外部 OpenPGP 客户端（Thunderbird/RNP、GnuPG）只认标准 PGP/MIME 单 blob，回落到 `SingleMimeBlob`；同一份草稿期各自加密的 part，出包时按策略走两条路。
- **S/MIME 是天然单 blob**：CMS `EnvelopedData` 包裹整棵 MIME 树，part 集合退化为单 part。故"分片"作用于 **OpenPGP/E2EE 路径**；S/MIME 路径 part 数恒为 1，但走同一套 `encrypt_parts` 接口，不另开代码路径。
- **存储/数据库**：`crypto_keys`（§10.2）存身份密钥；邮件密文与 key wrap 不落本地明文。附件密文可作为独立对象缓存/分发，与正文解耦生命周期。
- **影响范围**：§3.1 `crypto/mime/` 输出从"单 blob"改为"part 集合"；§4 `Encryptor`/`Decryptor` 增加 part 维度与流式 `DataSource`；§10.1 密钥层级 Layer 3 由"每封邮件一把 session key"改为"每 part 一把"；§14 Phase 2 OpenPGP 需包含分片序列化与 PGP/MIME 单 blob 回落两条出包路径。

#### 11.4.1 加密粒度（EncryptionGranularity）：自定义分片粒度，对上层屏蔽后端差异

**需求。** 除"标准方式"（整封邮件一把 key、一个密文 blob）外，所有加密方式（S/MIME、OpenPGP、国密）须**内在支持**两类中间粒度，且对上层屏蔽复杂性与差异：

- **粒度 A — `BodyInlineAndPerAttachment`**：body part（body + inline images）折为**一个**加密单元；每个常规附件各自一个加密单元（1+N 个单元）。
- **粒度 B — `BodyInlineAndMergedAttachments`**：body part（body + inline images）折为一个加密单元；所有常规附件**合并为单个 `multipart/mixed` 实体**作为一个加密单元（2 个单元）。

**与 `SerializationStrategy` 正交。** 粒度管"part 如何分组为加密单元（session-key 粒度）"，序列化管"单元如何在 wire 上排布"。二者组合由后端按映射表实现，上层只设粒度。

```rust
// crypto/types.rs（设计示意，代码尚未落地；现有 Part/PartKind/SerializationStrategy 见 core/envelope.rs）
pub enum EncryptionGranularity {
    /// 标准：整棵 MIME 树作为一个加密单元（一把 session key）。对应现状 apply_crypto 单 Body part + SingleMimeBlob。
    WholeMessage,
    /// 粒度 A：body+inline images 折为一个加密单元；每个常规附件各自一个加密单元。
    BodyInlineAndPerAttachment,
    /// 粒度 B：body+inline images 折为一个加密单元；所有常规附件合并为单个 multipart/mixed 实体作为一个加密单元。
    BodyInlineAndMergedAttachments,
}

fn encrypt_parts(&self, parts: &[Part],
                 granularity: EncryptionGranularity,
                 serialization: SerializationStrategy,
                 recipients: &[Recipient])
    -> Result<EncryptedEnvelope, CryptoError>;
```

**Part 模型语义澄清。**

- `PartKind::Body` 的 `data` 语义 = "**body 单元**"：存在 inline images 时为 `multipart/related{HTML + inline image parts}`，无 inline 时为纯 body。Inline images 在 **composition 层**折进 body unit，**不**作为独立 crypto part。
- `PartKind::Attachment{content_id: None}` = 常规附件（无 `cid:`）。
- 粒度 B 的合并单元：composition 层把所有常规附件打包成**单个 `multipart/mixed` 实体**，作为**一个** `Part`（新 variant `PartKind::MergedAttachments` 或 `Attachment` 带 `merged: true` 标记）。

**Inline images 归属：与 Proton 的有意分歧。** Proton（`clients/project/mail/rust/`）把 inline image 建模为 `AttachmentDisposition::Inline` + `Content-ID` 的 attachment（`mail-package-builder/src/types.rs:43-47`），且分两条路径：ProtonMail 路径下 inline image 是**独立密文 + 独立 session key**（与常规附件同走 `Attachment::encrypt`，`mail-common/src/actions/draft/attachment_upload.rs:408`）；PgpMime 路径下 inline + 常规附件**全部折进 body MIME blob、一把 body session key**（`mail-package-builder/src/packages.rs:197-250` + 注释 `:329-331`）。Kylins 的粒度 A 是 Proton 没有的**第三种**：body+inline 折成一个单元（inline 不独立），常规附件各自独立。**理由**：HTML 的 `cid:` 引用必须有 inline image 才能渲染，故 body 单元须自包含；常规附件是独立下载物，可独立加解密/转发。MIME 仍"先建后加密"（与 Proton `crypto-inbox-mime/src/write.rs:1-22` 一致），但 composition 层只把 inline 折进 body、常规附件保持独立（粒度 A）或合并为一个 `multipart/mixed`（粒度 B）。

**粒度 × 序列化 × 后端 映射矩阵。**

| 后端 / 路径 | 序列化（wire） | 粒度→wire 表现 | session key 数 | 上层可感知收益 |
|---|---|---|---|---|
| S/MIME（A 形态公网 SMTP） | **强制 `SingleMimeBlob`**（§11.6 硬规则1；`SmimeBackend::encrypt` 现 reject `SplitPerPart`，`smime/src/lib.rs:289-296`） | A/B/Whole 均坍缩为**一个 `EnvelopedData`**；粒度仅影响 plaintext 组成（B→body 实体内含一个 merged `multipart/mixed` 子树） | 1 | 仅 composition 层（B 的合并附件 UX）；**无 per-part 懒解密/per-part 转发** |
| OpenPGP PGP/MIME（A 形态公网 SMTP） | **强制 `SingleMimeBlob`**（RFC 3156） | 同上，整棵 MIME 一个加密 blob | 1 | 同 S/MIME |
| OpenPGP E2EE-内部 / 未来 Kylins↔Kylins | **`SplitPerPart`** | A→body+inline 一 part + 每常规附件一 part；B→body+inline 一 part + merged `multipart/mixed` 一 part | A: 1+N；B: 2 | per-part 懒解密、per-part 转发重包 key、爆破半径隔离（§11.4 能力 1/2/4） |

**A 形态公网下的收益边界（诚实声明）。** S/MIME 与 PGP/MIME 在公网 SMTP 上序列化恒为 `SingleMimeBlob`，CMS `EnvelopedData`/PGP-MIME 整 blob 只有**一把 content-encryption key**，故粒度 A/B 的"per-part session key"收益在公网 wire 上**不被接收方感知**——接收方仍拿到一个 blob。粒度在 A 形态下仅以两种形式体现：

1. **composition（当下可用）**：粒度 B 让明文 MIME 里附件以一个 merged `multipart/mixed` 子树存在（接收方解一个 blob 后看到一个合并附件，而非 N 个独立附件）——真实可互操作的 UX 差异，接收侧 `extract_attachments` 零改动。
2. **future-facing**：当 `SplitPerPart` 序列化落地（E2EE-内部 / B 形态自有后端），同一粒度枚举立即获得 per-part 懒解密/转发/隔离收益，**无需改上层 API**。

**选择器（仅账户/全局）。** `accounts.crypto_granularity` 列（§10.2）+ settings KV `crypto.granularity`（§12.3），账户级覆盖优先于全局。`SendDraft` **不带粒度字段**；`send_op`/`apply_crypto` 从 account 配置解析。A 形态默认 `whole_message`（互操作安全）。

**与密钥层级对齐。** §10.1 Layer 3 的 part 数由粒度决定：WholeMessage→1；A→1(body+inline)+N(附件)；B→1(body+inline)+1(merged)。

**影响范围（本节）。** §10.1 Layer 3 part 计数与粒度挂钩；§10.2 accounts 表加 `crypto_granularity` 列；§11.1/§11.2 收发路径加 composition/解析步骤；§11.6 硬规则1 补注粒度坍缩；§12.3 加 `crypto.granularity`；§14 Phase 2 标注映射双路径；§15.2 追加粒度 checklist。本文档为设计示意，**不引入代码改动**；现有 `core/envelope.rs` 的 `Part`/`PartKind`/`SerializationStrategy`/`EncryptedEnvelope` 保持不变，`EncryptionGranularity` 待后续 SDD 落地。

### 11.5 统一对象模型：把"分片 + 分级保护"推广到所有 item 类型

**核心原则（两条）。**

1. **每个业务对象 = 一组 part + 一把对象密钥。** message / contact / calendar event / push payload 都建模为 `Object { parts, object_key }`：每 part 独立 session key（密文与接收方无关，§11.4）；对象密钥（ContactKey / CalendarKey / MessageKey）包裹各 part 的 session key，其私钥再被身份（address）密钥加密。于是"按 part 解密、按接收方重包、按对象授权"在三种 item 上是同一套逻辑，而不是三套加密。
2. **按字段敏感度分级保护：服务器必须可读 ⇒ 仅签名；私密 ⇒ 签+加。** 不是"全加密"或"全明文"一刀切，而是逐字段选择 `Protection::{Cleartext, Signed, EncryptedAndSigned}`。这让服务器在不解密的前提下完成投递 / 提醒 / 读取收件人公钥，同时保证这些明文字段的完整性。

**各 item 的具体方法（Proton clients 实证）。**

| Item | 最小加密单元 | 分级（Protection） | 对象/会话密钥包装 | 源码锚点 |
|---|---|---|---|---|
| 邮件 body | body part | EncryptedAndSigned | 每收件方 key packet | `crypto-inbox/src/message/*` |
| 邮件附件 | attachment part | EncryptedAndSigned（detached sig） | 每收件方 key packet | `crypto-inbox/src/attachment/encrypt.rs:119-132` |
| 邮件主题 | 随 body part（每封一把，非每收件方） | EncryptedAndSigned（加密时） | 同 body session key | `crypto-inbox-mime/src/read.rs:151` |
| 联系人 | vCard "card" | Cleartext / Signed（EMAIL、KEY/`X-PM-*` 偏好）/ EncryptedAndSigned（私有字段） | 每联系人 ContactKey → address key | `contacts-common/contact_card.rs`（`ContactCardType`）、`crypto-contact-keys/vcard_crypto.rs:38`（空解密密钥 ⇒ Signed card） |
| 日历 | iCal part（shared / attendees / personal） | shared+personal：EncryptedAndSigned；attendees（ORGANIZER/ATTENDEE/调度）：Signed（服务器可投递邀请） | `ForCalendar`→CalendarKey（默认）；`ForAddress`→address key（Proton↔Proton 邀请） | `crypto-calendar/event_encryptor.rs:102-156`、`calendar-api/requests.rs:20`（`UpdateCalendarEventPersonalPart`） |
| 推送 | 整条 payload | Encrypted（设备密钥） | 设备密钥 | `crypto-notifications/src/lib.rs:1` |
| 密钥材料 | 每个私钥 | Encrypted（master key AES-256-GCM） | OS keyring master key | `crypto.rs`、`core-key-manager` |

**加密主题（encrypted subject）的具体方法。** 邮件加密时主题也加密、且与 body 同属"每封一把"粒度（不按收件方分）：

- 外层 RFC-822 `Subject:` 写占位符（Proton 用 `...` / `Encrypted Message`），真实主题放进加密 MIME 内层（PGP/MIME）或消息级加密字段（Proton package format），用 **body session key** 加密。
- 接收时在解密后的内层 MIME 读出：`crypto-inbox-mime/src/read.rs:131-160` 处理 `decrypted_body`，`:151` 取 `encrypted_subject`；`tests/message.rs:369` 断言解密后 `encrypted_subject == "test mime"`。
- 明文/对外发送时主题标准明文（与正文一致）。Proton Rust 端低层仍有 `TODO: Encrypted subject not yet implemented`（`read_js.rs:417/453`）；Kylins 实现时直接纳入，不留 TODO。
- 对 Kylins：PGP/MIME 与 S/MIME 都把主题写入加密 MIME 内层并将外层头置占位符；主题为机密内容，**绝不写入外层明文头**；列表/索引展示只用解密后的内存值。

**统一抽象（示意）。**

```rust
pub enum Protection {
    Cleartext,           // 元数据；不签不加密
    Signed,              // 明文 + 签名：服务器可读，完整性受保护（联系人 EMAIL/KEY、日历 attendees）
    EncryptedAndSigned,  // 私密字段：先签后加（邮件 body/附件/主题、联系人私有 card、日历 shared/personal part）
}

pub struct ObjectKey { /* 每联系人/日历一把；邮件可复用 body session key 作为 object key */ }
pub struct Part { id: PartId, kind: PartKind, source: DataSource, protection: Protection }

// 分级密封：Cleartext 原样；Signed 仅签名；EncryptedAndSigned 用 part session key 加密并签名，
// session key 再由 object_key 包装（object_key 私钥已被 identity key 加密，见 §10.1）。
fn seal_part(p: &impl CryptoProvider, part: &Part, object_key: &ObjectKey)
    -> Result<SealedPart, CryptoError>;
```

联系人 `ContactCardType::{Cleartext, Signed, EncryptedAndSigned}` 与日历 `ForCalendar/ForAddress` 都是这一模型的特例：前者是 `Protection` 的直接落地，后者是 object_key 包装目标的两种选择（日历共享密钥 vs 收件方地址密钥）。

**对 Kylins 的范围与影响。**

- MVP 只含邮件，但 `CryptoProvider` / `seal_part` 接口与 `Protection` 分级从第一天就按多 item 设计，避免未来加联系人/日历时再写一套加密。
- §10.1 增加 Object Key 层；§14 把联系人/日历 E2EE 列为远期阶段、复用本节模型；§15.2 增加"按字段分级保护"与"主题加密"两条清单。
- 本地缓存（SQLite）存密文 part / card / ICS，不做字段级 at-rest 再加密；at-rest 由 OS/磁盘与 §10 密钥层级负责。

### 11.6 部署形态与互通决策：采用 A 形态，暂缓联系人/日历/任务加密

**决策（当前版本）。** Kylins 采用 **A 形态：Kylins 客户端 + 第三方标准服务器**（Exchange / O365 / Gmail / Google Workspace / Coremail / 通用 IMAP-SMTP）。在此形态下：

- **邮件**：做端到端加密；出站序列化一律回落 `SingleMimeBlob`（PGP/MIME 或 S/MIME；CN 场景用国密 S/MIME）。`SplitPerPart` 仅保留给未来同生态（Kylins↔Kylins / Kylins 自有后端），**永不上公网 SMTP**。
- **联系人 / 日历 / 任务：暂缓 E2EE。** 当前版本以标准明文协议同步（CardDAV / CalDAV / iTIP / EAS / EWS + 传输层 TLS），保留服务器侧能力（freebusy、iTIP 投递、共享日历 ACL、服务器提醒、GAL/联系人搜索、recurrence 展开）。是否对这三类实施加密，**留待后续评估**（见下方"暂缓项"）。

**为什么 A 形态下不加密联系人/日历/任务。** CardDAV / CalDAV / iTIP / EAS 的前提是服务器能解析内容；整对象加密会让服务器退化为哑 blob 存储，丧失 freebusy、调度投递、共享 ACL、提醒、GAL、recurrence 等核心能力——付费服务器功能大半作废，而客户端代偿（本地调度 / 搜索 / 提醒 / 群组密钥）的工程量是邮件加密的数倍。在"无自有同步后端"的前提下得不偿失。

**A 形态下的邮件互通约束（必须遵守）。**

| 服务器 | 出站加密形态 | 原生解密 | 主题 | 风险 |
|---|---|---|---|---|
| Exchange / O365（EWS/Graph/SMTP/EAS） | **S/MIME** 优先；PGP/MIME 仅当对端有 GpgOL 等插件 | S/MIME 原生；PGP 需插件 | S/MIME 主题**明文** | OME/Purview 门户加密与 PGP/S/MIME 不互通；EAS SmartForward 可能改写 MIME |
| Gmail / Google Workspace（IMAP/SMTP/API） | PGP/MIME、S/MIME 都可传输；GWS 企业版托管 S/MIME | 网页版**不内联解密** | PGP/MIME 占位符 `'...'` | "机密模式"非真加密，UI 不得标为 E2EE |
| Coremail（IMAP/SMTP/EAS） | S/MIME（CN 用**国密** profile）；PGP/MIME 可走 MIME | 取决于客户端/网关 | S/MIME 主题明文 | 企业 AV/DLP 网关可能剥离/隔离 `application/pgp-encrypted` 或加密附件 |

硬规则：

1. 出站永远 `SingleMimeBlob`（§11.4）；按收件方能力选 PGP/MIME 或 S/MIME。**粒度 `EncryptionGranularity` 在公网 SMTP 上坍缩为单 blob**——接收方仍得一个 EnvelopedData/PGP-MIME blob（一把 content key），粒度 A/B 的 per-part session-key 收益在 wire 上不被接收方感知，仅 composition 差异（粒度 B 的 merged `multipart/mixed` 子树）对外可见；per-part 收益待 `SplitPerPart`/E2EE-内部落地（§11.4.1）。
2. **加密主题按形态 + 按域可配**：PGP/MIME 默认启用（外层占位符）；S/MIME 默认关闭（头部保护支持零散）；可对 gov/企业域强制关闭。
3. 加密邮件**不被服务器索引**——搜索只剩元数据；用本地加密搜索索引弥补（`encrypted-search`，§14 Phase 4）。
4. 网关/DLP 可能剥离加密附件——维护**每域降级策略**（可加密 / 仅签名 / 必须明文），发前探测或用户确认。

**暂缓项：联系人/日历/任务 E2EE（留待后续评估）。** 仅当未来引入 **B 形态——Kylins 自有零知识同步后端**（类 Proton：服务器为零知识 blob 仓 + 密钥目录 + 通知管道）时才启动。届时复用 §11.5 的 `Object{ parts, object_key, Protection }` 模型，需新增并评估：

- 对象密钥与**群组密钥**（共享日历/联系人/任务列表），含成员变动的密钥轮换与前向安全成本。
- 密钥目录（自有目录 或 WKD/Autocrypt）与多设备密钥共享。
- 客户端代偿能力：本地加密搜索索引、客户端调度 / freebusy / 提醒 / recurrence 展开。
- 逐项代价：日历最难（多方调度 + 时间触发），联系人次之（GAL/搜索），任务最简单（无调度）。

**评估触发条件：** 出现明确的"自有同步后端"路线图，或目标用户对联系人/日历机密性有强需求且可接受失去服务器侧能力。在此之前，联系人/日历/任务保持明文 + TLS。

**影响范围。** §1 增加"部署形态"目标行；§3 当前不引入联系人/日历加密后端；§10.1 Object Key 层作为未来能力保留（A 形态暂不实例化 ContactKey/CalendarKey/TaskKey）；§11.4 出站固定 `SingleMimeBlob`；§11.5 的 `Protection` 分级在 A 形态仅作用于邮件 part（联系人/日历的 Signed-only 分级待 B 形态启用）；§14 Phase 4 的"联系人/日历 E2EE"标注为暂缓，并新增"收件方能力发现与每域降级策略"；§15.2 增加 A 形态出站清单项；新增 §11.7（本地落盘形态）与 §11.8（本地加密搜索索引）。

---

### 11.7 本地落盘形态：分级落盘（graded at-rest），非整库加密、非全明文

**原则。** 客户端本地既不是"整库全加密"，也不是"全明文"，而是**分级落盘**：加密对象以**服务器密文形态原样缓存**（不解密不写盘），元数据明文以便查询/列表，秘密进系统钥匙串或经主密钥包裹，解密后的明文只驻留易失内存。Proton Rust clients 即如此：`mail_stash`/`UserDb` 是普通 rusqlite、全树无 `PRAGMA key`/SQLCipher（无整库加密）；邮件 body/附件、联系人加密卡、日历 shared part 以服务器密文落盘，解密是独立的 read 路径（`crypto-inbox-mime` 产出内存 `ProcessedMimeResult`，`mail-uniffi` 暴露解密 DTO）；用户密钥/设备密钥/session 进 OS keychain（`mail_core_common::os::KeyChain`）。

| 数据类别 | 本地落盘形态 | Kylins 处理 |
|---|---|---|
| 邮件 body / 每个附件 / 联系人加密卡 / 日历 shared part | **服务器密文原样**（PGP/MIME 密文或 S/MIME CMS  blob） | 缓存密文；解密在 Rust 侧即时进行，明文**不回写** SQLite |
| 加密邮件主题 | 密文随 body；外层 `Subject:` 为占位符（`'...'`） | `messages.subject` 存服务器值（占位符）；真主题仅内存值 + 进加密索引，**绝不反向写回行**（见下） |
| 元数据（ID、label/文件夹、已读/旗标、时间、收发件人）、明文/签名联系人卡、日历 attendee/signed part | **明文 SQLite** | 列表/排序/过滤所必需；不涉密字段可明文 |
| 用户密钥口令、OAuth/IMAP 口令、设备密钥、session | **不进 SQLite**；经 `crypto.ts → Rust encrypt_secret`（keyring 主密钥 + AES-256-GCM） | 红线：plaintext 永不入 SQLite（与 CLAUDE.md 一致） |
| 本地搜索索引 | **逐条 AES-GCM 加密**，索引密钥经主密钥包裹（见 §11.8） | 可选、可驱逐、可自毁 |
| 整库（`mailclient.db`） | **不加密**（无 SQLCipher） | 与 Proton 一致；机密性靠"逐条信封 + keyring"，不靠整库加密 |

**主题专题（明确结论）。** 本地邮件行只持有一列 `subject`（对应 Proton `messages` 表的 `#[DbField] subject: String`），其值为**服务器提供的主题**——加密邮件即占位符 `'...'`。真实主题在解密时进入内存对象（Proton `DecryptedMessage.pgp_subject`，经独立访问器 `get_pgp_subject()` 暴露，刻意与列表 `subject` 列分离），要么即时显示、要么喂给 §11.8 的加密索引；**不存在把解密主题回写 `messages` 行的代码路径**。Kylins 沿用：列表与排序只用服务器主题/占位符，真主题永不落明文行。

**硬规则。**

1. 机密（口令/token/私钥口令/索引密钥）一律 `encrypt_secret` 包裹，禁明文落 SQLite。
2. 邮件/附件密文可缓存；解密产物（正文 HTML、解密主题、附件明文）只驻内存，进程退出/锁屏即清。
3. 元数据可明文，但加密邮件的**明文主题**、**正文摘录**不得进入明文列表/缓存/日志。
4. 需要本地全文检索时，正文/主题只能进 §11.8 的加密索引，不得另建明文索引或 FTS 明文表。

---

### 11.8 本地加密搜索索引（encrypted-search）：客户端扫描，非可搜索加密

**定位。** 加密邮件不能被服务器索引（§11.6 硬规则 3），搜索只剩元数据；为恢复全文检索，引入**本地加密搜索索引**。先澄清一个根本事实：这不是密码学意义的"可搜索加密（SSE）"——服务器始终零知识、无法在密文上检索；本质是**把密文缓存到本地 → 查询时在客户端解密扫描 → 关键词匹配**，即"加密的本地缓存 + 客户端扫描"。这决定全部取舍：搜索是 O(N) 扫描、不能靠服务器加速、索引只放本地、且必须可自毁。Proton WebClients 的 `packages/encrypted-search` 即此模型（库 `ES:<userID>:DB`，逐条 AES-GCM，扫描式查询）。

**密钥层级（Kylins 强化版）。** Proton 在 Web 端用 `CryptoProxy.encryptMessage` 把索引密钥 K 包裹到会话内 userKey 再存 `config.indexKey`（浏览器拿不到 OS keystore）。Kylins 有 OS keyring，更强：

```
OS keyring 主密钥（已有：keyring service=mailclient user=master-key）
        │  AES-256-GCM（现有 encrypt_secret）
        ▼
  已包裹的索引密钥 K  ← 落 settings / es_config（nonce||ciphertext hex）
        │  解锁时 decrypt_secret → K（仅内存）
        ▼
  IndexKey K（AES-GCM-128/256，进程内）
        │  per-item 随机 IV
        ▼
  es_metadata / es_content（nonce||ciphertext hex）
```

- 新增 Rust 命令：`es_init`（生成 K 并 `encrypt_secret` 包裹落盘）、`es_seal_item` / `es_open_item`（逐条 AES-GCM）、`es_nuke`（删索引 + 擦 K）、`es_rekey`（主密钥轮换时重包 K）。
- **K 永不明文落 SQLite**；登出/锁屏清内存 K；改密/主密钥轮换 → 索引不可解 → 重建（自毁性质，与 Proton 一致）。
- 前端只驱动编排，明文不跨边界进 SQLite（沿用 CLAUDE.md 红线）。

**存储结构（复用 SQLite）。** 可复用 `mailclient.db` 或独立 `es.db`，新增表（批量写走 `withTransaction()`，注意串行化避免锁泄漏）：

| 表 | 键 | 值 | 说明 |
|---|---|---|---|
| `es_config` | 常量键 | `wrapped_index_key` / `size` / `enabled` / `limited` / `content_version` | 全局状态 + 已包裹 K |
| `es_metadata` | message_local_id | `timepoint`, `nonce||ciphertext` | 列表/过滤用元数据，先建、尽量常驻 |
| `es_content` | message_local_id | `nonce||ciphertext` | 正文/解密主题等可搜索内容，可驱逐 |
| `es_events` | — | 同步游标 | 增量续传 |
| `es_progress` | — | 时间戳 / recovery point | 断点续建 |

`timepoint = [ts, seq]` 同时承担全局排序、驱逐顺序与续建游标。

**两阶段建索引。** ① **metadata 先**：同步后后台任务分批取元数据 → `es_seal_item` → 写 `es_metadata`，记录 progress/recovery point，全程可中止；metadata 足以支撑列表与廉价过滤（标签/时间/收发件人）。② **content 后**：按 timepoint 取有序 ID → 有界并发地"取服务器密文 → 用 message key 解 body → 用 K 重新封进 `es_content`"；被删/不可达（NOT_FOUND）跳过；**content 可驱逐**——达配额时按 timepoint 删最老腾空间，装不下整库则置 `limited`，空间释放后再续建。增量由 `es_events` 游标续传。

**查询路径（扫描而非索引）。** 规范化输入（去空白/去变音/统一引号撇号/lowercase/按空格与引号分词）→ 先用 `es_metadata` 做廉价过滤（`applyFilters`）→ 对候选 `es_open_item` 解密内容 → 多关键词 AND 匹配（所有关键词须在某字段出现）→ 流式增量返回 + timepoint 游标 + 结果上限。因无倒排索引，只做 substring/AND，不做相关度排序/前缀/模糊；metadata 过滤越狠，需解密内容越少。

**隐私泄漏面（必须承认）。** 对**服务端**零知识成立（查询全本地、不发服务器）；对**本机磁盘取证**只保护内容机密性，不保护轮廓——`es_metadata` 暴露邮件数量/ID/时间分布，AES-GCM **不隐藏长度**（密文长≈明文长），`es_content` 存在性暴露"哪些被缓存"。这是 graded at-rest 的固有边界，非缺陷；高敏部署可整库加密或关闭索引。

**A 形态映射与范围。** 仅索引**我们已能解密的邮件密文**（A 形态出站虽为 `SingleMimeBlob`，本地持有的仍是可解密的收件副本/发件留存）；主题用解密内存值进索引、不回写 `messages.subject`（§11.7）。范围**仅限邮件**；联系人/日历/任务按 §11.6 暂缓。删除/登出/改密触发 `es_nuke` 或重建。

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
crypto_granularity: 'crypto.granularity',          // 'whole_message' | 'body_inline_per_attachment' | 'body_inline_merged_attachments'（见 §11.4.1）
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
6. 实现"粒度×序列化"映射双路径：公网 PGP/MIME = `SingleMimeBlob`（粒度 A/B 坍缩为单 blob）；E2EE-内部 = `SplitPerPart`（粒度 A/B 完整表达，body+inline 一 part + per-attachment 或 merged 一 part）。S/MIME Phase 1 已是 `SingleMimeBlob`，粒度 B 的 merged `multipart/mixed` composition 可先行落地，不待 `SplitPerPart`。

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
6. 联系人/日历/任务 E2EE —— **暂缓，留待评估**：仅在 B 形态（自有零知识同步后端）启动；复用 §11.5 模型（详见 §11.6 暂缓项）。
7. 收件方能力发现（WKD/Autocrypt/SMIMECapabilities）与每域降级策略（可加密/仅签名/明文），支撑 A 形态邮件互通（§11.6）。

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
- [ ] OpenPGP/E2EE 路径按 part 加密：body 与每个 attachment 独立 session key，密文与接收方无关、仅 key wrapping 按接收方（见 §11.4）。
- [ ] 转发某 part 给明文接收方时只暴露该 part 的 session key，不连带暴露 body 或其它 part（分片隔离爆破半径）。
- [ ] 解密按 part 解耦：可只下载/解密单个附件，不强制整封邮件下载解密。
- [ ] 每个字段分级保护：服务器必须可读（联系人邮箱/固定公钥、日历 attendee）⇒ 仅签名（Signed）；私密字段 ⇒ 签+加（EncryptedAndSigned）；不"全加密/全明文"一刀切（见 §11.5）。
- [ ] 加密邮件的主题写入加密 MIME 内层/消息级加密字段，外层头置占位符；列表与索引只用解密后的内存值（见 §11.5）。
- [ ] A 形态出站一律 `SingleMimeBlob`（PGP/MIME 或 S/MIME）；`SplitPerPart` 不上公网 SMTP（见 §11.6）。
- [ ] `EncryptionGranularity` 与 `SerializationStrategy` 正交；上层只设粒度，后端按 (后端,粒度,序列化) 映射表实现，屏蔽 smime/pgp/sm 差异（见 §11.4.1）。
- [ ] Inline images 一律折进 body unit（`multipart/related`），不作为独立 crypto part；body 单元须自包含可渲染（与 Proton ProtonMail 路径有意分歧，见 §11.4.1）。
- [ ] 粒度 B 合并单元 = 单个 `multipart/mixed` 实体加密为一个 part；解密后由 `mail_parser` 走子树抽取还原各附件。
- [ ] A 形态公网 SMTP：粒度 A/B 不产生 per-part wire 收益（SingleMimeBlob 一把 key）；仅 composition 差异（B 的 merged 子树）对外可见；per-part 收益待 `SplitPerPart`/E2EE-内部落地。
- [ ] 粒度选择器仅账户/全局（`account.crypto_granularity` / `crypto.granularity`）；A 形态默认 `whole_message` 保证互操作；`SendDraft` 不带粒度字段。
- [ ] 加密主题按形态+按域开关：PGP/MIME 默认开、S/MIME 默认关；维护每域降级策略（可加密/仅签名/明文）（见 §11.6）。
- [ ] 联系人/日历/任务当前明文 + TLS 同步；本地缓存按 §11.6 规则处理（密文 part 存密文、元数据/索引明文或另行加密）。
- [ ] 本地落盘分级（§11.7）：密文对象存密文、元数据可明文、机密经 `encrypt_secret` 包裹、整库不加密；解密明文只驻内存，禁回写 SQLite。
- [ ] 加密邮件的明文主题/正文摘录不得进入明文列表、缓存、日志或明文 FTS；`messages.subject` 仅存服务器值（占位符），真主题永不反向写回行（§11.7）。
- [ ] 本地加密搜索索引（§11.8）：索引密钥 K 经 `encrypt_secret` 包裹、禁明文落盘；逐条随机 IV（AES-GCM）；禁建任何明文/确定性 token 倒排；content 可驱逐并设上限；登出/锁屏清 K、改密即索引失效重建。
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
- `docs/security/openpgp-crypto-ecosystem-analysis-report.md`（已合并原 `openpgp-research-report.md`）
- `docs/security/proton-crypto-rs-source-learning-report.md`（已合并原 `proton-crypto-rs-learning-report.md`）
- `docs/security/thunderbird-crypto-implementation-analysis-report.md`（已合并原 `thunderbird-smime-learning-report.md`）
- `docs/security/proton-clients-security-analysis-report.md`
- `docs/security/proton-webclients-security-analysis-report.md`

---

*文档由 `/deep-research` + 本地源码学习共同生成，整合了 Thunderbird、proton-crypto-rs、rust-cryptoki 的架构经验与 RFC 9580/8551/9980 的当前算法基线。*
