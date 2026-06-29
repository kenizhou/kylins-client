# Kylins Mail — 加密安全架构改进方案

## 基于多项目综合分析的设计建议

**分析来源：** Kylins 现有代码 + Proton Clients (Rust/Android/Web/Calendar) + proton-crypto-rs + CMMP.CryptoKit/Pkcs11Interop + rust-cryptoki + RustCrypto CMS

**目标：** 兼容 Gmail / O365 / Outlook.com / Coremail / Exchange / Yahoo 等主流邮件服务器的安全端到端加密

---

## 一、当前状态评估

### 现有优势

| 维度 | 现状 |
|------|------|
| **运行时** | Tauri v2 — Rust 原生加密能力，独立进程隔离 |
| **传输协议** | IMAP/SMTP/EAS — 与所有主流服务器兼容 |
| **数据库** | SQLite (WAL 模式) — 可存储加密密钥/证书/信任信息 |
| **密钥存储** | OS Keyring (`crypto.rs`) — 已有 AES-256-GCM 加密 secret 的能力 |
| **HTML 安全** | DOMPurify + sandboxed iframe — 已具备安全渲染能力 |
| **同步引擎** | Source-agnostic sync engine — 可扩展加密 hook |
| **插件系统** | PluginManager + InjectedComponent — 可扩展加密 UI slot |
| **设置系统** | key-value store — 可存储加密偏好 |
| **数据迁移** | Version-tracked migrations — 可安全添加加密相关表 |

### 关键缺失

| 维度 | 缺失项 |
|------|--------|
| **邮件加密** | `crypto.rs` 只加密本地账户 secret，不加密邮件内容 |
| **密钥管理** | 无用户密钥/地址密钥/会话密钥概念 |
| **信任模型** | 无证书存储、无密钥验证、无联系人固定密钥 |
| **MIME 加密** | 发送管线构建原始 MIME，无签名/加密步骤 |
| **加密检测** | 接收管线不解密、不验证签名 |
| **加密 UI** | 无锁图标、无加密状态指示、无密钥管理界面 |

---

## 二、核心架构决策：与 Proton 的根本差异

**Proton 模式：** Client → Proton API (加密存储) → Client
- Proton 控制服务器端，可以设计任意加密 API
- 密钥通过 Proton 自有 API 分发 (`GET /keys/all`)

**Kylins 模式：** Client → 标准 IMAP/SMTP/EAS 服务器 → Client
- **服务器不受控制** — 是 Gmail、O365、Exchange 等
- **必须兼容标准邮件协议** — 加密内容对服务器是透明 MIME 字节

### 关键洞察

> 加密操作在 Kylins 中的角色是 **MIME 转换器**：
> - 发送：`原始 MIME → [签名] → [加密] → S/MIME 或 PGP/MIME 格式 → SMTP 发送`
> - 接收：`IMAP 拉取 → [检测加密类型] → [解密] → [验证签名] → 渲染原始 MIME`
>
> 服务器只看到标准 MIME 消息，完全不感知加密。

---

## 三、目标系统架构

### 3.1 加密介入点 — 完整数据流

