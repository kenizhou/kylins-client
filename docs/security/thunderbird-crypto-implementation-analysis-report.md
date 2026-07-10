# Thunderbird Desktop S/MIME & OpenPGP 实现完整分析

> 报告日期：2026-07-10  
> 分析源码：`D:\Projects\mailclient\opensource\thunderbird-desktop`  
> 目标：为 Kylins Client 提供可借鉴的加密架构、流程与 UI/UX 设计

---

## 1. 执行摘要

Thunderbird 的 S/MIME 与 OpenPGP 实现采用了 **“统一抽象接口 + 独立后端实现 + 共享 UI 状态机”** 的三层架构：

- **抽象层**：`nsIMsgComposeSecure`（发送）和 `nsIMsgSMIMESink`/`nsIMsgOpenPGPSink`（接收）屏蔽了 S/MIME 与 OpenPGP 的差异。
- **后端实现**：S/MIME 走 NSS/CMS（C++），OpenPGP 走 RNP（C 库，JS 通过 ctypes 封装）+ 可选 GPGME 外部 GnuPG 回退。
- **前端 UI**：共享 `cryptoBox` 状态徽章 + 技术专属详情面板；compose 时用 per-recipient Key Assistant 解决密钥就绪问题。

**对 Kylins 最核心的借鉴：**

1. 用统一的 `CryptoProvider` / `ComposeSecure` 抽象封装不同加密方式，UI 只操作状态机。
2. 发送前做 **per-recipient readiness check**，不齐备时阻断发送并给出修复入口。
3. 阅读窗用一个 **共享 crypto badge** 展示加密+签名状态，详情面板分层展示技术细节。
4. 密钥管理采用 **“临时收集（CollectedKeysDB）+ 显式接受（acceptance）”** 的两级模型，避免自动导入污染 keyring。
5. 信任决策必须显式：rejected / undecided / unverified / verified / personal。
6. OpenPGP 主密码用于加密自动生成的 OpenPGP 口令，口令文件再用系统主密码保护——两层保险。

---

## 2. 抽象层：如何屏蔽 S/MIME 与 OpenPGP 的差异

### 2.1 发送侧统一接口：`nsIMsgComposeSecure`

文件：`mailnews/compose/public/nsIMsgComposeSecure.idl:69-154`

```idl
interface nsIMsgComposeSecure : nsISupports {
  boolean requiresCryptoEncapsulation();
  void beginCryptoEncapsulation(in nsIOutputStream aStream, ...);
  void mimeCryptoWriteBlock(in string aBuf, in long aLen);
  void finishCryptoEncapsulation();
  void mimeCryptoAsyncBlockCallback(...);
  void asyncFindCertByEmailAddr(in AUTF8String aEmail);
  void cacheValidCertForEmail(in AUTF8String aEmail, in nsIX509Cert aCert);
  boolean haveValidCertForEmail(in AUTF8String aEmail);
  attribute boolean signMessage;
  attribute boolean requireEncryptMessage;
};
```

关键设计：

- 邮件 composer 只认 `nsIMsgComposeSecure`，不关心底层是 CMS 还是 OpenPGP。
- 实例通过 XPCOM 工厂注册：
  - S/MIME：`@mozilla.org/messengercompose/composesecure;1` → `mailnews/extensions/smime/nsMsgComposeSecure.cpp`
  - OpenPGP：`@mozilla.org/messengercompose/composesecure;1` 被 `mail/extensions/openpgp/content/modules/mimeEncrypt.sys.mjs` 的 `PgpMimeEncrypt` 复用
- 状态挂在 `nsIMsgCompFields.composeSecure`：`mailnews/compose/public/nsIMsgCompFields.idl:102`

Kylins 映射：Rust 后端可以定义一个 `ComposeSecure` trait / `CryptoProvider`，Tauri command 只传 `account_id`、`sign`、`encrypt`、`recipients`，后端决定用 S/MIME 还是 OpenPGP。

### 2.2 接收侧统一接口：Sink

S/MIME sink：`mailnews/extensions/smime/nsIMsgSMIMESink.idl:11-40`
OpenPGP sink：`mail/extensions/openpgp/nsIMsgOpenPGPSink.idl:11-40`

两者是平行的，方法几乎一致：

```idl
void signatureProcessingStarted(in AUTF8String aMicAlg);
void signedStatus(in nsresult aStatus, ...);
void resetSignedStatus();
void encryptionStatus(in nsresult aStatus, ...);
```

Sink 被挂在邮件 channel 上：`mailnews/base/public/nsIMailChannel.idl:89-95`

```idl
attribute nsIMsgOpenPGPSink openpgpSink;
attribute nsIMsgSMIMESink smimeSink;
```

MIME 解析器在解析到签名/加密部分时，调用对应 sink 的方法，sink 再更新 UI。

Kylins 映射：Rust 后端解密/验证完成后，通过 Tauri event 把状态（加密 OK/FAIL、签名 verified/unverified/mismatch/unknown、证书/密钥信息）推送给前端；前端用统一组件渲染。

### 2.3 状态机统一：cryptoBox

文件：`mail/extensions/smime/content/msgHdrViewSMIMEOverlay.js:82-162`

无论 S/MIME 还是 OpenPGP，阅读窗都用同一个 `cryptoBox`：

- `tech`： `"OpenPGP"` / `"S/MIME"`
- `encryptionStatus`：`"ok"` / `"notok"`
- `signatureStatus`：`"ok"` / `"verified"` / `"unverified"` / `"mismatch"` / `"unknown"`

UI 根据这三个字段选择图标、颜色和文案。详情面板再根据 `tech` 分派到 OpenPGP 或 S/MIME 的详细视图。

---

## 3. 发送流程：完整加密/签名路径

### 3.1 S/MIME 发送流程

```text
Composer 设置 sign/encrypt 标志
    ↓
nsIMsgCompFields.composeSecure = nsMsgComposeSecure 实例
    ↓
MimeMessage._getComposeSecure() 判断需要 crypto
    ↓
MimeMessage._startCryptoEncapsulation()
    → nsMsgComposeSecure::BeginCryptoEncapsulation()
        → MimeCryptoHackCerts() 查找/验证证书
        → MimeInitMultipartSigned() 或 MimeInitEncryption()
    ↓
MimeMessage._writePart() 把 body 流式写入 mimeCryptoWriteBlock()
    ↓
nsCMSMessage::CreateSigned() / CreateEncrypted() 生成 CMS
    → nsCMSEncoder 把 DER 通过 base64 编码输出
    ↓
MimeMessage.createMessageFile() finishCryptoEncapsulation()
```

