# OpenPGP / S/MIME / PKCS#11 加密生态分析与 Kylins 设计建议

> 报告日期：2026-07-10  
> 前置学习：`proton-crypto-rs`、`Sequoia`、`rPGP`、`rust-cryptoki`、`openpgp-card` 本地源码与 RFC 9580/8551/9980 研究  
> 目标读者：Kylins Client 架构与后端开发者

---

## 1. 执行摘要

本报告把近期关于 `proton-crypto-rs`、`Sequoia`、`rPGP`、`rust-cryptoki`、智能卡、恢复机制、跨平台原生依赖等讨论，汇总成一份面向 Kylins Client 的加密架构决策参考。

**核心结论：**

1. **不要直接把 `proton-crypto-rs` 作为依赖。** 它是 Proton 产品专用 SDK，包含 SRP、Proton 账户密钥层级、设备验证等 Kylins 不需要的抽象。
2. **值得借鉴的是它的架构模式：** provider trait、builder 模式、集中式 `CryptoPolicy`、feature-gated 后端、显式密钥生命周期。
3. **OpenPGP 引擎建议：**
   - **默认使用 `rpgp`（`pgp` crate）**：纯 Rust、MIT/Apache、RFC 9580、与 Proton 生产环境一致。
   - **Sequoia 作为可选后端**：功能更全、GnuPG 兼容性更好，但默认依赖 Nettle C 库；只有显式开启 `crypto-rust` 才是纯 Rust，且被 Sequoia 团队标记为实验性/非恒定时间。
4. **S/MIME 后端建议：** 使用 RustCrypto `cms` + `x509-cert`/`x509-parser` + `rust-cryptoki` 做 token 原始运算，避免绑定 NSS。
5. **硬件 token / 智能卡：**
   - OpenPGP 卡走 `openpgp-card-rpgp`（PC/SC）。
   - PKCS#11 HSM（SafeNet、YubiHSM 等）走 `rust-cryptoki`，token 只做原始 RSA/EC sign/decrypt，CMS/OpenPGP 结构在 Rust 中构建。
6. **跨平台影响：** 任何 C/C++ 依赖（Nettle、OpenSSL、Botan、aws-lc-rs、GmSSL）都会显著增加 Windows/macOS 的构建、打包、分发复杂度。纯 Rust 方案在 Tauri 桌面客户端里最省心。
7. **Kylins 现有基础很好：** 已经有 Rust 后端、OS keyring、AES-256-GCM 保险库、SQLite 账户存储。加密模块插入点是现有的 `mail/builder.rs` 和 sync/IMAP 接收路径。

---

## 2. 生态分析

### 2.1 `proton-crypto-rs`：产品 SDK，不是通用库

`proton-crypto-rs` 是一个 7 crate 工作区：

| Crate | 作用 | 是否适合 Kylins |
|---|---|---|
| `proton-crypto` | 核心 facade + `PGPProvider` trait + builder | 模式可借鉴，代码不能直接用 |
| `proton-crypto-account` | Proton 账户密钥、SKL、恢复、联系人卡 | 不适合 |
| `proton-rpgp` | 基于 `rpgp` 的纯 Rust OpenPGP 后端 | 可直接参考，但 Kylins 应直接用 `pgp` crate |
| `gopenpgp-sys` | Go/GopenPGP FFI 后端 | 不适合 |
| `proton-srp` | Proton SRP-6a + bcrypt 密码哈希 | 不适合 |
| `proton-crypto-subtle` | AES-GCM-256、HKDF-SHA256 | 模式可借鉴 |
| `proton-device-verification` | ECDLP/Argon2 工作量证明 | 不适合 |

**关键设计模式（可直接借鉴到 Kylins）：**