```
══════════════════════════════════════════════════════════════════
                    SEND PATH (加密介入点)
══════════════════════════════════════════════════════════════════

Composer UI (React)
  │
  ├─ 用户选择加密方式: [无] [S/MIME] [PGP] [SM2/3/4]
  ├─ 用户选择签名: [无] [S/MIME 签名] [PGP 签名]
  │
  ▼
buildRawEmail()  ← 构建原始 MIME (现有逻辑)
  │
  ├──→ write temp file ──→ ★ crypto_sign(input_path, output_path, account_id) ★
  │                              │
  │                              ├─ S/MIME: RustCrypto CMS SignedData
  │                              │   ├─ token 签名: rust-cryptoki → PKCS#11
  │                              │   └─ soft 签名: rsa crate
  │                              │
  │                              ├─ PGP: rpgp crate sign
  │                              └─ SM: libsm SM2 sign
  │
  ├──→ ★ crypto_encrypt(input_path, output_path, recipients, account_id) ★
  │                              │
  │                              ├─ 生成 AES-256 会话密钥
  │                              ├─ 查找接收者证书/公钥
  │                              │   ├─ 本地证书库 (S/MIME)
  │                              │   ├─ 联系人固定密钥 (PGP)
  │                              │   ├─ WKD/WKD/API 查询 (按需)
  │                              │   └─ LDAP/AD 目录 (企业场景)
  │                              │
  │                              ├─ 用每个接收者公钥加密会话密钥
  │                              ├─ 用会话密钥加密 MIME 内容 (AES-256-CBC/GCM)
  │                              │
  │                              ├─ S/MIME: RustCrypto CMS EnvelopedData
  │                              ├─ PGP: rpgp crate encrypt → PGP/MIME
  │                              └─ SM: libsm SM2/SM4 encrypt
  │                              │
  │                              └─ ★ MIME 包装 ★
  │                                   ├─ application/pkcs7-mime (S/MIME)
  │                                   └─ multipart/encrypted (PGP/MIME)
  │
  ▼
读取加密后的文件 → base64url → sync_apply_mutation { type: "send" }
  │
  ▼
Sync Engine → MailSource::send() → SMTP / EAS SendMail
  │
  ▼
邮件服务器 (看到标准 MIME，加密部分为不透明二进制)


══════════════════════════════════════════════════════════════════
                  RECEIVE PATH (解密介入点)
══════════════════════════════════════════════════════════════════

IMAP 拉取原始 MIME
  │
  ├──→ 保存原始 MIME 到本地
  │
  ▼
Message Display Pipeline (ReadingPane)
  │
  ├──→ ★ 检测加密类型 ★ (Content-Type 检测)
  │     ├─ application/pkcs7-mime; smime-type=enveloped-data → S/MIME 加密
  │     ├─ application/pkcs7-mime; smime-type=signed-data → S/MIME 签名
  │     ├─ multipart/signed; protocol="application/pkcs7-signature" → S/MIME 签名
  │     ├─ multipart/encrypted; protocol="application/pgp-encrypted" → PGP/MIME
  │     └─ 其他 → 无加密，直接渲染
  │
  ├──→ ★ crypto_decrypt(input_path, output_path, account_id) ★
  │                              │
  │                              ├─ 解析 CMS/PGP 结构 → 提取加密会话密钥
  │                              ├─ 用接收者私钥解密会话密钥
  │                              │   ├─ PKCS#11 token: rust-cryptoki Decrypt(CKM_RSA_PKCS)
  │                              │   └─ soft key: rsa crate
  │                              ├─ 用会话密钥解密 MIME 内容
  │                              └─ 写入解密后临时文件
  │
  ├──→ ★ crypto_verify(signed_path, detached_data_path?, account_id) ★
  │                              │
  │                              ├─ 提取签名者证书/密钥 ID
  │                              ├─ 查找签名者公钥 (本地库/联系人/API)
  │                              ├─ 验证签名
  │                              └─ 返回 VerificationResult { valid, signer, cert_chain }
  │
  ▼
DOMPurify → sandboxed iframe → 渲染解密后的 MIME
  │
  ├──→ 显示加密状态锁图标
  │     ├─ 加密锁 + 颜色 (S/MIME=蓝, PGP=绿, SM=红, 无加密=灰)
  │     ├─ 签名勾 (已验证 √, 未验证 ?, 失败 ✗)
  │     └─ 点击查看证书详情
```

### 3.2 模块架构