关键文件：

- `mailnews/extensions/smime/nsMsgComposeSecure.cpp:333-413` — `BeginCryptoEncapsulation`
- `nsMsgComposeSecure.cpp:796-985` — `MimeCryptoHackCerts`（查找 own cert、recipient certs、解锁 token）
- `nsMsgComposeSecure.cpp:444` — `MimeInitMultipartSigned`
- `nsMsgComposeSecure.cpp:490` — `MimeInitEncryption`
- `nsCMS.cpp:852-1009` — `CreateSigned`
- `nsCMS.cpp:743-838` — `CreateEncrypted`
- `mailnews/compose/src/MimeMessage.sys.mjs:528-671` — composer 调用抽象接口

MIME 包装：

| 操作 | Content-Type |
|---|---|
| 仅签名 | `multipart/signed; protocol="application/x-pkcs7-signature"; micalg=sha-256` |
| 仅加密 | `application/pkcs7-mime; smime-type=enveloped-data` |
| 签名+加密 | 外层 `application/pkcs7-mime; smime-type=enveloped-data`，内层 `multipart/signed` |

### 3.2 OpenPGP 发送流程

```text
Composer 设置 sendFlags (SEND_SIGNED / SEND_ENCRYPTED)
    ↓
PgpMimeEncrypt 作为 nsIMsgComposeSecure 实现被挂到 composeSecure
    ↓
beginCryptoEncapsulation() 选择 MIME 结构
    MIME_SIGNED / MIME_ENCRYPTED / MIME_OUTER_ENC_INNER_SIG
    ↓
mimeCryptoWriteBlock() 缓冲 header + body
    ↓
finishCryptoEncapsulation()
    → EnigmailEncryption.encryptMessageStart()
        → getCryptParams() 生成 backend-neutral encryptArgs
        → RNP.encryptAndOrSign()
    ↓
RNP 创建 rnp_op_encrypt / rnp_op_sign
    → 解锁私钥、添加 recipient、设置 AES256/SHA256
    ↓
输出 armored/binary PGP/MIME
```

关键文件：

- `mail/extensions/openpgp/content/modules/mimeEncrypt.sys.mjs:25-65` — `PgpMimeEncrypt` 注册与结构选择
- `mimeEncrypt.sys.mjs:117` — `beginCryptoEncapsulation`
- `mimeEncrypt.sys.mjs:336-424` — `finishCryptoEncapsulation`
- `mail/extensions/openpgp/content/modules/encryption.sys.mjs:350-403` — `encryptMessageStart`
- `encryption.sys.mjs:44` — `getCryptParams`
- `mail/extensions/openpgp/content/modules/RNP.sys.mjs:3860-4135` — `encryptAndOrSign`

发送前密钥选择：

- 自身密钥：`encryption.sys.mjs:242-283` `determineOwnKeyUsability()`，检查 `PgpSqliteDb2.isAcceptedAsPersonalKey()`
- 收件人密钥：`keyRing.sys.mjs:1113-1264` `getValidKeyForRecipient()` / `getValidKeysForAllRecipients()`，按 acceptance 级别排序

### 3.3 统一的“加密封装”抽象

| 步骤 | S/MIME | OpenPGP | 抽象接口 |
|---|---|---|---|
| 初始化 | `BeginCryptoEncapsulation` | `beginCryptoEncapsulation` | `nsIMsgComposeSecure` |
| 写数据 | `mimeCryptoWriteBlock` | `mimeCryptoWriteBlock` | `nsIMsgComposeSecure` |
| 完成 | `FinishCryptoEncapsulation` | `finishCryptoEncapsulation` | `nsIMsgComposeSecure` |
| 后端调用 | NSS CMS | RNP/GPGME | 后端私有 |
| MIME 输出 | PKCS#7 / multipart/signed | PGP/MIME | 标准 MIME |

Kylins 映射：Rust 后端可以定义一个 `ComposeCrypto` trait，有 `begin`、`write_block`、`finish` 三个方法；S/MIME 和 OpenPGP 分别实现。

---

## 4. 接收流程：完整解密/验证路径

### 4.1 S/MIME 接收流程

```text
IMAP/MIME 解析到 S/MIME 部分
    ↓
opaque CMS (application/pkcs7-mime)
    → mailnews/mime/src/mimecms.cpp
        → MimeCMS_init() 创建 nsICMSDecoder
        → MimeCMS_write() 喂数据
        → MimeCMS_eof() 调用 Finish()，输出解密后明文
multipart/signed
    → mailnews/mime/src/mimemcms.cpp
        → 哈希 body
        → 解码 detached signature
        → 异步 SMimeVerificationTask 验证
    ↓
nsCMSMessage::CommonVerifySignature()
    → CertVerifier::VerifyCert(email signer/recipient usage)
    → NSS_CMSSignedData_VerifySignerInfo()
    → 比对 signer email 与 From/Sender
    → 比对接签名时间与 Date 头
    ↓
nsIMsgSMIMESink.signedStatus() / encryptionStatus()
    ↓
msgHdrViewSMIMEOverlay.js 更新 cryptoBox
```

关键文件：

- `mailnews/mime/src/mimecms.cpp:507-714` — opaque CMS 处理
- `mailnews/mime/src/mimemcms.cpp:123-500` — multipart/signed 处理
- `mailnews/extensions/smime/nsCMS.cpp:408-607` — `CommonVerifySignature`
- `nsCMS.cpp:623-677` — `SMimeVerificationTask`（后台线程）
- `mail/extensions/smime/content/msgHdrViewSMIMEOverlay.js:282-456` — UI 更新

### 4.2 OpenPGP 接收流程