- `PGPProvider` / `PGPProviderSync` / `PGPProviderAsync` trait + 关联类型（`type PublicKey`、`type PrivateKey`）。
- `Encryptor` / `Decryptor` / `Signer` / `Verifier` / `KeyGenerator` builder。
- `Profile` / `CryptoPolicy` 集中管理允许/拒绝算法、DoS 限制。
- Cargo feature 切换后端：`gopgp` / `rustpgp` / `multi_be`。
- `CryptoError` 类型擦除：`Arc<dyn std::error::Error + Send + Sync>`。
- 强类型 ID 宏：`KeyId`、`KeySalt`、`ArmoredPrivateKey`。
- `ZeroizeOnDrop` 与显式 unlock/lock 生命周期。

**绝对不能照搬的：**

- SRP 认证、Proton user/address key 层级、Signed Key Lists、恢复联系人、设备验证。
- `gopenpgp-sys` 需要 Go 工具链。

### 2.2 Proton 账户密钥层级与恢复机制

虽然 Kylins 不是 Proton 账户，但理解其层级有助于设计自己的密钥管理：

```text
password + salt
    ↓ bcrypt (cost 10)
MailboxHashedPassword
    ↓ 后半部分
KeySecret
    ↓ 解密
User Key（主密钥，用于签名/ certify）
    ↓ 解密 Address Key Token
Address Key（邮件加密/签名子密钥）
```

**恢复机制：**

- 生成 32 字节随机 `RecoverySecret`。
- 用 `RecoverySecret` 对未锁定的 User Key 签名，再用它加密 User Key。
- 恢复数据（recovery data）是 `recovery_secret || encrypted_user_keys` 的加密 blob。
- 用户记住 recovery phrase，或指定恢复联系人持有恢复密钥的份额。

**对 Kylins 的启示：**

- Kylins 不需要 Proton 的 account/user/address 三层，但需要 **Account Master Key → Identity Key → Message Session Key** 三层。
- 恢复机制可以借鉴：用 recovery phrase 加密 Account Master Key，或分片给可信联系人。
- 私钥必须 **用 master key 加密后存 SQLite**，内存中只保留 TTL 缓存。

### 2.3 Sequoia：功能最强，但不是纯 Rust

**结论：Sequoia 默认不是纯 Rust，但可以切成纯 Rust。**

- 默认 feature：`["compression", "crypto-nettle"]`。
- `crypto-nettle` → `nettle` crate → `nettle-sys`，会编译 Nettle C 库。
- 其它可选后端：
  - `crypto-openssl`：OpenSSL（C）。
  - `crypto-botan`：Botan（C++）。
  - `crypto-cng`：Windows CNG（原生，仅 Windows）。
  - `crypto-rust`：RustCrypto 纯 Rust 后端。

`openpgp/build.rs` 对后端有明确标注：

| 后端 | production_ready | constant_time |
|---|---|---|
| Nettle | ✅ | ✅ |
| OpenSSL | ✅ | ✅ |
| Botan | ✅ | ✅ |
| CNG | ✅ | ✅ |
| **RustCrypto** | ❌ | ❌ |

因此使用 `crypto-rust` 需要同时开启：

```bash
cargo build -p sequoia-openpgp \
  --no-default-features \
  --features "crypto-rust,allow-experimental-crypto,allow-variable-time-crypto"
```

**Sequoia 其它 crate：**

- `sequoia-ipc`：纯 Rust（`capnp-rpc`、tokio、libc 绑定），build.rs 只跑 lalrpop + capnpc。
- `sequoia-net`：默认纯 Rust；`dane-client` feature 会拉 `hickory-resolver` 的 `dnssec-aws-lc-rs`，从而引入 AWS libcrypto（C）。
- `buffered-reader`：默认压缩用 `bzip2` 0.6.1 + `flate2`；当前 `bzip2` 已改用 `libbz2-rs-sys` 纯 Rust 实现，`flate2` 默认用 `miniz_oxide` 纯 Rust。
- `sequoia-autocrypt`：纯 Rust。

**对 Kylins 的意义：**

- 如果默认用 Sequoia，Windows/macOS/Linux 都要处理 Nettle 的 C 编译、静态/动态链接、分发签名问题。
- 如果坚持纯 Rust，必须接受 Sequoia 官方对 `crypto-rust` 的实验性警告。
- Sequoia 更适合 GnuPG 重度兼容场景；Kylins 作为新桌面客户端，rPGP 更轻量。