```
kylins.client.backend/src/
├── crypto/                          ★ NEW — 邮件加密模块
│   ├── mod.rs                       # 模块入口，re-exports
│   ├── provider.rs                  # CryptoProvider trait (核心抽象)
│   ├── encryptor.rs                 # Encryptor builder trait
│   ├── decryptor.rs                 # Decryptor builder trait
│   ├── signer.rs                    # Signer builder trait
│   ├── verifier.rs                  # Verifier builder trait
│   ├── types.rs                     # 共享类型 (KeyId, Algorithm, etc.)
│   ├── key_store.rs                 # KeyStore trait + 实现
│   ├── trust.rs                     # TrustPolicy, CertificateVerifier
│   ├── session.rs                   # SessionKey 管理
│   │
│   ├── smime/                       # S/MIME 后端 (Phase 1)
│   │   ├── mod.rs                   # SmimeProvider impl CryptoProvider
│   │   ├── encryptor.rs             # CMS EnvelopedData 构建
│   │   ├── decryptor.rs             # CMS EnvelopedData 解析+解密
│   │   ├── signer.rs                # CMS SignedData 构建
│   │   ├── verifier.rs              # CMS SignedData 解析+验证
│   │   ├── cert_store.rs            # X.509 证书存储+查找
│   │   ├── mime.rs                  # S/MIME MIME 包装/解包
│   │   └── pkcs11/                  # PKCS#11 硬件 token 集成
│   │       ├── mod.rs               # Pkcs11Token (rust-cryptoki wrapper)
│   │       ├── session.rs           # Token 会话管理 (超时/重连)
│   │       └── operations.rs        # Raw RSA sign/decrypt
│   │
│   ├── pgp/                         # PGP 后端 (Phase 2)
│   │   ├── mod.rs                   # PgpProvider impl CryptoProvider
│   │   ├── encryptor.rs
│   │   ├── decryptor.rs
│   │   ├── signer.rs
│   │   ├── verifier.rs
│   │   ├── key_store.rs             # PGP keyring + WKD 查询
│   │   └── key_manager.rs           # 用户密钥环+联系人固定密钥
│   │
│   └── sm/                          # 国密后端 (Phase 3)
│       ├── mod.rs                   # SmProvider impl CryptoProvider
│       ├── encryptor.rs             # SM2+SM4 加密
│       ├── decryptor.rs
│       ├── signer.rs                # SM2+SM3 签名
│       ├── verifier.rs
│       └── cert_store.rs            # SM2 证书管理
│
├── commands/
│   └── crypto_commands.rs           ★ NEW — Tauri IPC 命令
│       ├── crypto_sign(input_path, output_path, account_id, detached)
│       ├── crypto_encrypt(input_path, output_path, recipients, account_id)
│       ├── crypto_decrypt(input_path, output_path, account_id)
│       ├── crypto_verify(signed_path, detached_data_path, account_id)
│       ├── crypto_import_cert(account_id, cert_der, private_key?)
│       ├── crypto_list_certs(account_id)
│       ├── crypto_delete_cert(account_id, key_id)
│       └── crypto_get_trust_status(account_id, email)
│
└── db/
    ├── certs.rs                     ★ NEW — 证书表
    ├── pgp_keys.rs                  ★ NEW — PGP 密钥表
    └── trust_decisions.rs           ★ NEW — 信任决策表

kylins.client.frontend/src/
├── services/
│   └── crypto/
│       ├── mailCrypto.ts            # 前端加密服务封装
│       ├── certManager.ts           # 证书管理
│       └── trustDecisions.ts        # 信任决策管理
│
├── stores/
│   └── cryptoStore.ts               # 加密状态 (选定方法, 证书列表)
│
├── features/
│   └── crypto/
│       ├── CryptoPreferences.tsx     # 加密设置 UI
│       ├── CertManager.tsx           # 证书管理 UI
│       ├── LockIcon.tsx              # 加密锁图标组件
│       └── TrustDialog.tsx           # 信任决策对话框
│
└── components/
    └── email/
        └── SafeHtmlFrame.tsx        # 扩展: 显示加密状态
```

---

## 四、安全架构

### 4.1 密钥层次 (借鉴 Proton + Calendar)