```text
MIME 解析到 multipart/encrypted 或 multipart/signed
    ↓
PgpMimeHandler.onStartRequest() 分派
    multipart/encrypted  → MimeDecryptHandler
    multipart/signed     → EnigmailVerify.newVerifier()
    ↓
MimeDecryptHandler
    → processData() 解码 base64/QP，提取 PGP body
    → onStopRequest() 调用 RNP.decrypt()
    → handleResult() 提取 protected headers、Autocrypt gossip
    → displayStatus() 调用 openpgpSink.updateSecurityStatus()
    → returnData() 把解密后的 MIME 喂回 libmime
    ↓
MimeVerifyHandler
    → onTextData() 提取 signed part + detached signature
    → onStopRequest() 调用 RNP.verifyDetached()
    ↓
RNP.getVerifyDetails()
    → 映射 RNP 状态到 Thunderbird 状态
    → 比对接签名时间与 Date 头
    → 检查 signer UID 与 From 是否匹配
    → 查询 PgpSqliteDb2.getAcceptance() 决定 trust
    ↓
openpgpSink 更新 cryptoBox
```

关键文件：

- `mail/extensions/openpgp/PgpMimeHandler.sys.mjs:98-120` — MIME 分派
- `mail/extensions/openpgp/content/modules/mimeDecrypt.sys.mjs:90-703` — 解密
- `mail/extensions/openpgp/content/modules/mimeVerify.sys.mjs:48-557` — 验证
- `mail/extensions/openpgp/content/modules/RNP.sys.mjs:1871-2073` — `decrypt`
- `RNP.sys.mjs:2616-2590` — `verifyDetached` + `getVerifyDetails`

### 4.3 验证结果状态映射

Thunderbird 把底层状态统一映射为以下高级状态：

**加密：**
- `MSG_ENC_OK`
- `MSG_ENC_NO_SECRET_KEY`
- `MSG_ENC_FAILURE`

**签名（OpenPGP）：**
- `MSG_SIG_VALID_KEY_VERIFIED`
- `MSG_SIG_VALID_KEY_UNVERIFIED`
- `MSG_SIG_VALID_SELF`
- `MSG_SIG_UNCERTAIN_KEY_UNAVAILABLE`
- `MSG_SIG_UNCERTAIN_UID_MISMATCH`
- `MSG_SIG_UNCERTAIN_KEY_NOT_ACCEPTED`
- `MSG_SIG_INVALID`
- `MSG_SIG_INVALID_DATE_MISMATCH`
- `MSG_SIG_INVALID_KEY_REJECTED`

**签名（S/MIME）：**
- CMS 错误码映射为 `SEC_ERROR_*`，再映射为 UI 字符串/类。

Kylins 映射：Rust 后端应返回类似的结构化结果；前端用一个统一状态机渲染图标和文案。

---

## 5. 密钥管理、存储与发现

### 5.1 S/MIME：NSS 证书数据库

- 所有 S/MIME 证书存在 NSS `nsIX509CertDB` 中。
- 私钥存在内部 PKCS#11 token，受 Thunderbird 主密码保护。
- 操作私钥前会触发 token 解锁提示：`nsMsgComposeSecure.cpp:820-824` `CERT_GetCertNicknames()` 会遍历所有 token。

关键文件：

- `mailnews/extensions/smime/nsCertPicker.cpp/h` — 证书选择器
- `mailnews/extensions/smime/nsCertGen.cpp/h` — 生成 S/MIME 密钥对 + CSR
- `mailnews/extensions/smime/certFetchingStatus.js` — LDAP 拉取证书
- `mailnews/extensions/smime/nsEncryptedSMIMEURIsService.cpp` — 记住哪些 URI 是加密的，重载时要求重新认证

Kylins 映射：用 SQLite 存证书 + `rustls-native-certs`/`webpki` 验证；软私钥用现有 master key AES-GCM 加密；token 私钥走 `rust-cryptoki`。

### 5.2 OpenPGP：RNP keyring + SQLite 接受度 + CollectedKeysDB

Thunderbird 的 OpenPGP 密钥管理是**三层存储**：

```text
pubring.gpg / secring.gpg   (RNP 标准 keyring，二进制)
    ↑↓ read/write by RNPLib
openpgp.sqlite              (接受度决策：fpr ↔ decision/email)
    ↑↓ PgpSqliteDb2
IndexedDB openpgp_cache     (临时收集的 key：seen_keys)
    ↑↓ CollectedKeysDB
```

**5.2.1 RNP keyring**

- `RNPLib.init()` 加载 `pubring.gpg`/`secring.gpg`：`mail/extensions/openpgp/content/modules/RNPLib.sys.mjs:517`
- 自动生成 OpenPGP 口令保护未受保护的私钥：`RNPLib.sys.mjs:671`
- 保存 keyring：`RNPLib.sys.mjs:750-813`

**5.2.2 内存缓存与索引**

- `keyRing.sys.mjs:46-48`：`gKeyListObj`、`gKeyIndex`、`gSubkeyIndex`
- `loadKeyList()`：`keyRing.sys.mjs:1919`
- `rebuildKeyIndex()`：按 fingerprint、16-char key ID、8-char short ID 索引：`keyRing.sys.mjs:1437`
- `getEncryptionKeyMeta()`：返回每个收件人的就绪矩阵：`keyRing.sys.mjs:1592`

**5.2.3 接受度数据库 `openpgp.sqlite`**

文件：`mail/extensions/openpgp/content/modules/sqliteDb.sys.mjs:461-481`

表：

```sql
CREATE TABLE acceptance_decision(fpr TEXT PRIMARY KEY, decision TEXT);
CREATE TABLE acceptance_email(fpr TEXT NOT NULL, email TEXT NOT NULL, PRIMARY KEY(fpr, email));
```

决策值：`undecided`、`unverified`、`verified`、`rejected`、`personal`。

方法：
- `getAcceptance()`：`:150`
- `updateAcceptance()`：`:336`
- `isAcceptedAsPersonalKey()`：`:410`

**5.2.4 临时收集库 `CollectedKeysDB`**

文件：`mail/extensions/openpgp/content/modules/CollectedKeysDB.sys.mjs:44-74`

IndexedDB `openpgp_cache`，object store `seen_keys`，key 为 fingerprint。

用途：存放从 WKD、keyserver、Autocrypt gossip、附件、GnuPG 自动发现但尚未被用户接受的 key。

**5.2.5 主密码保护**

文件：`mail/extensions/openpgp/content/modules/masterpass.sys.mjs`

- 自动生成 OpenPGP 口令。
- 口令加密后存到 `<ProfD>/encrypted-openpgp-passphrase.txt`，使用 `nsISecretDecoderRing`（即 Thunderbird 主密码）。
- `retrieveOpenPGPPassword()`：`:293`
- `_repairOrWarn()`：检测口令文件缺失但存在 `secring.gpg` 的异常场景。