### 2.4 rPGP：`pgp` crate

- 纯 Rust、MIT/Apache-2.0。
- 基于 RustCrypto 生态（`rsa`、`ed25519-dalek`、`x25519-dalek`、`sha2`、`aes-gcm` 等）。
- 支持 RFC 9580（v6 packets、Ed25519/X25519、AEAD-OCB、Argon2 S2K）。
- Proton 的 `proton-rpgp` 就是它的生产封装。
- 智能卡伴侣：`openpgp-card-rpgp`。

**缺点：** 生态比 Sequoia 小，没有 `sq` CLI 那样完整的工具链，但 Kylins 只需要库。

### 2.5 PKCS#11 / Smartcard / HSM

#### PC/SC 是什么

PC/SC（Personal Computer/Smart Card）是智能卡与读卡器通信的跨平台标准：

- Windows：内置 WinSCard API。
- macOS：CryptoTokenKit / TokenD。
- Linux：`pcscd` + `libpcsclite`。

OpenPGP 卡通过 PC/SC 与主机通信，但 PC/SC 只是传输层，真正的 OpenPGP 命令由卡上的 OpenPGP 应用处理。

#### `rust-cryptoki`

Parsec 维护的 PKCS#11 安全封装：

```text
cryptoki-sys  (bindgen FFI 到 PKCS#11 C 头)
cryptoki       (safe Rust wrapper)
```

核心用法：

- `Pkcs11::new(lib_path)` 加载厂商 DLL/SO/dylib。
- `get_slots_with_initialized_token()` 枚举 token。
- `Session` 不是 `Sync`，需要 session pool。
- 私钥永远不出 token，只拿到 `ObjectHandle`。
- 用 `session.sign(&mechanism, handle, digest_info)` 做原始签名。
- 用 `session.decrypt(&mechanism, handle, encrypted_kek)` 做密钥解密。
- `AuthPin` / `RawAuthPin` 包装 PIN，避免日志泄露。

#### OpenPGP 智能卡 vs PKCS#11 HSM

| 场景 | 推荐方案 | 说明 |
|---|---|---|
| OpenPGP 卡（YubiKey OpenPGP applet 等） | `openpgp-card-rpgp` | 代码纯 Rust，运行时依赖 PC/SC 驱动 |
| PKCS#11 HSM（SafeNet、YubiHSM） | `rust-cryptoki` + 自研 bridge | OpenPGP 子密钥在 token 内，证书本体本地维护 |
| OpenPGP → PKCS#11 bridge | `openpgp-pkcs11-sequoia` | 依赖 Sequoia，不是纯 Rust |

**重要：** `openpgp-card-rpgp` 的 Rust 代码是纯 Rust，但它运行时仍需要 OS 的 PC/SC 服务，所以严格说“代码纯 Rust，运行时依赖平台原生驱动”。这与 Nettle 有本质区别：Nettle 是编译时链接 C 库，PC/SC 是调用 OS 已有服务。

### 2.6 跨平台原生依赖的影响

只要依赖 C/C++ 库，以下问题就会出现：

| 问题 | Linux | macOS | Windows |
|---|---|---|---|
| 编译器 | gcc/clang 通常可用 | 需要 Xcode Command Line Tools | 需要 MSVC Build Tools 或 MinGW |
| 系统库版本 | glibc 版本差异 | Homebrew Nettle/OpenSSL 路径 | 需要 vcpkg 或手动配置 |
| 静态/动态链接 | 动态链接常见 | .dylib 签名/公证 | .dll 需要随安装包分发 |
| 交叉编译 | 较容易 | 难 | 很难 |
| CI/CD | GitHub Actions `ubuntu-latest` | `macos-latest` + Xcode | `windows-latest` + MSVC |
| 安装包体积 | 增加 | 增加 | 增加 |

**具体 crate：**