```
═══════════════════════════════════════════════════
Layer 0: OS Keyring (硬件保护)
  └── Master Secret (256-bit, 已存在于 crypto.rs)
       │
Layer 1: 账户主密钥 (Account Master Key)  ★ NEW
  └── 每个邮件账户一个
  └── 由 Master Secret 派生 (HKDF)
  └── 加密存储于 SQLite accounts 表新增字段
       │
Layer 2: 加密身份密钥 (Crypto Identity Key)  ★ NEW
  ├── S/MIME: X.509 证书 + RSA/ECC 私钥
  │   ├── 外部导入 (PKCS#12 / PEM)
  │   ├── PKCS#11 token (硬件)
  │   └── 本地生成 (自签名)
  ├── PGP: OpenPGP 密钥对
  │   ├── 外部导入
  │   └── 本地生成
  └── SM: SM2 密钥对
       │
Layer 3: 邮件会话密钥 (Message Session Key)  ★ NEW
  └── AES-256, 每封邮件随机生成
  └── 用接收者身份密钥公钥加密 (PKESK)
  └── 用会话密钥加密邮件正文 (AES-256-CBC/GCM)
```

### 4.2 密钥存储安全

| 密钥层 | 存储位置 | 保护方式 |
|--------|---------|---------|
| Master Secret | OS Keyring | OS 级保护 (macOS Keychain, Windows DPAPI, Linux Secret Service) |
| Account Master Key | SQLite + OS Keyring | AES-256-GCM 加密存储, 密钥在 OS Keyring |
| S/MIME 私钥 (soft) | SQLite | 用 Account Master Key AES-GCM 加密 |
| S/MIME 私钥 (token) | PKCS#11 硬件 | 永不离开 token |
| PGP 私钥 | SQLite | 用 Account Master Key AES-GCM 加密 |
| 会话密钥 | 内存仅 | 用后即弃, 永不持久化 |

### 4.3 信任模型 (三层信任)

借鉴 Proton 的联系人固定密钥 + Key Transparency + WebClients 的 XOR 分割方案：

```
Layer 1 — 证书验证 (S/MIME)
  ├── 标准 X.509 链验证 (CA 信任链)
  ├── CRL / OCSP 吊销检查
  └── 用户可接受自签名证书 (手动信任)

Layer 2 — 联系人密钥固定 (Contact Key Pinning)
  ├── 首次通信: 记录对方证书/密钥指纹
  ├── 后续通信: 比对指纹 → 若变化则警告
  ├── 固定信息存储于 contacts 表扩展字段
  └── 签名 vCard (借鉴 Proton)

Layer 3 — 密钥透明审计 (Key Transparency)
  ├── 所有信任决策记录于 trust_decisions 表
  ├── 用户可查看完整信任历史
  └── 定期自审计 (借鉴 Proton Key Transparency)
```

### 4.4 数据安全分级

| 数据类别 | 存储 | 加密状态 | 访问控制 |
|---------|------|---------|---------|
| 邮件正文 | SQLite messages 表 | 可选 E2E 加密 (原始加密 MIME 存储) | 需会话密钥 |
| 已解密缓存 | 临时文件 | 加密写入，用后即删 | 仅内存会话期间 |
| 私钥 | SQLite + OS Keyring | AES-256-GCM 双层加密 | 需主密钥解锁 |
| 会话密钥 | 不持久化 | 内存中零时存在 | 用后清零 (zeroize) |
| 证书/公钥 | SQLite | 明文 (公钥无需保护) | 完整性校验 |
| 信任决策 | SQLite | 签名保护防篡改 | 仅追加写入 |
| Token/密码 | OS Keyring | OS 原生保护 | OS 级隔离 |
| PIN/口令 | 内存 | `secrecy` crate 零时保护 | 用后 zeroize |

---

## 五、加密流程 — 详细设计

### 5.1 发送加密邮件 (S/MIME 路径)