### 5.3 密钥发现

**WKD（Web Key Directory）优先：**

- 文件：`mail/extensions/openpgp/content/modules/wkdLookup.sys.mjs`
- `getDownloadUrlFromEmail()`：`:216`，用 SHA1 + z-base32 编码 local part
- 带 padding header 隐藏请求大小：`:251`
- 维护公共邮箱域名排除列表：`:26-203`

**Keyserver 回退：**

- 文件：`mail/extensions/openpgp/content/modules/keyserver.sys.mjs`
- 支持 HKP/HKPS、VKS（keys.openpgp.org）、Keybase
- `lookupAndImportByEmail()`：先 WKD，再 keyserver：`keyLookupHelper.sys.mjs:243`

**发现模式：**

- `interactive-import`：新 key 必须用户确认才进入永久 keyring。
- `silent-collection`：新 key 只进 `CollectedKeysDB`，已有 key 的更新静默导入。

**Autocrypt：**

- 读取邮件 `Autocrypt:` header。
- 如果 header 中的 key 与 From 地址匹配，自动处理：`enigmailMessengerOverlay.js:2295-2327`
- 不基于 `prefer-encrypt=mutual` 自动加密。

**Aliases：**

- `OpenPGPAlias.sys.mjs`：JSON 别名规则，匹配 email 或 domain，映射到固定 key。
- 用于跳过在线发现、直接视为就绪。

---

## 6. 前端 UI/UX 设计细节

### 6.1 Composer 加密 UI

#### 6.1.1 状态模型

文件：`mail/components/compose/content/MsgComposeCommands.js:189-207`

```js
gSelectedTechnologyIsPGP
gSendEncrypted
gSendSigned
gAttachMyPublicPGPKey
gEncryptSubject
```

`updateEncryptionDependencies()`：`:11645` 保持状态一致，例如加密开启时强制签名。

#### 6.1.2 打开安全摘要

`showMessageComposeSecurityStatus(isSending)`：`:1971`

- OpenPGP → Key Assistant
- S/MIME → recipient-certificate 列表弹窗

#### 6.1.3 OpenPGP Key Assistant（per-recipient）

文件：

- `mail/extensions/openpgp/content/ui/keyAssistant.js`
- `keyAssistant.inc.xhtml`
- `mail/locales/en-US/messenger/openpgp/keyAssistant.ftl`

设计要点：

- 三视图：`mainView`、`resolveView`、`discoverView`（`:147-171`）。
- 主视图分为 **problematic list** 和 **ready list**（`buildMainView()`：`:185`）。
- 每个问题行展示：邮箱、问题描述、**Resolve…** 按钮（`:254-265`）。
- 就绪行展示：别名映射或 **View Key…** 按钮（`:228-237`）。
- 底部按钮：**Close**、**Disable Encryption**、**Send Encrypted**；发送按钮在所有收件人就绪前禁用（`:303-305`）。
- 一键 **Discover online** 或 **Import from file**。

问题类型映射：`keyAssistant.js:398-506`

- `accepted`、`collected`、`undecided`、`rejected`、`expiredAccepted`、`expiredUndecided`、`otherAccepted`、`alias`

#### 6.1.4 警告与错误

文件：`mail/extensions/openpgp/content/ui/enigmailMsgComposeOverlay.js`

- 缺少自身密钥：阻止发送并弹 alert（`:1066-1075`）
- 发送者密钥过期：notification bar（`:1911`）
- 缺少/无效收件人密钥：打开 Key Assistant（`:1100-1126`）
- 部分加密的 inline-PGP 回复：critical notification（`:1971`）
- 发送中止原因：不信任、未找到、已撤销、已过期（`:1381`）

#### 6.1.5 S/MIME Compose Security Info

文件：`mailnews/extensions/smime/msgCompSecurityInfo.js/xhtml`

- 简单表格：收件人、证书状态（`StatusValid` / `StatusNotFound`）、颁发日期、过期日期。
- **View** 按钮打开系统证书查看器（`:105-111`）。

### 6.2 阅读窗安全 UI

#### 6.2.1 共享 cryptoBox

文件：`mail/extensions/smime/content/msgHdrViewSMIMEOverlay.js:82-162`

```js
function setMessageCryptoBox(tech, encryptionStatus, signatureStatus) { ... }
```

UI 元素：

- 技术标签：`OpenPGP` / `S/MIME`
- 加密图标：`message-encrypted-ok.svg` / `message-encrypted-notok.svg`
- 签名图标：`message-signed-ok/mismatch/unknown/unverified/verified.svg`

特殊处理：明文邮件不显示 bad signature，但加密邮件即使签名有问题也显示，防止用户误以为“加密=安全”。

#### 6.2.2 详情弹出面板

文件：

- `mail/base/content/msgSecurityPane.inc.xhtml`
- `mail/base/content/msgSecurityPane.js:27`

内容：

- 状态标签和解释
- OpenPGP：**Import Sender Key** 通知、`openpgpKeyBox`
- **Missing Signature Key** 通知 + Discover 按钮、`signatureKeyBox`
- 签名 key ID + **View signer key**
- 加密 key ID + **View your decryption key**
- 其他收件人加密 key 列表
- S/MIME 证书字段（signed by、signer email、issuer 等）

#### 6.2.3 OpenPGP 阅读状态流

文件：`mail/extensions/openpgp/content/ui/enigmailMsgHdrViewOverlay.js`

- `updatePgpStatus()`：`:95`
- `updateStatusFlags()`：`:192`，映射到高级状态
- `updateVisibleSecurityStatus()`：`:315`，调用 `setMessageCryptoBox()`

文件：`mail/extensions/openpgp/content/ui/enigmailMessengerOverlay.js:2521-2821`

- 填充详情面板：标签、解释、CSS class
- 显示签名日期、signer/encryption key ID、subkey ID
- 列出所有额外加密 key

#### 6.2.4 S/MIME 阅读状态流

文件：`mailnews/extensions/smime/msgReadSMIMEOverlay.js:39-231`

- `loadSmimeMessageSecurityInfo()` 映射 `gSignatureStatus` / `gEncryptionStatus` 到标签/解释/CSS
- 显示证书详情（`:201-230`）
- `showImapSignatureUnknown()`：IMAP 签名无法验证时提示重新加载完整消息（`:16`）