- `nettle`（Sequoia 默认）：C 库，三端都要处理。
- `openssl-sys`：需要系统 OpenSSL 开发包或 vendored。
- `botan`：C++ 库，构建复杂。
- `aws-lc-rs`：AWS libcrypto，C 库。
- `gmssl-rs`：GmSSL C 库，CMake 构建，Windows/macOS 分发困难。
- `cryptoki-sys`：只有 FFI 绑定，不编译 C 库；真正的厂商 PKCS#11 驱动由用户/token 提供。

**Kylins 作为 Tauri 桌面应用：**

- Tauri 本身已依赖 WebView2（Win）、WKWebView（macOS）、WebKitGTK（Linux）。
- 再加 Nettle/OpenSSL 不会“质变”，但会多一个需要版本对齐、签名、打包、安全更新的原生组件。
- 对普通用户安装包来说，**纯 Rust 是最小惊讶原则**。

---

## 3. Kylins 加密架构设计建议

> **权威设计文档：** 本节为基于生态/源码学习得出的方向性建议；Kylins 加密模块的权威设计以 [`crypto-architecture-design.md`](crypto-architecture-design.md) 为准。两者冲突时以设计文档为准。

### 3.1 总体原则

1. **Rust backend 持有所有密钥和加密操作**，前端只传文件路径/参数，不传私钥。
2. **所有加密操作 async**，默认在 `tokio::task::spawn_blocking` 执行。
3. **敏感内存用 `secrecy` + `zeroize`**。
4. **私钥加密后存 SQLite**，由现有 master key 保护。
5. **集中 `CryptoPolicy`**，默认拒绝 MD5/SHA1/3DES/IDEA/DSA/Elgamal/secp256k1。
6. **信任决策显式化**：contact pinning + TOFU + 用户确认，不自动加密。
7. **后端可插拔**：`CryptoProvider` trait + feature flag。

### 3.2 推荐分层

```text
Frontend (React 19)
    ↓ invoke / events
Tauri Rust backend
    commands/crypto_commands.rs
    crypto/
        ├── provider.rs          CryptoProvider trait + CryptoPolicy
        ├── types.rs             共享类型、错误、算法枚举
        ├── error.rs             CryptoError
        ├── policy.rs            统一策略结构
        ├── key_store.rs         KeyStore trait
        ├── trust.rs             TrustPolicy / pinning / TOFU
        ├── mime.rs              S/MIME & PGP/MIME 包装/解包
        ├── openpgp/             OpenPGP 后端（默认 rPGP）
        │   ├── provider.rs
        │   ├── engine.rs        rPGP 封装；可选 Sequoia feature
        │   ├── key_store.rs
        │   ├── discovery.rs     WKD / keyserver / Autocrypt
        │   ├── smartcard.rs     openpgp-card-rpgp
        │   └── policy.rs
        ├── smime/               S/MIME 后端
        │   ├── provider.rs
        │   ├── engine.rs        CMS Signed/EnvelopedData
        │   ├── cert_store.rs
        │   ├── validation.rs
        │   └── pkcs11.rs        rust-cryptoki token 封装
        └── sm/                  国密后端（Phase 3）
            ├── provider.rs
            ├── engine.rs        libsm 或 gmssl-rs
            ├── cert_store.rs
            └── ffi.rs
    db/
        crypto_keys.rs
        trust_decisions.rs
    crypto.rs                  现有 master key + AES-256-GCM 保险库
```

### 3.3 CryptoProvider trait 示例