```
输入: 原始 MIME 文件, 接收者列表, 账户配置
输出: 加密后的 S/MIME MIME 文件

Step 1 — 密钥解析
  KeyStore::resolve_keys_for_sending(account_id, recipients)
    ├─ 对每个接收者 email:
    │   ├─ 查本地证书库 (certs 表)
    │   ├─ 查联系人固定密钥 (contacts 表扩展字段)
    │   ├─ 如未找到 → 标记为"未加密"或"按需查询 LDAP/WKD"
    │   └─ 返回 Vec<(email, Option<PublicKey>)>
    └─ 加载发送者私钥 (token 或 soft)

Step 2 — 签名 (可选)
  如果用户启用签名:
    Signer::sign_file(input_path, signed_output_path)
      ├─ 流式读取 input，64KB chunks
      ├─ sha2::Sha256::update(chunk) ...
      ├─ finalize() → 32B hash
      ├─ 构建 CMS SignedAttributes { contentType, messageDigest, signingTime }
      ├─ DER 编码 SignedAttributes → SHA-256 hash → DigestInfo (51 bytes)
      ├─ 签名 DigestInfo:
      │   ├─ Token: Pkcs11Token::sign_rsa_pkcs(key_handle, &digest_info)
      │   └─ Soft:  rsa::sign(signer_key, &digest_info)
      ├─ RustCrypto cms::SignedDataBuilder → .add_signer_info(...)
      ├─ 输出 multipart/signed 或 application/pkcs7-mime (opaque)
      └─ signed_output_path (签名后的 MIME)

Step 3 — 加密
  Encryptor::encrypt_file(signed_path, encrypted_output_path, recipients)
    ├─ 生成 AES-256 会话密钥 (随机)
    ├─ 流式读取输入 → AES-256-CBC 加密 → 写入临时加密文件
    ├─ 对每个拥有公钥的接收者:
    │   └─ rsa::encrypt(recipient_pubkey, &session_key) → 加密 CEK
    ├─ 构建 RecipientInfos (每个接收者一个 KeyTransRecipientInfo)
    ├─ RustCrypto cms::EnvelopedDataBuilder
    │   .add_recipient_info(...) (每个接收者)
    │   .build_with_rng(&mut rng)
    ├─ MIME 包装: Content-Type: application/pkcs7-mime; smime-type=enveloped-data
    └─ encrypted_output_path

Step 4 — 发送
  读取 encrypted_output_path → base64url → sync_apply_mutation

内存管理:
  - 所有密钥材料用 secrecy::SecretVec 包装
  - 操作完成后 drop 触发 zeroize
  - 临时文件写入系统 temp dir，完成后删除
  - 200MB 邮件: 内存峰值 < 100MB (流式处理)
```

### 5.2 接收解密邮件 (S/MIME 路径)

```
输入: 从 IMAP 接收的加密 MIME 文件
输出: 解密后的原始 MIME

Step 1 — 检测加密类型
  detect_crypto_type(content_type_header)
    ├─ "application/pkcs7-mime; smime-type=enveloped-data" → S/MIME 加密
    ├─ "application/pkcs7-mime; smime-type=signed-data" → S/MIME 签名(opaque)
    ├─ "multipart/signed; protocol=\"application/pkcs7-signature\"" → S/MIME 签名(detached)
    ├─ "multipart/encrypted; protocol=\"application/pgp-encrypted\"" → PGP/MIME
    └─ 无匹配 → 普通邮件，直接渲染

Step 2 — 解密 (如果需要)
  Decryptor::decrypt_file(input_path, output_path, account_id)
    ├─ 解析 CMS EnvelopedData (der::Decode)
    ├─ 遍历 RecipientInfos → 找到匹配接收者 (by IssuerAndSerialNumber)
    │   └─ KeyStore::find_private_key(account_id, issuer, serial)
    │       ├─ Token: Pkcs11Token::find_key_by_cert(cert_serial)
    │       └─ Soft:  cert_store::find_key(account_id, key_id)
    ├─ 提取加密 CEK:
    │   ├─ Token: Pkcs11Token::decrypt_rsa_pkcs(key_handle, &encrypted_cek)
    │   └─ Soft:  rsa::decrypt(private_key, &encrypted_cek) → CEK
    ├─ 用 CEK 解密内容: AES-256-CBC → 写入 output_path
    └─ output_path

Step 3 — 验证签名 (与 Step 2 可交换顺序)
  Verifier::verify_file(decrypted_path, ...)
    ├─ 解析 CMS SignedData
    ├─ 提取签名者证书序列号
    ├─ 查找签名者公钥
    ├─ 验证 X.509 链 (x509-cert crate)
    ├─ 验证签名 → VerificationResult
    └─ 记录信任决策到 trust_decisions 表

Step 4 — 渲染
  ├─ 提取解密后 MIME → DOMPurify → sandboxed iframe
  └─ LockIcon 组件显示加密状态
```