#### 6.2.5 本地化字符串

文件：

- `mail/locales/en-US/messenger/openpgp/msgReadStatus.ftl`
- `mail/locales/en-US/messenger/openpgp/oneRecipientStatus.ftl`

文案特点：明确表达不确定性，例如：

- “Uncertain Digital Signature”
- “You haven’t yet decided if the signer’s key is acceptable to you”

### 6.3 密钥管理 UI

#### 6.3.1 Key Setup Wizard

文件：

- `mail/extensions/openpgp/content/ui/keyWizard.js`
- `keyWizard.xhtml`
- `mail/locales/en-US/messenger/openpgp/keyWizard.ftl`

流程：

1. 开始页：选择 **Create** / **Import** / **External GnuPG**（`:240-266`）
2. 创建页：身份选择器、口令保护（auto / primary password / custom）、过期时间、key type/size（`:392-434`）
3. 校验：过期 1 天–100 年（`validateExpiration()`：`:536`）
4. 生成前确认覆盖层（`:597`）
5. 生成时全屏覆盖层：spinner + cancel（`:620-739`）
6. 成功：保存撤销证书，通过回调关闭 dialog

UX 细节：

- Back/Continue 导航 + 动画切换（`:234-266`，`:484-493`）
- 导入区行内错误通知（`:336`）
- 每把 key 可勾选 **Treat this key as a Personal Key**（`:895`）
- 生成/import 期间移除关闭按钮、禁用 Escape（`:88-99`）

#### 6.3.2 Key Manager

文件：

- `mail/extensions/openpgp/content/ui/enigmailKeyManager.js`
- `enigmailKeyManager.xhtml`

设计要点：

- 可搜索、可排序树形表格，列：User ID、Key ID、Created、Expiry、Fingerprint（`:347-409`）
- 过滤栏：200 ms debounce 搜索（`:81-99`）
- View 菜单：显示无效 key、显示他人 key（`:215-229`）
- 根据选中项和是否有私钥动态启用/禁用菜单（`:225-284`）
- 双击打开 Key Properties（`:286-308`）
- 信任/有效性颜色类（`:966-1026`）

#### 6.3.3 Key Properties / Key Details Dialog

文件：

- `mail/extensions/openpgp/content/ui/keyDetailsDlg.js`
- `keyDetailsDlg.xhtml`

Tab 页：

1. **Acceptance**：单选 rejected / undecided / unverified / verified；指纹校验说明
2. **Email Addresses**：选择接受哪些 UID
3. **Passphrase Protection**：当前保护模式、解锁、修改口令、切换到主密码
4. **Certifications**：可展开签名树
5. **Structure**：primary/subkey 树，含 type、usage、algorithm、size、created、expiry

代码：

- `onLoad()`：`:79`
- `changeExpiry()`：`:106`
- `refreshOnline()`：`:137`
- `loadPassphraseProtection()`：`:154`
- 保存 acceptance：`dialogaccept`：`:987`

#### 6.3.4 Change Expiry Dialog

文件：`changeExpiryDlg.js/xhtml`

- 区分 simple / complex key
- complex key 支持下拉选择 key part（`keySelected()`：`:151`）
- 选项：保持过期、N 个月后过期、N 年后过期、永不过期（`:79-114`）

#### 6.3.5 Backup Key Password Dialog

文件：`backupKeyPassword.js/xhtml`

- 两个密码输入框，匹配后才启用 Accept
- 密码强度条（`getPasswordStrength()`：`:66`，`onPasswordInput()`：`:112`）
- 强调：忘记备份密码不可恢复

#### 6.3.6 Confirm Public Key Import Dialog

文件：`confirmPubkeyImport.js/xhtml`

- 显示 key ID、fingerprint、user IDs
- 单选：**Not accepted (undecided)** 或 **Accepted (unverified)**
- 用于文件、剪贴板、URL、附件导入 key

### 6.4 Trust 与 Key Discovery UX

#### 6.4.1 Trust 模型

文件：`mail/extensions/openpgp/content/modules/trust.sys.mjs`

- 把 GPG trust/validity code 映射成本地化标签（`getTrustLabel()`：`:55`）
- `isInvalid()` 区分 revoked/expired/disabled 与 unknown/valid（`:47`）

#### 6.4.2 首次收到加密/签名邮件

文件：`mail/extensions/openpgp/content/ui/enigmailMessengerOverlay.js`

- `processAfterAttachmentsAndDecrypt()`：扫描加密附件和 inline key block（`:2270`）
- 如果 Autocrypt header 与 From 匹配，处理 key（`:2295-2327`）
- 如果邮件附带 sender key，显示 **Import** 通知（`:2241`）
- 如果用户已接受不同 key，显示冲突警告（`:2246-2261`）
- 如果签名 key 缺失，详情面板显示 **Discover…** 按钮（`:1349`）

### 6.5 S/MIME 专属 UI

- **Certificate Picker**：`mailnews/extensions/smime/certpicker.js/xhtml`，简单下拉 + details
- **Certificate Fetching Status**：`certFetchingStatus.js/xhtml`，LDAP 拉取进度对话框
- **Compose/Read Overlays**：`msgCompSecurityInfo.js/xhtml`、`msgReadSMIMEOverlay.js`

---

## 7. 对 Kylins 的设计建议

> **权威设计文档：** 本节为基于 Thunderbird 源码学习得出的方向性建议；Kylins 加密模块的权威设计以 [`crypto-architecture-design.md`](crypto-architecture-design.md) 为准。两者冲突时以设计文档为准。

### 7.1 架构层建议

| Thunderbird 模式 | Kylins 映射 |
|---|---|
| `nsIMsgComposeSecure` | Rust `ComposeSecure` trait / Tauri `crypto_sign_encrypt` command |
| `nsIMsgSMIMESink` / `nsIMsgOpenPGPSink` | Tauri event `crypto:status` 推送结构化结果 |
| `cryptoBox` 状态机 | React 统一 `CryptoBadge` 组件 |
| RNP / NSS CMS 后端 | `pgp` crate + RustCrypto `cms` crate |
| RNPLib ctypes 封装 | 不需要，Kylins 直接用 Rust crate |
| `openpgp.sqlite` + `CollectedKeysDB` | SQLite `trust_decisions` + `collected_keys` 表 |
| 主密码保护 OpenPGP 口令 | Kylins 已有 OS keyring + master key，直接复用 |