```rust
pub trait CryptoProvider: Send + Sync + 'static {
    type Key: CryptoKey;
    type PublicKey: PublicKey;
    type PrivateKey: PrivateKey;
    type SignedMessage: SignedMessage;
    type EncryptedMessage: EncryptedMessage;

    fn name(&self) -> &'static str;
    fn policy(&self) -> &CryptoPolicy;

    fn new_signer(&self, key: &Self::PrivateKey) -> Result<Box<dyn Signer>, CryptoError>;
    fn new_verifier(&self) -> Result<Box<dyn Verifier>, CryptoError>;
    fn new_encryptor(&self) -> Result<Box<dyn Encryptor>, CryptoError>;
    fn new_decryptor(&self, key: &Self::PrivateKey) -> Result<Box<dyn Decryptor>, CryptoError>;

    fn generate_key(&self, params: KeyGenParams) -> Result<Self::Key, CryptoError>;
    fn import_key(&self, data: &[u8], passphrase: Option<&str>) -> Result<Self::Key, CryptoError>;
    fn export_public_key(&self, key: &Self::PublicKey) -> Result<Vec<u8>, CryptoError>;

    fn key_store(&self) -> &dyn KeyStore<Key = Self::Key>;
}
```

### 3.4 默认算法策略

**OpenPGP：**

- 允许：Ed25519、X25519、RSA ≥3072、AES-256/128、AEAD-OCB/EAX、SHA-256/384/512。
- 拒绝：MD5、SHA-1、RIPEMD-160、3DES、IDEA、CAST5、DSA、Elgamal、secp256k1。
- S2K：Argon2（t=1, p=4, m=21）。
- DoS：max message 50 MB，max S2K trials 5。

**S/MIME：**

- 必须：SHA-256/512、AES-128-GCM/256-GCM、ECDSA P-256/P-384、Ed25519、RSA-PSS SHA-256。
- 兼容：AES-128-CBC。
- 历史：SHA-1、MD5、3DES 拒绝。

### 3.5 密钥存储

```sql
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
    policy_json TEXT
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
```

### 3.6 发送/接收 MIME 集成

**发送：**

```text
Composer 设置 isSigned / isEncrypted / cryptoMethod
    ↓
buildRawEmail() → 原始 MIME
    ↓
crypto_sign(input, signed_output, account_id, detached=true)
    ↓ (若启用加密)
crypto_encrypt(signed_output, encrypted_output, recipients, account_id)
    ↓
base64url encode → sync_apply_mutation { type: "send" }
    ↓
SMTP / EAS
```

**接收：**

```text
IMAP 拉取原始 MIME
    ↓
detect_crypto_type(content_type)
    ↓
crypto_decrypt(input, decrypted, account_id)
crypto_verify(decrypted, detached?, account_id)
    ↓
DOMPurify → sandboxed iframe 渲染
    ↓
LockIcon + 签名状态
```

### 3.7 现有保险库加固（P0）

在引入 OpenPGP/S-MIME 之前，先加固 `kylins.client.backend/src/crypto.rs`：

1. **给 AES-GCM 加 AAD**：绑定 `account_id` + `field_name` + `key_version`，防止密文跨账户/字段重放。
2. **`zeroize` 主密钥**：当前是 `[u8; 32]`，应换成 `secrecy::SecretBox<[u8; 32]>`。
3. **密钥版本前缀**：便于未来轮换 master key。
4. **常量时间比较**：MAC 比较用 `subtle::constant_time_eq`。

---

## 4. 实施路线图

### Phase 0 — 加固现有保险库（1–2 周）

| 任务 | 文件 | 验收 |
|---|---|---|
| AES-GCM 加 AAD | `src/crypto.rs` | 篡改/重放测试失败 |
| Master key zeroize | `src/crypto.rs` | 内存扫描不泄露 |
| Key version 前缀 | `src/crypto.rs` | 可迁移旧密文 |

### Phase 1 — S/MIME 基础（3–4 周）

| 任务 | 文件 | 验收 |
|---|---|---|
| `CryptoProvider` trait + `CryptoPolicy` | `src/crypto/provider.rs`, `src/crypto/policy.rs` | 编译通过 |
| CMS SignedData / EnvelopedData | `src/crypto/smime/engine.rs` | 单元测试通过 |
| X.509 证书存储 | `src/crypto/smime/cert_store.rs`, `src/db/certs.rs` | 导入/导出/查找测试通过 |
| PKCS#11 token 原始 sign/decrypt | `src/crypto/smime/pkcs11.rs` | mock token 测试通过 |
| S/MIME MIME 包装 | `src/crypto/mime.rs` | 生成标准 S/MIME 消息 |
| Tauri commands | `src/commands/crypto_commands.rs` | 前端可调用 |
| 发送/接收 hook | `src/mail/builder.rs`, `src/mail/imap/client.rs` | 收发加密/签名邮件 |
| UI：SecurityPreferences、LockIcon | `Composer.tsx`, `ReadingPane.tsx` | 状态正确显示 |