### 5.3 发送加密邮件 (PGP 路径 — Phase 2)

```
与 S/MIME 同架构，不同实现:

Signer:
  rpgp::sign(sender_privkey, content) → PGP 签名
  MIME: multipart/signed; protocol="application/pgp-signature"

Encryptor:
  生成 AES-256 会话密钥
  rpgp::encrypt(content, session_key, recipient_pubkeys) → PGP/MIME
  MIME: multipart/encrypted; protocol="application/pgp-encrypted"
```

---

## 六、邮件服务器兼容性策略

### 6.1 兼容性矩阵

| 服务器 | 协议 | 加密方式 | 传输 | 密钥发现 | 特殊考虑 |
|--------|------|---------|------|---------|---------|
| **Gmail** | IMAP/SMTP | S/MIME, PGP | TLS | Google LDAP (证书查询) | OAuth 2.0 认证 |
| **O365** | IMAP/SMTP, EAS | S/MIME | TLS, StartTLS | Azure AD / LDAP | OAuth 2.0, 企业证书策略 |
| **Outlook.com** | IMAP/SMTP, EAS | S/MIME | TLS | — | OAuth 2.0 |
| **Exchange** | EAS, IMAP/SMTP | S/MIME | TLS | AD/LDAP, GAL | EAS 证书分发, 企业 CA |
| **Yahoo** | IMAP/SMTP | PGP, S/MIME | TLS | — | OAuth 2.0 |
| **Coremail** | IMAP/SMTP | SM2/SM3/SM4, S/MIME | TLS | 企业 CA | 国密证书, 企业部署 |
| **通用 IMAP** | IMAP/SMTP | S/MIME, PGP | TLS, StartTLS | 手动导入, WKD | 最广泛的兼容性 |

### 6.2 兼容性原则

1. **加密对服务器透明** — 服务器只看到标准 MIME 字节流
2. **协议不感知加密** — IMAP APPEND / SMTP DATA 传输的是加密后的 MIME
3. **密钥发现多渠道** — 本地库 → 联系人固定 → LDAP/AD → WKD → Web API → 手动导入
4. **降级策略** — 如果无法找到接收者公钥 → 允许发送未加密邮件 (用户确认)
5. **服务器特性不依赖** — 不使用任何服务器的自定义加密 API
6. **渐进增强** — 基本功能 (无加密) → S/MIME → PGP → SM 国密

---

## 七、可扩展性设计

### 7.1 CryptoProvider trait (借鉴 proton-crypto-rs)

```rust
pub trait CryptoProvider: Send + Sync {
    type Key: CryptoKey;
    type SessionKey: SessionKey;
    type Cert: CertInfo;

    fn name(&self) -> &'static str;
    fn version(&self) -> &str;

    // Builder 工厂方法
    fn new_signer(&self, key: &Self::Key) -> Result<Box<dyn Signer>, CryptoError>;
    fn new_verifier(&self) -> Result<Box<dyn Verifier>, CryptoError>;
    fn new_encryptor(&self) -> Result<Box<dyn Encryptor>, CryptoError>;
    fn new_decryptor(&self, key: &Self::Key) -> Result<Box<dyn Decryptor>, CryptoError>;

    // 会话密钥
    fn generate_session_key(&self, algo: SymmetricAlgorithm)
        -> Result<Self::SessionKey, CryptoError>;

    // 密钥存储
    fn key_store(&self) -> &dyn KeyStore<Key = Self::Key>;

    // 能力查询
    fn supported_algorithms(&self) -> Vec<Algorithm>;
    fn can_sign(&self) -> bool;
    fn can_encrypt(&self) -> bool;
    fn mime_type(&self, op: CryptoOperation) -> &str; // Content-Type for MIME wrapping
}
```