### 7.2 发送流程建议

1. **Compose 状态**：`isSigned`、`isEncrypted`、`cryptoMethod`（openpgp/smime/none）。
2. **发送前检查**：调用后端 `checkSendReadiness(accountId, recipients, cryptoMethod)`。
3. **后端返回**：每个收件人的 readiness（ready / no_key / expired / rejected / alias / ...）。
4. **前端展示**：Key Assistant 式弹窗，分 ready / problematic 两栏。
5. **修复入口**：Discover online、Import from file、Resolve alias、Disable Encryption。
6. **发送按钮**：所有收件人 ready 才启用。
7. **后端执行**：
   - S/MIME：`cms` crate 构建 SignedData/EnvelopedData，软私钥或 `rust-cryptoki` token 签名。
   - OpenPGP：`pgp` crate 构建 PGP/MIME。

### 7.3 接收流程建议

1. IMAP 拉取原始 MIME。
2. 后端 `detectCryptoType(contentType)` 识别 S/MIME / PGP/MIME / inline PGP。
3. 解密/验证后通过 Tauri event 发送：

```typescript
interface CryptoStatusEvent {
  messageId: string;
  tech: 'openpgp' | 'smime' | null;
  encryption: 'ok' | 'notok' | null;
  signature: 'ok' | 'verified' | 'unverified' | 'mismatch' | 'unknown' | null;
  details: {
    signerKeyId?: string;
    signerFingerprint?: string;
    signerEmail?: string;
    encryptionKeyId?: string;
    recipientKeys?: Array<{ email: string; fingerprint: string }>;
    error?: string;
    dateMismatch?: boolean;
    uidMismatch?: boolean;
  };
}
```

4. 前端 `CryptoBadge` 渲染；点击展开详情面板。
5. 详情面板按 `tech` 分派：OpenPGP 显示 key acceptance 按钮；S/MIME 显示证书字段。

### 7.4 密钥管理 UI 建议

1. **Global Crypto Preferences**：每账户选择加密方式、默认签名/加密、主题加密、自动附加公钥。
2. **Key Setup Wizard**：Create / Import / External（可选）三步，生成 key 时显示进度覆盖层。
3. **Key Manager**：
   - 搜索 + 过滤（显示无效 key、显示他人 key）
   - 表格列：Name/Email、Fingerprint、Created、Expiry、Type、Status
   - 右键菜单：View、Export、Delete、Set as Default、Change Expiry
4. **Key Details Dialog**：
   - Tab：Overview、Acceptance、Email Addresses、Passphrase、Certifications、Structure
   - Acceptance 显式单选：rejected / undecided / unverified / verified / personal
5. **Backup/Restore**：导出带密码的备份，密码强度条，确认二次输入。
6. **Import Confirmation**：显示 fingerprint + user IDs，要求选择 acceptance。

### 7.5 Trust 与 Discovery UX 建议

1. **WKD 优先，keyserver 回退**。
2. **静默收集 + 显式接受**：
   - 自动发现的 key 先进入 `collected_keys`。
   - 只有用户点击“接受”才写入 `crypto_keys` 并标记 acceptance。
3. **冲突检测**：如果某 email 已有 accepted key，新发现的 key 显示冲突警告，不自动替换。
4. **不自动加密**：即使 Autocrypt `prefer-encrypt=mutual`，也要求用户首次确认。
5. **Trust Dialog**：首次收到签名邮件时弹出，让用户选择 acceptance。

### 7.6 UI 组件建议（Kylins React）

```typescript
// components/crypto/CryptoBadge.tsx
interface CryptoBadgeProps {
  tech: 'openpgp' | 'smime' | null;
  encryption: 'ok' | 'notok' | null;
  signature: 'ok' | 'verified' | 'unverified' | 'mismatch' | 'unknown' | null;
  onClick: () => void;
}

// components/crypto/CryptoDetailsPanel.tsx
interface CryptoDetailsPanelProps {
  tech: 'openpgp' | 'smime';
  status: CryptoStatusEvent;
  onAcceptKey: (fingerprint: string, acceptance: Acceptance) => void;
  onDiscoverKey: (email: string) => void;
  onViewKey: (fingerprint: string) => void;
}

// components/crypto/KeyAssistantDialog.tsx
interface KeyAssistantDialogProps {
  recipients: RecipientReadiness[];
  onDiscover: (email: string) => void;
  onImport: (email: string) => void;
  onDisableEncryption: () => void;
  onSendEncrypted: () => void;
}

// components/crypto/KeyManager.tsx
// 搜索、表格、过滤、右键菜单

// components/crypto/KeyWizard.tsx
// Create / Import / External 三步向导
```

### 7.7 数据表建议（Kylins SQLite）

在前面已有 `crypto_keys` / `trust_decisions` 基础上，增加 collected keys 表：

```sql
CREATE TABLE collected_keys (
    id TEXT PRIMARY KEY,
    fingerprint TEXT NOT NULL UNIQUE,
    backend TEXT NOT NULL,
    public_data BLOB NOT NULL,
    source TEXT NOT NULL, -- wkd/keyserver/autocrypt/attachment/gnupg
    source_url TEXT,
    discovered_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
);

CREATE TABLE collected_key_emails (
    collected_key_id TEXT NOT NULL REFERENCES collected_keys(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    PRIMARY KEY(collected_key_id, email)
);
```

---

## 8. 关键文件索引

### S/MIME 后端

| 用途 | 路径 |
|---|---|
| 发送抽象接口 | `mailnews/compose/public/nsIMsgComposeSecure.idl` |
| S/MIME 发送实现 | `mailnews/extensions/smime/nsMsgComposeSecure.cpp/h` |
| CMS 编解码 | `mailnews/extensions/smime/nsCMS.cpp/h` |
| CMS secure message 服务 | `mailnews/extensions/smime/nsCMSSecureMessage.cpp/h` |
| 证书选择器 | `mailnews/extensions/smime/nsCertPicker.cpp/h` |
| 接收 sink 接口 | `mailnews/extensions/smime/nsIMsgSMIMESink.idl` |
| Opaque CMS MIME 处理 | `mailnews/mime/src/mimecms.cpp/h` |
| Multipart/signed MIME 处理 | `mailnews/mime/src/mimemcms.cpp/h` |
| 邮件 channel 携带 sink | `mailnews/base/public/nsIMailChannel.idl` |
| S/MIME UI sink | `mail/extensions/smime/content/msgHdrViewSMIMEOverlay.js` |
| Composer MIME 生成 | `mailnews/compose/src/MimeMessage.sys.mjs` |
| Composer 命令绑定 | `mail/components/compose/content/MsgComposeCommands.js` |
| 加密 URI 追踪 | `mailnews/extensions/smime/nsEncryptedSMIMEURIsService.cpp/h` |
| LDAP 证书拉取 | `mailnews/extensions/smime/certFetchingStatus.js` |
| 密钥/CSR 生成 | `mailnews/extensions/smime/nsCertGen.cpp/h` |
| S/MIME compose 安全信息 | `mailnews/extensions/smime/msgCompSecurityInfo.js/xhtml` |
| S/MIME read overlay | `mailnews/extensions/smime/msgReadSMIMEOverlay.js` |