### Phase 2 — OpenPGP（3–4 周）

| 任务 | 文件 | 验收 |
|---|---|---|
| 集成 `pgp`（rpgp） | `src/crypto/openpgp/engine.rs` | 编译通过 |
| `OpenPgpProvider` | `src/crypto/openpgp/provider.rs` | 单元测试通过 |
| Keyring / WKD / keyserver | `src/crypto/openpgp/key_store.rs`, `src/crypto/openpgp/discovery.rs` | 能导入/发现密钥 |
| PGP/MIME RFC 3156 | `src/crypto/mime.rs` | 收发 PGP/MIME 邮件 |
| Trust / pinning / TOFU | `src/crypto/trust.rs` | 首次签名弹出 trust dialog |

### Phase 3 — 国密 SM2/SM3/SM4（4–6 周，按需）

| 任务 | 文件 | 验收 |
|---|---|---|
| 评估 `libsm` CMS 国密封装 | `src/crypto/sm/engine.rs` | 互操作测试 |
| 如不足，引入 `gmssl-rs` feature | `Cargo.toml`, `src/crypto/sm/ffi.rs` | 可选编译 |
| SM2 证书管理 | `src/crypto/sm/cert_store.rs` | 导入/导出 |
| OpenPGP 国密扩展 | `src/crypto/openpgp/policy.rs` | 跟随最新 draft |

### Phase 4 — 高级与合规（按需）

| 任务 | 文件 | 验收 |
|---|---|---|
| OpenPGP 智能卡 `openpgp-card-rpgp` | `src/crypto/openpgp/smartcard.rs` | 插卡签名/解密 |
| PKCS#11 OpenPGP bridge | `src/crypto/openpgp/pkcs11.rs` | HSM 签名/解密 |
| OCSP/CRL 完整验证 | `src/crypto/smime/validation.rs` | 证书吊销检查 |
| RFC 9980 后量子算法 | `src/crypto/openpgp/policy.rs` | 实验 feature 可用 |
| 加密邮件搜索 | `src/search/` | 本地解密后索引 |

---

## 5. 依赖选型表

| crate | 用途 | 阶段 | 是否纯 Rust | 备注 |
|---|---|---|---|---|
| `pgp` (rpgp) | OpenPGP 引擎 | Phase 2 | ✅ | 默认引擎 |
| `sequoia-openpgp` | OpenPGP 可选引擎 | Phase 2 | ❌ 默认 / ✅ `crypto-rust` 实验 | feature gated |
| `cms` | CMS/PKCS#7 | Phase 1 | ✅ | RustCrypto |
| `x509-cert` | X.509 | Phase 1 | ✅ | RustCrypto |
| `x509-parser` | X.509 解析 | Phase 1 | ✅ | |
| `rsa` | 软件 RSA | Phase 1 | ✅ | |
| `p256`/`p384`/`p521` | 软件 ECDSA/ECDH | Phase 1 | ✅ | |
| `sha2`/`sha3` | 哈希 | Phase 1 | ✅ | |
| `aes`/`aes-gcm`/`cbc` | 对称加密 | Phase 1 | ✅ | |
| `cryptoki` | PKCS#11 | Phase 1 | ✅（仅 FFI 绑定） | 厂商驱动原生 |
| `secrecy` | 秘密包装 | Phase 0 | ✅ | |
| `zeroize` | 敏感内存清零 | Phase 0 | ✅ | |
| `subtle` | 常量时间比较 | Phase 0 | ✅ | |
| `libsm` | 国密原语 | Phase 3 | ✅ | |
| `gmssl-rs` | 国密 FFI | Phase 3 | ❌ | 备选 |
| `openpgp-card-rpgp` | OpenPGP 智能卡 | Phase 4 | ✅（代码） | 依赖 PC/SC |
| `openpgp-pkcs11-sequoia` | PKCS#11 OpenPGP bridge | Phase 4 | ❌ | 依赖 Sequoia |