### 7.2 新增加密模块的步骤

1. 在 `crypto/<backend>/` 创建新目录
2. 实现 `CryptoProvider` trait
3. 实现 `Signer`, `Verifier`, `Encryptor`, `Decryptor` builder
4. 实现 `KeyStore` trait
5. 在 `crypto/mod.rs` 注册 provider
6. 添加 frontend 方法选择 UI (settings key `crypto.method`)

### 7.3 插件化扩展点

Frontend 插件系统已有注册模式 (`PluginManager`)，加密可复用：
- `registerComponent('message:crypto-status', LockIcon)` — 邮件加密状态展示
- `registerComponent('composer:crypto-options', CryptoSelector)` — 发送前加密选项
- `registerAction('crypto:import-cert', handler)` — 导入证书操作
- `registerMessageViewExtension(cryptoExtension)` — 解密后处理

---

## 八、数据库扩展

### 8.1 新表

```sql
-- 证书/密钥存储 (S/MIME)
CREATE TABLE certs (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    email TEXT,                           -- 关联的邮箱地址
    cert_der BLOB NOT NULL,               -- X.509 DER 编码证书
    private_key_enc BLOB,                 -- AES-GCM 加密的私钥 (可选, soft cert)
    private_key_on_token INTEGER DEFAULT 0, -- 1 = 私钥在 PKCS#11 token 上
    token_serial TEXT,                    -- PKCS#11 token 证书序列号
    is_default_sign INTEGER DEFAULT 0,
    is_default_encrypt INTEGER DEFAULT 0,
    imported_at TEXT NOT NULL,
    expires_at TEXT,
    fingerprint TEXT NOT NULL,            -- SHA-256 指纹
    issuer TEXT,
    subject TEXT,
    FOREIGN KEY (account_id) REFERENCES accounts(id)
);

-- PGP 密钥存储 (Phase 2)
CREATE TABLE pgp_keys (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    email TEXT,
    public_key_armored TEXT NOT NULL,     -- ASCII-armored PGP 公钥
    private_key_enc BLOB,                 -- 加密的私钥
    fingerprint TEXT NOT NULL,
    key_id TEXT NOT NULL,
    is_default INTEGER DEFAULT 0,
    created_at TEXT NOT NULL,
    FOREIGN KEY (account_id) REFERENCES accounts(id)
);

-- 联系人密钥固定
ALTER TABLE contacts ADD COLUMN pinned_key_fingerprints TEXT;     -- JSON array
ALTER TABLE contacts ADD COLUMN pinned_key_verified_at TEXT;

-- 信任决策审计
CREATE TABLE trust_decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT NOT NULL,
    peer_email TEXT NOT NULL,
    key_fingerprint TEXT NOT NULL,
    decision TEXT NOT NULL,               -- 'trusted' | 'untrusted' | 'verify_failed'
    evidence TEXT,                        -- JSON: cert chain, verification details
    decided_at TEXT NOT NULL,
    FOREIGN KEY (account_id) REFERENCES accounts(id)
);

-- 账户扩展
ALTER TABLE accounts ADD COLUMN crypto_method TEXT DEFAULT 'none';  -- 'smime' | 'pgp' | 'sm' | 'none'
ALTER TABLE accounts ADD COLUMN crypto_sign_enabled INTEGER DEFAULT 0;
ALTER TABLE accounts ADD COLUMN crypto_encrypt_enabled INTEGER DEFAULT 0;
ALTER TABLE accounts ADD COLUMN pkcs11_lib_path TEXT;
```

### 8.2 加密存储模式

所有私钥/secret 列遵循现有 `crypto.rs` 模式：
- Rust 端: `encrypt_secret(plaintext) → hex(nonce‖ciphertext)` → 写入 SQLite
- 解密: 从 SQLite 读取 → `decrypt_secret(hex_blob) → plaintext`
- 密钥材料用 `secrecy::SecretVec<u8>` 包装，实现 `Zeroize`

---

## 九、实施路线图