### OpenPGP 后端

| 用途 | 路径 |
|---|---|
| 生命周期/工厂注册 | `mail/extensions/openpgp/content/modules/core.sys.mjs` |
| RNP FFI 加载 | `mail/extensions/openpgp/content/modules/RNPLib.sys.mjs` |
| RNP 高级封装 | `mail/extensions/openpgp/content/modules/RNP.sys.mjs` |
| GPGME 回退 | `mail/extensions/openpgp/content/modules/GPGME.sys.mjs` |
| 发送 orchestration | `mail/extensions/openpgp/content/modules/encryption.sys.mjs` |
| PGP/MIME 发送 handler | `mail/extensions/openpgp/content/modules/mimeEncrypt.sys.mjs` |
| MIME 分派 | `mail/extensions/openpgp/PgpMimeHandler.sys.mjs` |
| PGP/MIME 解密 | `mail/extensions/openpgp/content/modules/mimeDecrypt.sys.mjs` |
| PGP/MIME 验证 | `mail/extensions/openpgp/content/modules/mimeVerify.sys.mjs` |
| Keyring 缓存/索引 | `mail/extensions/openpgp/content/modules/keyRing.sys.mjs` |
| Key 对象模型 | `mail/extensions/openpgp/content/modules/keyObj.sys.mjs` |
| Key 解析 | `mail/extensions/openpgp/content/modules/key.sys.mjs` |
| 接受度 SQLite | `mail/extensions/openpgp/content/modules/sqliteDb.sys.mjs` |
| 临时收集 keys | `mail/extensions/openpgp/content/modules/CollectedKeysDB.sys.mjs` |
| 主密码保护 | `mail/extensions/openpgp/content/modules/masterpass.sys.mjs` |
| WKD 查找 | `mail/extensions/openpgp/content/modules/wkdLookup.sys.mjs` |
| Keyserver | `mail/extensions/openpgp/content/modules/keyserver.sys.mjs` |
| 发现编排 | `mail/extensions/openpgp/content/modules/keyLookupHelper.sys.mjs` |
| 信任标签 | `mail/extensions/openpgp/content/modules/trust.sys.mjs` |
| 别名 | `mail/extensions/openpgp/content/modules/OpenPGPAlias.sys.mjs` |
| 阅读辅助 | `mail/extensions/openpgp/content/modules/msgRead.sys.mjs` |

### 前端 UI

| 用途 | 路径 |
|---|---|
| Compose 状态 globals | `mail/components/compose/content/MsgComposeCommands.js:189-207` |
| OpenPGP Key Assistant | `mail/extensions/openpgp/content/ui/keyAssistant.js/inc.xhtml` |
| Compose overlay | `mail/extensions/openpgp/content/ui/enigmailMsgComposeOverlay.js` |
| S/MIME compose info | `mailnews/extensions/smime/msgCompSecurityInfo.js/xhtml` |
| 共享 cryptoBox | `mail/extensions/smime/content/msgHdrViewSMIMEOverlay.js:82-162` |
| 安全详情面板 | `mail/base/content/msgSecurityPane.js/inc.xhtml` |
| OpenPGP read overlay | `mail/extensions/openpgp/content/ui/enigmailMsgHdrViewOverlay.js` |
| OpenPGP messenger overlay | `mail/extensions/openpgp/content/ui/enigmailMessengerOverlay.js` |
| S/MIME read overlay | `mailnews/extensions/smime/msgReadSMIMEOverlay.js` |
| Key Wizard | `mail/extensions/openpgp/content/ui/keyWizard.js/xhtml` |
| Key Manager | `mail/extensions/openpgp/content/ui/enigmailKeyManager.js/xhtml` |
| Key Details | `mail/extensions/openpgp/content/ui/keyDetailsDlg.js/xhtml` |
| Change Expiry | `mail/extensions/openpgp/content/ui/changeExpiryDlg.js/xhtml` |
| Backup Password | `mail/extensions/openpgp/content/ui/backupKeyPassword.js/xhtml` |
| Import Confirmation | `mail/extensions/openpgp/content/ui/confirmPubkeyImport.js/xhtml` |
| Certificate Picker | `mailnews/extensions/smime/certpicker.js/xhtml` |
| Certificate Fetching | `mailnews/extensions/smime/certFetchingStatus.js/xhtml` |

### 本地化

| 用途 | 路径 |
|---|---|
| Key Assistant | `mail/locales/en-US/messenger/openpgp/keyAssistant.ftl` |
| Key Wizard | `mail/locales/en-US/messenger/openpgp/keyWizard.ftl` |
| Read Status | `mail/locales/en-US/messenger/openpgp/msgReadStatus.ftl` |
| Per-recipient Status | `mail/locales/en-US/messenger/openpgp/oneRecipientStatus.ftl` |
| Compose Key Status | `mail/locales/en-US/messenger/openpgp/composeKeyStatus.ftl` |
| OpenPGP Frontend | `mail/locales/en-US/messenger/openpgp/openpgp-frontend.ftl` |
| OpenPGP General | `mail/locales/en-US/messenger/openpgp/openpgp.ftl` |
| S/MIME | `mail/locales/en-US/messenger/smime/smime.ftl` |

---

## 9. 总结

Thunderbird 的加密实现给 Kylins 最重要的启示是 **“统一抽象 + 显式状态机 + 用户可控的 key lifecycle”**：