---

## 6. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| `crypto-rust` 被 Sequoia 标记为实验性 | 若用 Sequoia 纯 Rust 有安全顾虑 | 默认用 rPGP；Sequoia 仅作可选 |
| `gmssl-rs` 成熟度不足 | 国密路径不稳定 | feature gated；保留 `libsm` fallback |
| OpenPGP 国密算法 ID 未标准化 | 互操作性差 | 跟随最新 IETF draft；配置开关 |
| PKCS#11 厂商驱动差异大 | 用户报错多 | 机制探测 + 清晰日志 + 可配置库路径 |
| 长耗时 crypto 阻塞 UI | 体验差 | 所有 command 走 async + spawn_blocking |
| 弱算法被误接受 | 安全性下降 | `CryptoPolicy` 默认拒绝；策略版本化 |
| 私钥在 IPC 中泄露 | 严重安全事件 | 私钥永不序列化到 invoke payload；只传文件路径 |
| 原生依赖增加跨平台构建成本 | CI/CD 复杂 | 默认走纯 Rust；C 依赖 feature gated |
| 用户误信自签名证书 | 中间人风险 | 显式 trust dialog；默认 untrusted |

---

## 7. 最终推荐

### 引擎选择

| 场景 | 推荐 |
|---|---|
| Kylins 默认 OpenPGP 引擎 | **`pgp` (rpgp)** |
| 需要 GnuPG 级兼容/CLI 生态 | Sequoia（默认 Nettle） |
| 坚持纯 Rust 且需要 Sequoia | Sequoia `crypto-rust` + 实验性 opt-in |
| S/MIME | RustCrypto `cms` + `x509-cert` |
| 国密 S/MIME | `gmssl-rs` FFI 或 `libsm` 自研 CMS |
| OpenPGP 智能卡 | `openpgp-card-rpgp` |
| PKCS#11 HSM | `rust-cryptoki` + 自研 bridge |

### 关键决策

1. **默认走纯 Rust。** 用 `pgp` + RustCrypto 生态，减少 Windows/macOS 分发痛苦。
2. **Sequoia 作为可选。** 通过 `CryptoProvider` trait 与 Cargo feature 保留切换能力，但默认不启用。
3. **先 S/MIME，后 OpenPGP。** S/MIME 在企业/证书场景更刚需，且 CMS/X.509 生态在 Rust 中已较成熟。
4. **先加固保险库。** 在加任何复杂加密前，给现有 AES-GCM 加 AAD、zeroize master key。
5. **智能卡/HSM 不阻塞 MVP。** Phase 1/2 专注软件密钥，Phase 4 再引入 token。
6. **国密按需。** 如果目标市场不需要国密，Phase 3 可以延后。

> **关于引擎与优先级取舍的说明：** 早期的 `openpgp-research-report.md`（已合并入本报告）曾建议 **Sequoia 为主引擎 + OpenPGP 先于 S/MIME**。本报告在进一步评估纯 Rust 分发成本（Nettle 在 Windows/macOS 的编译/签名/分发）与企业证书场景刚需后，改为 **rPGP 默认 + S/MIME 先做**。两条路径都通过 `CryptoProvider` trait + Cargo feature 保留切换能力：若未来更重视 GnuPG 兼容/CLI 生态，可把 Sequoia 提升为默认；若目标是端到端加密邮件而非企业 PKI，可把 OpenPGP 提前到 Phase 1。

---

## 8. 参考文档

### 本地源码