### Phase 1 — S/MIME 基础 (当前优先)
- [ ] `crypto/` 模块骨架 + `CryptoProvider` trait
- [ ] `crypto/smime/` — CMS SignedData + EnvelopedData 构建/解析
- [ ] `crypto/smime/pkcs11/` — rust-cryptoki 集成
- [ ] `crypto/smime/cert_store.rs` — 证书存储+查找
- [ ] `db/certs.rs` — 证书表 + 迁移
- [ ] `db/trust_decisions.rs` — 信任决策表
- [ ] `commands/crypto_commands.rs` — Tauri IPC 命令
- [ ] `services/crypto/mailCrypto.ts` — 前端服务
- [ ] 发送管线集成 (composer/send.ts 扩展)
- [ ] 接收管线集成 (ReadingPane 扩展)
- [ ] LockIcon 组件 + 加密状态显示
- [ ] CryptoPreferences UI (证书管理)

### Phase 2 — PGP 支持
- [ ] `crypto/pgp/` — rpgp 集成
- [ ] `db/pgp_keys.rs` — PGP 密钥表
- [ ] WKD 密钥发现
- [ ] 联系人密钥固定 UI

### Phase 3 — 国密 SM
- [ ] `crypto/sm/` — libsm 集成
- [ ] SM2 证书支持
- [ ] SM4-CBC 内容加密

### Phase 4 — 高级功能
- [ ] 多接收者混合加密 (部分 S/MIME, 部分 PGP)
- [ ] 加密搜索 (借鉴 Proton encrypted-search)
- [ ] 自动加密策略 (基于联系人/域名的规则)
- [ ] 加密邮件归档/导出
- [ ] 企业 CA 集成 (AD/LDAP/GAL)

---

## 十、安全保证清单

| 保证 | 实现 |
|------|------|
| 私钥不离开加密边界 | Token 私钥永不离开硬件；软件私钥仅内存中存在 |
| 密码不持久化 | 用 `secrecy` crate 的 `SecretVec` 包装，Drop 时 zeroize |
| 内存峰值可控 | 流式处理，>5MB 文件使用临时文件而非内存 buffer |
| 服务器不可读 | 加密发生在发送前，解密发生在接收后；服务器只传输加密 MIME |
| 无密钥泄露路径 | 密钥明文不经过 IPC (不在 `invoke()` payload 中) |
| 信任决策可审计 | trust_decisions 表仅追加写入，完整历史可查 |
| 密钥泄露可撤销 | 支持证书吊销列表 (CRL) + 联系人固定密钥变更检测 |
| HTML 注入不可行 | 解密后的 HTML 仍经过 DOMPurify + sandboxed iframe |
| SQL 注入不可行 | 所有查询参数化 (sqlx) |
| 降级安全 | 加密失败时提示用户，不允许静默降级为明文 |

---

## 附录：参考项目总结

| 项目 | 关键借鉴 |
|------|---------|
| **Proton clients (Rust)** | `PGPProvider` trait + Builder 模式 + `KeyManager` + `SendPreferences` |
| **Proton android-mail** | Rust SDK 做所有加密，Kotlin 只是 UI 壳；AndroidKeyStore 二次加密 |
| **Proton android-calendar** | 每对象独立密钥 (Calendar Key)，4 部分加密模型，X25519 |
| **Proton WebClients** | XOR 秘密分割 (window.name + sessionStorage)，Web Workers 隔离，localStorage AES-GCM blob |
| **proton-crypto-rs** | `AsPublicKeyRef` 模式，双后端 feature flag，`secrecy` crate，proton-crypto-subtle |
| **CMMP.CryptoKit** | Token 只做原始 RSA；CMS 在软件层构建；`SecureMimeContext` 作为 MIME 集成点 |
| **rust-cryptoki** | 安全 Rust PKCS#11 API：init/update/final 模式，`AuthPin` zeroizing |
| **RustCrypto CMS** | Pure Rust CMS：`SignedDataBuilder` + `EnvelopedDataBuilder`，`signature` crate 生态 |
| **rpgp** | Pure Rust OpenPGP，Proton fork with PQC + strict validation |