1. **抽象层**：`nsIMsgComposeSecure` 和 sink 接口让 composer 和 reader 不必关心底层是 S/MIME 还是 OpenPGP。Kylins 应在 Rust 后端定义 `CryptoProvider` / `ComposeSecure` trait，前端只消费状态事件。
2. **发送前 readiness check**：Key Assistant 的 per-recipient 列表是避免发送失败和误发的最佳实践。
3. **阅读状态机**：cryptoBox 的三元组（tech / encryption / signature）足够简洁，又能表达所有常见状态。
4. **密钥管理**：
   - 软私钥用 master key 加密存 SQLite。
   - 自动发现的 key 先进 collected keys，用户显式接受后才进入正式 keyring。
   - 信任决策必须显式：rejected / undecided / unverified / verified / personal。
5. **UI/UX 细节**：
   - 禁用发送按钮直到所有收件人就绪。
   - 加密邮件中即使签名有问题也要显示签名状态。
   - 首次收到签名邮件用 trust dialog 引导用户决策。
   - 不自动导入无关附件 key，防止 key poisoning。
   - WKD 优先，keyserver 回退；隐私细节（padding header、域名排除）值得参考。

---

## 10. 附录：S/MIME 标准与 NSS 模块（合并自 `thunderbird-smime-learning-report.md`）

> 以下内容来自 `thunderbird-smime-learning-report.md`，本报告已将其并入并删除原文件。

### 10.1 S/MIME 相关标准

| 标准 | 角色 | 说明 |
|---|---|---|
| **RFC 8551** | S/MIME 4.0 消息规范（2019） | 现行；强制 AES-GCM、ECDSA/EdDSA、SHA-256/512 |
| **RFC 5751** | S/MIME 3.2 消息规范（2010） | 被 RFC 8551 取代，但仍广泛互操作 |
| **RFC 5652** | Cryptographic Message Syntax（CMS） | 底层加密信封，由 PKCS#7 演化而来 |
| **RFC 5280** | X.509 证书 / profile | S/MIME 证书为带 `emailProtection` EKU 与 email SAN 的 X.509 |
| **RFC 3161** | 时间戳协议 | 可选；Thunderbird 源码未强调 |
| **RFC 8162** | SMIMEA DNS 记录 | 可能的证书发现机制；Thunderbird 未直接实现 |

### 10.2 S/MIME MIME 类型

| 操作 | MIME 类型 |
|---|---|
| 明文签名 | `multipart/signed; protocol="application/pkcs7-signature"` |
| 不透明签名 | `application/pkcs7-mime; smime-type=signed-data` |
| 加密 | `application/pkcs7-mime; smime-type=enveloped-data` |
| 认证加密 | `application/pkcs7-mime; smime-type=authEnveloped-data`（仅解析） |
| 压缩 | `application/pkcs7-mime; smime-type=compressed-data`（按附件处理） |
| 仅证书 | `application/pkcs7-mime; smime-type=certs-only`（按附件处理） |

### 10.3 签名哈希敏捷性（`GetSigningHashFunction`）

`nsMsgComposeSecure.cpp` 根据签名密钥算法与长度选择摘要（遵循 NIST SP 800-57）：

| 密钥 | 默认哈希 |
|---|---|
| RSA ≤1024 | SHA-1 |
| RSA ≤3072 | SHA-256 |
| RSA >3072 | SHA-512 |
| ECDSA P-256 | SHA-256 |
| ECDSA P-384 | SHA-384 |
| ECDSA P-521 | SHA-512 |

### 10.4 NSS / Gecko 模块清单

| 模块 | 文件 | 职责 |
|---|---|---|
| Compose secure object | `mailnews/extensions/smime/nsMsgComposeSecure.cpp/.h` | 实现 `nsIMsgComposeSecure`；驱动签名/加密；解析收件人证书 |
| CMS message wrapper | `mailnews/extensions/smime/nsCMS.cpp/.h` | `nsCMSMessage` / `nsCMSDecoder` / `nsCMSEncoder`；创建 SignedData/EnvelopedData；异步验证任务 |
| Secure message helper | `mailnews/extensions/smime/nsCMSSecureMessage.cpp/.h` | `nsICMSSecureMessage`；证书 usage 辅助 |
| Certificate picker | `mailnews/extensions/smime/nsCertPicker.cpp/.h` | `nsIUserCertPicker`；按 usage/email 选择个人证书 |
| CSR / key generation | `mailnews/extensions/smime/nsCertGen.cpp/.h` | `nsICertGen`；生成密钥对与 CSR |
| Encrypted URI registry | `mailnews/extensions/smime/nsEncryptedSMIMEURIsService.cpp/.h` | 记录已解密消息 URI，便于插入智能卡后重新解密 |
| Opaque CMS handler | `mailnews/mime/src/mimecms.cpp/.h` | 解密/验证 `application/pkcs7-mime` |
| Multipart signed CMS handler | `mailnews/mime/src/mimemcms.cpp/.h` | 验证 `multipart/signed` + `application/pkcs7-signature` |
| Generic signed harness | `mailnews/mime/src/mimemsig.cpp/.h` | 解析 `multipart/signed` boundary/protocol |
| Generic encrypted harness | `mailnews/mime/src/mimecryp.cpp/.h` | 加密 MIME 容器 |
| MIME class router | `mailnews/mime/src/mimei.cpp` | 将 content type 映射到 handler 类 |
| Compose glue | `mailnews/compose/src/MimeMessage.sys.mjs` | 发送时调用 `nsIMsgComposeSecure` 方法 |

### 10.5 证书存储与 per-identity 绑定

- 证书存于 NSS 数据库 `cert9.db` / `key4.db`，按 usage 选择（`certUsageEmailSigner` / `certUsageEmailRecipient`）。
- 每个 mail identity 保存签名/加密证书的 NSS `dbKey`：

```text
mail.identity.<id>.signing_cert_name
mail.identity.<id>.signing_cert_dbkey
mail.identity.<id>.encryption_cert_name
mail.identity.<id>.encryption_cert_dbkey
```

- 验证有两条路径：现代 Gecko `CertVerifier::VerifyCert(..., EmailSigner/EmailRecipient, ...)`（可走 OCSP）；legacy `CERT_VerifyCert(...)`（从 CMS 导入证书时）。

---

*报告由三个子代理并行分析 Thunderbird S/MIME 后端、OpenPGP 后端、前端 UI/UX 后整合生成；附录合并自 `thunderbird-smime-learning-report.md`。*