- `D:\Projects\mailclient\opensource\Proton\proton-crypto-rs\`
- `D:\Projects\mailclient\opensource\sequoia\`
- `D:\Projects\mailclient\opensource\pkcs11\rust-cryptoki\`
- `D:\Projects\mailclient\kylins\docs\proton-crypto-rs-source-learning-report.md`
- `D:\Projects\mailclient\kylins\docs\crypto-architecture-design.md`
- `D:\Projects\mailclient\kylins\docs\thunderbird-crypto-implementation-analysis-report.md`

#### Thunderbird OpenPGP 文件级索引（合并自 openpgp-research-report.md §3）

用于在 `comm-central` 中定位 Thunderbird 内建 OpenPGP 的实现入口；更完整的运行时分析见 `thunderbird-crypto-implementation-analysis-report.md`。

- 顶层封装：`BondOpenPGP.jsm`（对外 API）、`core.jsm`（生命周期）、`RNPLib.jsm`（FFI 装载）、`RNP.jsm`（rnp_* 绑定）。
- 密钥管理：`keyRing.jsm`（密钥环）、`keyObj.jsm`（单密钥对象）、`sqliteDb.jsm`（`openpgp.sqlite`，key acceptance 状态 stored per-fingerprint）、`masterpass.jsm`（私钥 passphrases，经 SDR/`logins.json` 风格保护）、`CollectedKeysDB.jsm`（收件时收集到的公钥）。
- 发现：`wkdLookup.jsm`（Web Key Directory）、`keyserver.jsm`（HKP/HKPS）、`GPGME.jsm`（可选外部 GnuPG）。
- MIME：`mimeEncrypt.jsm` / `mimeDecrypt.jsm` / `mimeVerify.jsm` 实现 `PgpMimeHandler`（JS MIME 转换器），经 `nsPgpMimeProxy` 桥接到 C++ 流水线。
- 关键模型：每密钥 acceptance 状态（unverified/verified/rejected）存储在 `openpgp.sqlite`，独立于邮件体；alias/identity 规则在 `keyRing` 层解析，避免“密钥存在但未绑定到发件地址”被误判为信任。

### Web / 标准

- RFC 9580 OpenPGP: https://datatracker.ietf.org/doc/rfc9580/
- RFC 9980 Post-Quantum Cryptography in OpenPGP: https://datatracker.ietf.org/doc/rfc9980/
- RFC 8551 S/MIME 4.0: https://datatracker.ietf.org/doc/rfc8551/
- RFC 5652 CMS: https://datatracker.ietf.org/doc/rfc5652/
- RFC 3156 PGP/MIME: https://datatracker.ietf.org/doc/rfc3156/
- rpgp: https://github.com/rpgp/rpgp
- Sequoia-PGP: https://sequoia-pgp.org/
- rust-cryptoki: https://github.com/parallaxsecond/rust-cryptoki
- openpgp-card-rpgp: https://codeberg.org/openpgp-card/rpgp
- openpgp-pkcs11-sequoia: https://codeberg.org/heiko/openpgp-pkcs11
- gmssl-rs: https://crates.io/crates/gmssl-rs
- libsm: https://crates.io/crates/libsm
- memsec: https://crates.io/crates/memsec
- bzip2-rs: https://crates.io/crates/bzip2
- RNP (Thunderbird 的 OpenPGP 后端): https://github.com/rnpgp/rnp
- Thunderbird OpenPGP 架构博文: https://blog.thunderbird.net/2019/10/openpgp-in-thunderbird-78/
- Mozilla Wiki — Smartcards/NSS: https://wiki.mozilla.org/NSS
- OpenPGP.js: https://openpgpjs.org/  ·  Proton pmcrypto: https://github.com/ProtonMail/pmcrypto
- Autocrypt v2（草案）: https://autocrypt.org/
- OpenPGP Email Summit 2024 纪要: https://www.openpgp.org/about/community/
- KeychainPGP（Sequoia 跨平台 GUI 参考）: https://keychainpgp.com/
- Zellic — Proton SRP/认证审计: https://www.zellic.io/

---

*报告由本地源码学习、Cargo 依赖树验证与 RFC 研究共同生成，供 Kylins Client 加密模块架构决策使用。*
