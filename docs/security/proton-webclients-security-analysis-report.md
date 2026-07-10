# Proton WebClients 安全架构与加密邮件实现分析

> 报告日期：2026-07-10  
> 分析源码：`D:\Projects\mailclient\opensource\Proton\WebClients`（Proton Web 客户端 monorepo，包含 Mail、Account、Calendar、Drive 等应用）  
> 目标：为 Kylins Client 提供 Web 端加密架构、流程与 UI/UX 设计参考

---

## 1. 执行摘要

Proton WebClients 是一个大型 TypeScript/React monorepo，使用 Yarn workspaces 组织。与 Rust 后端 `proton-crypto-rs` 不同，Web 端的核心加密通过 `@protontech/crypto` 包实现，当前生产后端为 **OpenPGP.js（fork 为 `@protontech/openpgp`）**。整个前端通过 `CryptoProxy` 单例门面屏蔽底层库，所有 mail/composer/attachment 代码只调用 `CryptoProxy.*`，不直接依赖 `openpgp` 或 `pmcrypto`。

**核心结论：**

1. **抽象层清晰**：`CryptoProxy` → `Api` / `CryptoWorkerPool` → `KeyStore` + `KeyReference`。私钥材料不会跨越 JS 边界，调用方只拿到可序列化的 key handle。
2. **发送流程**：Redux composer 状态 → per-recipient `SendPreferences` / `getSendPreferences` → `prepareMessageToSend` → top packages → sub packages → `encryptPackages` → `POST /mail/v4/messages/{id}`。
3. **接收流程**：`useLoadMessage` → `decryptMessage` / `decryptMimeMessage` → `CryptoProxy.processMIME` → `useVerifyMessage` → 渲染 `MessageBodyIframe`；隐私图标由 `X-Pm-Origin` / `X-Pm-Content-Encryption` 等 header 驱动。
4. **安全措施密集**：SRP-6a 密码认证、客户端 session blob 用 server-stored `clientKey` AES-GCM 加密、XOR-split secure session storage、Argon2 offline key、device secret + 校验码、recovery kit（BIP-39 助记词）、recovery file（恢复密钥加密私钥）、delegated access / emergency contacts、signed key lists + key transparency（含 VRF/Merkle proof/epoch 验证）、encrypted search（本地索引用 AES-GCM 加密）、DOMPurify + sandboxed iframe。
5. **UI/UX 围绕状态机展开**：`StatusIcon` / `SendInfo` 统一驱动 composer 收件人 lock、reading pane badge、banners、tooltips；信任决策在阅读、撰写、发送前多个触点触发；key manager 在 Account 设置中集中管理。
6. **对 Kylins 的启示**：
   - 引入 `CryptoProxy` 式门面 + key reference，后端可用 Rust/Tauri 命令实现。
   - 发送前做 per-recipient `SendPreferences` + last-minute re-verification。
   - 解密、验证、渲染分层；隐私图标由显式 header/状态驱动。
   - 本地密钥/凭证用 OS keychain（Rust 层）保护，前端只持有引用。
   - 将加密状态抽象为 `StatusIcon` 状态机，统一颜色与图标语义。
   - 在 compose/read/pre-send 三个触点做信任决策，而不是只放在 key manager。

---

## 2. 抽象层：如何屏蔽不同加密方式的差异

### 2.1 `CryptoProxy` — 统一门面

文件：`D:/Projects/mailclient/opensource/Proton/WebPackages/packages/crypto/src/proxy/proxy.ts`

`CryptoProxy` 是模块级单例，提供稳定 API：

```ts
import { CryptoProxy } from '@protontech/crypto';

await CryptoProxy.encryptMessage({ ... });
await CryptoProxy.decryptMessage({ ... });
await CryptoProxy.signMessage({ ... });
await CryptoProxy.verifyMessage({ ... });
await CryptoProxy.processMIME({ ... });
await CryptoProxy.generateKey({ ... });
await CryptoProxy.importPrivateKey({ ... });
await CryptoProxy.exportPublicKey({ ... });
await CryptoProxy.generateSessionKey({ ... });
await CryptoProxy.encryptSessionKey({ ... });
```

每个方法把调用转发给可插拔的 `endpoint`：

```ts
let endpoint: CryptoApiInterface | null = null;

export const CryptoProxy: CryptoProxyInterface = {
    setEndpoint(endpointInstance, onRelease = onEndpointRelease) { … },
    releaseEndpoint() { … },

    encryptMessage: async ({ date = serverTime(), ...opts }) =>
        assertNotNull(endpoint).encryptMessage({ ...opts, date }),
    // ...
};
```

默认 `date` 在 proxy 层注入，调用方无需关心服务器时间同步。

### 2.2 `Api` 后端与 `KeyReference`

文件：
- `D:/Projects/mailclient/opensource/Proton/WebPackages/packages/crypto/src/proxy/endpoint/api.ts`
- `D:/Projects/mailclient/opensource/Proton/WebPackages/packages/crypto/src/proxy/endpoint/api.models.ts`

`Api` 是生产后端唯一实现，内部维护私有 `KeyStore`（`Map<number, Key>`）。调用方拿到的不是 OpenPGP key 对象，而是 `PrivateKeyReference` / `PublicKeyReference`：

```ts
export interface KeyReference {
    readonly _idx: number;
    readonly _keyContentHash: [string, string];

    getVersion(): number;
    getFingerprint(): string;
    getSHA256Fingerprints(): string[];
    getKeyID(): KeyID;
    getKeyIDs(): KeyID[];
    getAlgorithmInfo(): AlgorithmInfo;
    getCreationTime(): Date;
    getExpirationTime(): Date | number | null;
    getUserIDs(): string[];
    isPrivate: () => this is PrivateKeyReference;
    isWeak(): boolean;
    equals(otherKey: KeyReference, ignoreOtherCerts: boolean): boolean;
    subkeys: { getAlgorithmInfo(): AlgorithmInfo; getKeyID(): KeyID; }[];
}
```

- `_idx` 是 `KeyStore` 内部索引；
- `_keyContentHash` 用于内容哈希比较；
- 函数方法在 worker 传输时由 custom transfer handler 重建。

`KeyStore.clearAll()` 会遍历私钥调用 `clearPrivateParams()` 后再清空 map，实现内存释放。

### 2.3 `pmcrypto` — OpenPGP.js 适配层

文件：
- `D:/Projects/mailclient/opensource/Proton/WebPackages/packages/crypto/src/pmcrypto/index.ts`
- `D:/Projects/mailclient/opensource/Proton/WebPackages/packages/crypto/src/pmcrypto/openpgp.ts`

`pmcrypto` 是 Proton 对 OpenPGP.js 的封装，只被 `Api` 消费。`openpgp.ts` 设置全局配置：

```ts
import { config } from "openpgp/lightweight";

export const setConfig = () => {
    config.s2kIterationCountByte = 255;
    config.allowInsecureDecryptionWithSigningKeys = true;
    config.allowInsecureVerificationWithReformattedKeys = true;
    config.minRSABits = 1023;
    config.ignoreSEIPDv2FeatureFlag = true;
    config.enableParsingV5Entities = true;
    config.maxArgon2MemoryExponent = 20;
};
```

这是唯一配置 OpenPGP.js 的地方；所有上层代码只通过 `CryptoProxy` 调用。

### 2.4 调用示例

文件：`D:/Projects/mailclient/opensource/Proton/WebClients/applications/mail/src/app/helpers/message/messageDecrypt.ts`

```ts
import { CryptoProxy } from '@protontech/crypto';

export const decryptMessage = async (message, privateKeys, onUpdateAttachment?, password?) => {
    if (isMIME(message)) {
        return decryptMimeMessage(message, privateKeys, onUpdateAttachment);
    }

    const decryption = await CryptoProxy.decryptMessage({
        armoredMessage: message.Body,
        decryptionKeys: privateKeys,
        verificationKeys: [],
        passwords: password, // EO messages
        format: 'binary',
        config: { allowForwardedMessages: isAutoForwardee(message) },
    });
    // ...
};
```

签名验证与解密分离：

```ts
export const verifyMessage = async (decryptedRawContent, cryptoSignature, message, publicKeys) => {
    if (publicKeys.length && cryptoSignature) {
        const cryptoVerify = await CryptoProxy.verifyMessage({
            binaryData: decryptedRawContent,
            binarySignature: cryptoSignature,
            verificationKeys: publicKeys,
        });
        cryptoVerified = cryptoVerify.verificationStatus;
    }

    if (contentType === MIME_TYPES.MIME) {
        const mimeVerify = await CryptoProxy.processMIME({
            data: binaryToString(decryptedRawContent),
            verificationKeys: publicKeys,
        });
        // ...
    }
};
```

### 2.5 Worker / 离主线程架构

文件：
- `D:/Projects/mailclient/opensource/Proton/WebClients/packages/shared/lib/helpers/setupCryptoWorker.ts`
- `D:/Projects/mailclient/opensource/Proton/WebPackages/packages/crypto/src/proxy/endpoint/workerPool/getWorkerPool.ts`
- `D:/Projects/mailclient/opensource/Proton/WebPackages/packages/crypto/src/proxy/endpoint/workerPool/worker.ts`
- `D:/Projects/mailclient/opensource/Proton/WebPackages/packages/crypto/src/proxy/endpoint/workerPool/transferHandlers/index.ts`

初始化逻辑：

```ts
export const loadCryptoWorker = (options?: CryptoWorkerOptions) => { ... };

const init = async (options: CryptoWorkerOptions = {}) => {
    const isWorker = typeof window === 'undefined' || typeof document === 'undefined';
    const isCompat = isWorker || !hasModulesSupport();

    if (isCompat) {
        const { Api: CryptoApi } = await import('@protontech/crypto/proxy/endpoint/api.ts');
        CryptoApi.init(options?.openpgpConfigOptions || {});
        CryptoProxy.setEndpoint(new CryptoApi(), (endpoint) => endpoint.clearKeyStore());
    } else {
        await CryptoWorkerPool.init({ …options, sentryLogger: captureMessage });
        CryptoProxy.setEndpoint(CryptoWorkerPool, (endpoint) => endpoint.destroy());
    }
    CryptoProxy.setSentryLogger(captureMessage);
};
```

- 现代浏览器：`CryptoProxy` endpoint 是一个 `CryptoWorkerPool`。
- Worker/legacy 浏览器：回退到同进程 `Api`。

Worker pool 用 `comlink` 暴露 `Api`：

```ts
const initWorker = async (openpgpConfigOptions: WorkerInitOptions) => {
    const RemoteApi = wrap<typeof CryptoApi>(createWorker());
    await RemoteApi.init(openpgpConfigOptions);
    const worker = await new RemoteApi();
    return worker;
};
```

- pool 大小默认 `navigator.hardwareConcurrency`；
- Argon2 用固定 worker 保持 WASM cache；
- 导入/生成私钥后需要同步到所有 worker。

Custom transfer handler 处理 `KeyReference`、`Uint8Array`、result streams，保证 key handle 和大数据可以跨 worker 传递。

### 2.6 `crypto-subtle` — WebCrypto 辅助

文件：`D:/Projects/mailclient/opensource/Proton/WebPackages/packages/crypto/src/subtle/aesGcm.ts`

```ts
import { decryptData, encryptData, generateKey, importKey } from '@protontech/crypto/subtle/aesGcm.ts';
```

这些对称/哈希操作不走 worker pool，直接调用 `crypto.subtle`，用于本地状态加密、token wrapping 等非 OpenPGP 场景。

### 2.7 对 Kylins 的映射

| Proton WebClients | Kylins 映射 |
|---|---|
| `CryptoProxy` | Tauri 前端 `CryptoService` 门面，所有加密通过 `invoke('crypto_...')` 调用 Rust |
| `Api` / `CryptoWorkerPool` | Rust `CryptoProvider` trait + worker thread pool |
| `KeyReference` | 前端只持有 key ID / fingerprint，私钥永远留在 Rust key store |
| `crypto-subtle` | Rust `aes-gcm`/`argon2` 处理本地 DB 加密 |
| `setEndpoint` | Tauri 可切换 Rust 后端实现（rpgp/sequoia/cms） |

---

## 3. 加密邮件发送流程

### 3.1 Composer 状态与入口

文件：
- `applications/mail/src/app/components/composer/Composer.tsx`
- `applications/mail/src/app/components/composer/actions/ComposerActions/ComposerActions.tsx`
- `applications/mail/src/app/hooks/composer/useComposerContent.tsx`
- `applications/mail/src/app/hooks/composer/useSendHandler.tsx`
- `applications/mail/src/app/store/composers/composersSlice.ts`

Composer 由 Redux `MessageState` / `MessageStateWithData` 驱动，包含服务器 `data`、解密后的 `messageDocument`、`draftFlags` 等。点击 Send 后，`useSendHandler` 的 `handleSend` 先做预检、等待附件上传，然后 `handleSendAfterUploads` 调用 `extendedVerifications(...)` 构建 `mapSendPrefs`、强制最终草稿保存、调用 `sendMessage(...)`。

### 3.2 `SendPreferences` 与收件人加密偏好

文件：
- `packages/shared/lib/interfaces/mail/crypto.ts`
- `packages/shared/lib/mail/send/getSendPreferences.ts`
- `packages/shared/lib/mail/send/sendPreferences.ts`
- `packages/shared/lib/mail/encryptionPreferences.ts`
- `applications/mail/src/app/hooks/composer/useSendVerifications.tsx`
- `applications/mail/src/app/hooks/useSendInfo.tsx`

`SendPreferences` 是 per-recipient 计划：

```ts
interface SendPreferences {
    encrypt: boolean;
    sign: boolean;
    pgpScheme: PACKAGE_TYPE;
    mimeType: MIME_TYPES;
    publicKeys: PublicKeyReference[];
    isPublicKeyPinned: boolean;
    hasApiKeys: boolean;
    hasPinnedKeys: boolean;
    encryptionDisabled: boolean;
    warnings: SendPreferenceWarning[];
    error: SendPreferenceError | null;
    ktVerificationResult: KTVerificationResult;
    isInternal: boolean;
}
```

`getSendPreferences` 把 `EncryptionPreferences` 转成 `SendPreferences`，并覆盖内部地址 E2EE 禁用、EO 等场景。`getPGPSchemeAndMimeType` 映射到 API package type：

- Internal Proton → `SEND_PM`
- Encrypted outside → `SEND_EO`
- Sign + PGP inline → `SEND_PGP_INLINE`
- Sign + PGP/MIME → `SEND_PGP_MIME`
- 其他 → `SEND_CLEAR` / `SEND_CLEAR_MIME`

`useSendVerifications` 在发送前用 `lifetime: 0` 重新拉取偏好并与缓存值比较，防止 key pinning 变更或降级攻击。

### 3.3 Body / 附件加密、Session Key、Package 构建

文件：
- `applications/mail/src/app/hooks/composer/useSendMessage.tsx`
- `applications/mail/src/app/helpers/send/sendTopPackages.ts`
- `applications/mail/src/app/helpers/send/sendSubPackages.ts`
- `applications/mail/src/app/helpers/send/sendEncrypt.ts`
- `packages/shared/lib/mail/send/attachments.ts`
- `applications/mail/src/app/helpers/attachment/attachmentUploader.ts`

`useSendMessage.prepareMessageToSend` 是核心管道：

```ts
1. getMessageKeys(inputMessage.data) -> messageKeys
2. sendModification(inputMessage) -> final message
3. generateTopPackages(...)
4. attachSubPackages(...)
5. encryptPackages(...)
6. sendFormatter(...) -> API payload
7. api<{ Sent: Message }>({ ...payload, silence: useSilentApi, timeout: 60000 })
```

`generateTopPackages` 决定顶层 MIME 包（plaintext/HTML/PGP/MIME）。`attachSubPackages` 为每个收件人创建 sub-package。`encryptPackages` 调用 `CryptoProxy`：

```ts
const sessionKey = cleanPublicKeys.length
    ? await CryptoProxy.generateSessionKey({ recipientKeys: cleanPublicKeys })
    : await generateSessionKeyHelper();

const { message: encryptedData } = await CryptoProxy.encryptMessage({
    [dataType]: data,
    sessionKey,
    signingKeys: messageKeys.signingKeys,
    date: scheduledTime ? new Date(scheduledTime) : undefined,
    format: 'binary',
    compress: shouldCompress,
});

const encryptedSessionKeys = await Promise.all(
    cleanPublicKeys.map((publicKey) =>
        CryptoProxy.encryptSessionKey({ ...sessionKey, encryptionKeys: publicKey, format: 'binary' })
    )
);
```

EO sub-package 用消息密码加密 body session key；clear package 暴露明文 `BodyKey`。

附件加密独立进行：

```ts
export const encryptAttachment = async (data, file, inline, encryptionKey, signingKeys) => {
    const sessionKey = await CryptoProxy.generateSessionKey({ recipientKeys: encryptionKey });

    const { message: encryptedData, signature } = await CryptoProxy.encryptMessage({
        format: 'binary',
        detached: signingKeys.length > 0,
        [dataType]: data,
        stripTrailingSpaces: dataType === 'textData',
        sessionKey,
        signingKeys,
    });

    const encryptedSessionKey = await CryptoProxy.encryptSessionKey({
        ...sessionKey,
        encryptionKeys: encryptionKey,
        format: 'binary',
    });

    return { …, keys: encryptedSessionKey, data: encryptedData, signature };
};
```

上传：`POST /mail/v4/attachments` 携带 `KeyPackets`、`DataPacket`、`Signature`。

### 3.4 最终 API 调用

文件：
- `packages/shared/lib/api/messages.ts`
- `applications/mail/src/app/helpers/send/sendFormatter.ts`
- `applications/mail/src/app/hooks/composer/useSendMessage.tsx`

```ts
export const sendMessageForm = (messageID: string, data: any, sendingFrom?: string) => ({
    method: 'post',
    url: `mail/v4/messages/${messageID}`,
    input: 'form',
    data,
    params: { Source: sendingFrom },
});
```

`sendFormatter` 构建 `multipart/form-data`，包含 `Packages`、`ExpiresIn`、`DelaySeconds`、`AutoSaveContacts`、`DeliveryTime`。最终：

```ts
return api<{ Sent: Message }>({
    ...payload,
    silence: useSilentApi,
    timeout: 60000,
});
```

---

## 4. 加密邮件接收流程

### 4.1 拉取消息 metadata 与 body

文件：
- `packages/shared/lib/api/messages.ts`
- `applications/mail/src/app/hooks/message/useLoadMessage.ts`
- `applications/mail/src/app/store/messages/read/messagesReadActions.ts`
- `applications/mail/src/app/helpers/message/messageRead.ts`

```ts
queryMessageMetadata() -> GET /mail/v4/messages
getMessage(messageID) -> GET /mail/v4/messages/${messageID}
```

`useLoadMessage` 派发 `load({ ID: inputMessage.ID })` thunk；`load` 仅在 `messageState.data.Body` 缺失时拉取完整 body。

### 4.2 解密消息 body

文件：
- `applications/mail/src/app/components/message/MessageView.tsx`
- `applications/mail/src/app/hooks/message/useInitializeMessage.tsx`
- `applications/mail/src/app/hooks/message/useGetMessageKeys.ts`
- `applications/mail/src/app/helpers/message/messageDecrypt.ts`

`useInitializeMessage` 加载消息、解析 `messageKeys`，然后调用 `decryptMessage(...)`。`useGetMessageKeys` 返回地址 key：

```ts
export const useGetMessageKeys = () => {
    const getAddressKeysByUsage = useGetAddressKeysByUsage();

    return useCallback(async ({ AddressID }) => {
        const { encryptionKey, signingKeys, decryptionKeys } = await getAddressKeysByUsage({
            AddressID,
            withV6SupportForEncryption: true,
            withV6SupportForSigning: false,
        });
        return { encryptionKey, signingKeys, decryptionKeys, type: 'publicPrivate' };
    }, [getAddressKeysByUsage]);
};
```

`decryptMessage` 分派 MIME 与非 MIME：

```ts
export const decryptMessage = async (message, privateKeys, onUpdateAttachment?, password?) => {
    if (isMIME(message)) {
        return decryptMimeMessage(message, privateKeys, onUpdateAttachment);
    }

    const decryption = await CryptoProxy.decryptMessage({
        armoredMessage: message.Body,
        decryptionKeys: privateKeys,
        verificationKeys: [],
        passwords: password,
        format: 'binary',
        config: { allowForwardedMessages: isAutoForwardee(message) },
    });
    // ...
};
```

`decryptMimeMessage` 调用 `CryptoProxy.decryptMessage(..., format: 'binary')` 后再 `CryptoProxy.processMIME({ data, headerFilename, sender })` 得到 body + attachments + encrypted subject。

`getMessageDecryptionKeyInfoFromAddress` 比较 key ID 找出消息加密到的具体地址 key。

### 4.3 附件解密

文件：
- `applications/mail/src/app/helpers/attachment/attachmentLoader.ts`
- `packages/shared/lib/mail/send/attachments.ts`
- `applications/mail/src/app/helpers/attachment/attachmentConverter.ts`

`getAndVerifyAttachment` 是缓存感知封装，`getDecryptedAttachment` 是核心解密：

```ts
const decryptAndVerify = async (encryptedBinaryBuffer, sessionKey, signature?, publicKeys?, encSignature?) =
    CryptoProxy.decryptMessage({
        binaryMessage: new Uint8Array(encryptedBinaryBuffer),
        sessionKeys: [sessionKey],
        armoredSignature: signature,
        armoredEncryptedSignature: encSignature,
        verificationKeys: publicKeys,
        format: 'binary',
    });
```

`getSessionKey()` 用消息私钥解密附件 `KeyPackets`；`getEOSessionKey()` 从 EO 密码派生 session key。

PGP/MIME 附件由 `processMIME` 直接产出，`attachmentConverter.ts` 将其标记为 `ENCRYPTED_STATUS.PGP_MIME` 且 `KeyPackets: null`。

### 4.4 签名验证与发送者 key lookup

文件：
- `applications/mail/src/app/hooks/message/useVerifyMessage.ts`
- `packages/components/hooks/useGetVerificationPreferences.ts`
- `packages/account/publicKeys/verificationPreferences.ts`
- `applications/mail/src/app/helpers/message/messageDecrypt.ts`
- `applications/mail/src/app/helpers/message/messageKeys.ts`

`useVerifyMessage` 在 `messageDocument.initialized` 后触发：

```ts
const supportV6Keys = (await getUserSettings()).Flags.SupportPgpV6Keys === 1;
attachedPublicKeys = await extractKeysFromAttachments(..., supportV6Keys, messageData.Flags);

const verificationPreferences = await getVerificationPreferences(...);
const verificationResult = await verifyMessage(...);
```

`getVerificationPreferencesThunk` 逻辑：
- 自己地址 → active address keys；
- 其他 → `getPublicKeysForInboxThunk` + 通过 `getPublicKeysVcardHelper` 获取 pinned contact keys；
- 验证密钥优先用 pinned keys，否则用 verified internal API keys。

`verifyMessage` 对 detached signature 调用 `CryptoProxy.verifyMessage`；对 MIME body 再次调用 `CryptoProxy.processMIME` 检测 embedded signatures。

`extractKeysFromAttachments` 解密 `.asc` 附件并导入公钥；`extractKeysFromAutocrypt` 解析 Autocrypt header。

### 4.5 MIME 解析、渲染与隐私状态

文件：
- `packages/mail-renderer/helpers/transforms/transforms.ts`
- `applications/mail/src/app/helpers/transforms/transformEmbedded.ts`
- `applications/mail/src/app/helpers/transforms/transformRemote.ts`
- `applications/mail/src/app/components/message/MessageBody.tsx`
- `applications/mail/src/app/helpers/message/icon.ts`
- `applications/mail/src/app/models/crypto.ts`

`processMIME` 产出 `body`、`attachments`、`encryptedSubject`、`signatures`、`verificationStatus`、`mimeType`。`prepareHtml()` 经过：

- `transformEscape`
- `transformBase`
- `transformRawLinks`
- `transformLinks`
- `transformAnchors`
- `handleTransformAndLoadEmbeddedImages`
- `handleTransformAndLoadRemoteImages`
- `transformWelcome`
- `transformStylesheet`
- `transformStyleAttributes`

隐私图标由 header 驱动：

```ts
export const getReceivedStatusIcon = ({ message, verification, isSignatureVerified }) => {
    // 读取 X-Pm-Origin (internal/external) 和 X-Pm-Content-Encryption (end-to-end/on-delivery)
    // 结合 verification 状态返回 StatusIcon
};
```

返回 `StatusIcon`，含 `colorClassName`、`isEncrypted`、`fill`（`PLAIN`/`CHECKMARK`/`SIGN`/`WARNING`/`FAIL`）和本地化 tooltip。

### 4.6 Package 类型推断

文件：
- `packages/shared/lib/mail/messages.ts`
- `packages/shared/lib/mail/mailSettings.ts`

```ts
export enum PACKAGE_TYPE {
    SEND_PM = 1,
    SEND_EO = 2,
    SEND_CLEAR = 4,
    SEND_PGP_INLINE = 8,
    SEND_PGP_MIME = 16,
    SEND_CLEAR_MIME = 32,
}
```

- `isInternal()` / `isE2E()` / `isExternal()` / `isPGPEncrypted()` / `isPGPInline()` / `isMIME()` 根据 `message.Flags` 与 `MIMEType` 判断。
- `isEO()` — `!!message?.Password`

---

## 5. 安全措施与 rationale

### 5.1 密钥层级与生成

文件：
- `packages/shared/lib/keys/userKeys.ts`
- `packages/shared/lib/keys/addressKeys.ts`
- `packages/shared/lib/keys/setupKeys.ts`
- `packages/shared/lib/keys/resetKeys.ts`

- **User Key**：顶层身份密钥，UID 固定为 `not_for_email_use@domain.tld`，通过 `generateUserKey` 生成。
- **Address Key**：每个邮箱地址一个，UID 为账户 email，由随机 32 字节 **address-key token** 加密。
- **Address-key token**：`generateAddressKeyTokens` / `encryptAddressKeyToken` 创建随机 token，用 user key 加密并带 user key 签名。
- **Session key**：每封邮件、每个附件的 AES-256 对称密钥。

Why：私钥不直接由用户密码加密，而是由 user key 保护的 token 加密，改密码时只需重加密 token 和 user key，不需要重加密所有 address key。

### 5.2 Fail-closed 解密策略

文件：
- `packages/shared/lib/keys/getDecryptedUserKeys.ts`
- `packages/shared/lib/keys/getDecryptedAddressKeys.ts`

- `getDecryptedUserKeys` 先尝试解密 **primary** user key；失败返回空数组，不返回部分/损坏 key set。
- `getDecryptedAddressKeys` 先解密 primary address key；失败则不返回其他 address keys。

Why：防止应用在 key 被篡改或损坏的情况下继续操作。

### 5.3 本地认证状态与会话保护

文件：
- `packages/shared/lib/authentication/createAuthenticationStore.ts`
- `packages/shared/lib/helpers/secureSessionStorage.ts`
- `packages/shared/lib/authentication/clientKey.ts`
- `packages/shared/lib/authentication/persistedSessionHelper.ts`
- `packages/shared/lib/authentication/persistedSessionStorage.ts`
- `packages/shared/lib/authentication/sessionBlobCryptoHelper.ts`

**In-memory auth store**：保存 `proton:mailbox_pwd`、`proton:oauth:UID`、`proton:clientKey`、`proton:offlineKey`。

**Secure session storage**：将敏感状态 XOR 拆分：
- 一份写入 `window.name`（不持久化到磁盘）；
- 一份写入 `sessionStorage`（刷新后仍在，但隔离于 origin）。

Why：单独任何一份都无法恢复 secret，且 `window.name` 在标签页关闭即消失。

**Persisted session blob**：
- `generateClientKey()` 生成随机 AES-GCM key；
- 登录时通过 `setLocalKey` 将该 key 发送给服务器；
- 用 `clientKey` 加密 session blob（含 `keyPassword`、可选 offline key password），存 `localStorage` 的 `ps-{localID}`；
- 恢复时从服务器取回 `clientKey` 解密。

Why：即使 localStorage 被拷贝，没有服务器保存的 `clientKey` 也无法解密会话。

### 5.4 Offline key

文件：
- `packages/shared/lib/authentication/offlineKey.ts`

`generateOfflineKey` / `getOfflineKey` 用 Argon2 从明文密码 + 随机 salt 派生 key，存在 persisted session blob 中，使客户端可在不保留明文密码的情况下离线解密邮件。

Why：支持 SSO/离线模式，同时减少明文密码在内存中的存活时间。

### 5.5 SRP 密码认证

文件：
- `packages/shared/lib/srp.ts`
- `packages/account/password/actions.ts`

`srpAuth`、`srpVerify`、`srpGetVerify` 执行 SRP-6a，并**验证 server proof** 后才接受响应。设置/改密码时上传随机生成的 verifier，服务器永远拿不到密码本身。

Why：防止密码在网络传输中泄露，并验证服务器身份。

### 5.6 2FA 与设备验证

文件：
- `packages/shared/lib/authentication/twoFactor.ts`
- `packages/shared/lib/keys/device.ts`

- TOTP / FIDO2 WebAuthn 检测与启用；
- SSO/trusted device：生成 32 字节 device secret，派生确认码，用主地址公钥加密 device secret 用于激活，再用 device secret 加密 `keyPassword`；数据存 `ds-{userID}` localStorage。

Why：防止未授权设备加入账户；人工校验码防止激活阶段 MITM。

### 5.7 Recovery

文件：
- `packages/shared/lib/recoveryFile/recoveryFile.ts`
- `packages/account/recovery/recoveryFile.ts`
- `packages/shared/lib/mnemonic/helpers.ts`
- `packages/recovery-kit/index.ts`
- `packages/account/delegatedAccess/crypto.ts`

**Recovery file**：
- `generateRecoverySecret` 创建 32 随机字节，用主私钥签名；
- `generateRecoveryFileMessage` 导出所有用户私钥并拼接，用 recovery secret 加密；
- `validateRecoverySecret` 用主公钥验证签名。

**Recovery kit（BIP-39 助记词）**：
- 128 bits entropy 生成 12 词助记词；
- 用词派生 key 重加密所有用户私钥；
- 生成 SRP verifier，服务器可用 verifier 认证助记词重置，但永远学不到助记词；
- PDF 在客户端本地由 `@proton/recovery-kit` 渲染，助记词不离开浏览器。

**Delegated access / emergency contacts**：
- 生成 32 字节 delegated-access token；
- 加密并签名给目标联系人；
- 恢复时重加密委托者密钥；
- 强制 1–30 天等待期。

Why：多路径恢复，同时保证恢复凭证不被服务器获取。

### 5.8 Key Transparency

文件：
- `packages/shared/lib/interfaces/SignedKeyList.ts`
- `packages/shared/lib/keys/signedKeyList.ts`
- `packages/key-transparency/lib/helpers/createKTVerifier.ts`
- `packages/key-transparency/lib/verification/verifyKeys.ts`
- `packages/key-transparency/lib/verification/self-audit/selfAudit.ts`
- `packages/key-transparency/lib/verification/vrf.ts`
- `packages/key-transparency/lib/verification/verifyProofs.ts`
- `packages/key-transparency/lib/helpers/apiHelpers.ts`
- `packages/key-transparency/lib/verification/verifyEpochs.ts`
- `packages/key-transparency/lib/storage/storageHelpers.ts`

**Signed Key List（SKL）**：
- 规范 JSON 包含 active key fingerprints、flags、primary flag、SHA-256 fingerprints；
- 用主地址 key 带 KT signing context 做 detached OpenPGP 签名。

**KT 验证流程**：
- `createKTVerifier` 返回 `keyTransparencyVerify` / `keyTransparencyCommit`；
- 新 SKL 先队列，等服务器接受后再验证；
- `verifyPublicKeys` 验证 SKL 签名，并确认 API 返回的每个 key 与 SKL 的 fingerprint/SHA-256/flags/primary 一致；
- `vrfVerify` 验证服务器 ECVRF-EDWARDS25519-SHA512-TAI proof；
- `verifyProofOfExistence` / `verifyProofOfObsolescence` / `verifyProofOfAbsenceForRevision` 验证 Merkle inclusion/obsolescence/absence proof；
- `verifyEpoch` 验证 epoch 证书链、CT SCT、chain-hash consistency；
- `fetchLatestEpoch` 拒绝超过 72 小时的 epoch，防止服务器 stall；
- 验证后的 KT blob 用用户主 key 加密存 `KT:{userID}:{addressID}` localStorage。

Why：防止服务器静默替换用户公钥；提供可审计的 key history。

### 5.9 Encrypted Search

文件：
- `packages/encrypted-search/lib/constants.ts`
- `packages/encrypted-search/lib/esHelpers/esBuild.ts`
- `packages/encrypted-search/lib/esHelpers/esUtils.ts`
- `packages/encrypted-search/lib/esHelpers/esSearch.ts`
- `applications/mail/src/app/helpers/encryptedSearch/mailESCallbacks.tsx`

- 生成 per-user AES-GCM index key，用主 OpenPGP key 加密后存 IndexedDB；
- 拉取消息 metadata 与内容，序列化后用 index key 加密存 IndexedDB；
- 搜索时从 IndexedDB 读取密文，客户端批量解密，再对 normalized keywords 做子串匹配；
- **从不存储明文索引、Bloom filter 或可搜索密文**。

Why：让服务器无法从本地索引泄露邮件内容。

### 5.10 安全内存与 secret 清零

文件：
- `packages/pass/utils/object/zero.ts`
- `packages/pass/utils/obfuscate/xor.ts`
- `packages/shared/lib/keys/device.ts`
- `packages/shared/lib/keys/addressKeys.ts`
- `packages/shared/lib/helpers/secureSessionStorage.ts`

- `zeroize` 递归填充 `Uint8Array`；
- XOR obfuscation 用随机 mask 混淆敏感字符串，解密后 zeroize 临时 buffer；
- `CryptoProxy.clearKey({ key })` 在 import/export 后释放底层 WebCrypto/subtle key material；
- secure session storage 避免最敏感 auth state 写入持久磁盘。

Caveat：mail/account app 中作为 JS string 的 passphrase 没有完全 zeroization，依赖同源隔离、短生命周期和 server-held `clientKey` + Argon2。

### 5.11 反滥用与访问控制

文件：
- `packages/shared/lib/api/apiRateLimiter.ts`
- `packages/shared/lib/api/helpers/withApiHandlers.ts`
- `packages/shared/lib/api/helpers/retryHandler.ts`

- `ApiRateLimiter` 客户端每 URL 限流（默认 100 req/s），超限直接 throw；
- `withApiHandlers` 处理 401 刷新、403/423 scope 缺失、429 retry-after、HUMAN_VERIFICATION_REQUIRED CAPTCHA、USER_RESTRICTED_STATE。

Proof-of-work：客户端源码中未发现；反滥用主要靠服务端限流与人机验证。

### 5.12 CSP、沙箱与 iframe 隔离

文件：
- `packages/mail-renderer/helpers/getIframeSandboxAttributes.ts`
- `packages/mail-renderer/components/MessageBodyIframe.tsx`
- `packages/sanitize/src/purify.ts`
- `applications/preview-sandbox/src/message.ts`

**邮件 iframe sandbox**：
- `allow-same-origin`、`allow-popups`、`allow-popups-to-escape-sandbox`、`allow-modals`（打印时）；
- 仅在 Safari/DuckDuckGo 允许 `allow-scripts`；
- **不允许** `allow-forms`、`allow-pointer-lock`、`allow-top-navigation`。

**DOMPurify**：
- 禁止 `form`、`input`、`textarea`、`style`、`video`、`audio`；
- 将 `src`/`href`/`srcset` 等前缀改为 `proton-`，阻止远程资源自动加载；
- 限制 URI scheme；
- 清理 CSS class 与 inline style。

**附件预览**：单独的 `preview-sandbox` 应用/origin，通过 `postMessage` 与父窗口通信，仅渲染支持的 MIME 类型。

Why：邮件 HTML 不可信，必须隔离脚本、表单、顶层导航和远程资源；附件预览需要额外隔离。

---

## 6. 前端 UI/UX 设计

### 6.1 Composer 加密/签名状态

文件：
- `applications/mail/src/app/components/composer/Composer.tsx`
- `applications/mail/src/app/components/composer/actions/ComposerActions/ComposerActions.tsx`
- `applications/mail/src/app/components/composer/actions/ComposerPasswordActions.tsx`
- `applications/mail/src/app/components/composer/actions/MoreActionsExtension.tsx`
- `applications/mail/src/app/components/composer/modals/ComposerPasswordModal.tsx`
- `applications/mail/src/app/hooks/composer/useComposerContent.tsx`
- `applications/mail/src/app/hooks/useSendInfo.tsx`

**关键设计**：Proton composer **没有独立 Sign 开关**。签名由 contact/API 加密偏好和 `FLAG_SIGN` 决定。用户可见的加密控制是：

- **External encryption** 锁按钮/下拉：设置密码保护的 EO 消息；
- **More options** 下拉：过期、附加公钥；
- per-recipient chip 上的 lock icon 反映 `SendPreferences`。

### 6.2 收件人 chip 与 per-recipient lock

文件：
- `applications/mail/src/app/components/composer/addresses/AddressesRecipientItem.tsx`
- `applications/mail/src/app/components/composer/addresses/AddressesSummary.tsx`
- `applications/mail/src/app/components/composer/addresses/AddressesGroupModal.tsx`
- `applications/mail/src/app/components/message/EncryptionStatusIcon.tsx`
- `applications/mail/src/app/helpers/message/icon.ts`
- `applications/mail/src/app/models/crypto.ts`

每个收件人 pill 右侧显示 `EncryptionStatusIcon`：

- 绿色锁+对勾：verified E2EE；
- 蓝色锁：internal E2EE；
- 开锁+对勾：signed but not encrypted；
- 警告三角：key problem / verification failed；
- 失败圆：decryption error。

`getSendStatusIcon` / `getStatusIconName` 映射 `SendPreferences` 到 icon name：

```ts
export const getStatusIconName = ({ isEncrypted, fill }) => {
    if (fill === STATUS_ICONS_FILLS.PLAIN) return 'lock-filled';
    if (fill === STATUS_ICONS_FILLS.CHECKMARK) return isEncrypted ? 'lock-check-filled' : 'lock-open-check-filled';
    if (fill === STATUS_ICONS_FILLS.SIGN) return isEncrypted ? 'lock-pen-filled' : 'lock-open-pen-filled';
    if (fill === STATUS_ICONS_FILLS.WARNING) return isEncrypted ? 'lock-exclamation-filled' : 'lock-open-exclamation-filled';
    if (fill === STATUS_ICONS_FILLS.FAIL) return 'exclamation-circle';
};
```

### 6.3 发送前警告 / 模态框

文件：
- `applications/mail/src/app/components/composer/addresses/SendWithWarningsModal.tsx`
- `applications/mail/src/app/components/composer/addresses/SendWithErrorsModal.tsx`
- `applications/mail/src/app/components/composer/addresses/SendWithChangedPreferencesModal.tsx`
- `applications/mail/src/app/components/composer/addresses/AskForKeyPinningModal.tsx`
- `applications/mail/src/app/components/composer/addresses/SendWithExpirationModal.tsx`
- `applications/mail/src/app/hooks/composer/useSendVerifications.tsx`

`useSendVerifications` 在发送前重新拉取偏好并打开对应模态：

- `SendWithWarningsModal`：地址警告；
- `SendWithErrorsModal`：硬加密偏好错误（如 invalid pinned key），提供 Send anyway / Close；
- `SendWithChangedPreferencesModal`：E2EE 被禁用或联系人被删除；
- `AskForKeyPinningModal`：请求信任/pin 新检测到 primary key；
- `SendWithExpirationModal`：过期无法应用于部分收件人。

### 6.4 Reading pane 隐私指示器

文件：
- `applications/mail/src/app/components/message/MessageView.tsx`
- `applications/mail/src/app/components/message/EncryptionStatusIcon.tsx`
- `applications/mail/src/app/components/message/extrasHeader/HeaderExtra.tsx`
- `applications/mail/src/app/components/message/extrasHeader/HeaderExpanded.tsx`
- `applications/mail/src/app/components/message/extrasHeader/components/ExtraPinKey.tsx`
- `applications/mail/src/app/components/message/extrasHeader/components/ExtraAskResign.tsx`
- `applications/mail/src/app/components/message/modals/MessageDetailsModal.tsx`

- 发件人姓名旁显示 `EncryptionStatusIcon`；
- `ExtraPinKey` banner：提示信任未 pin 的签名 key / 附加 key；
- `ExtraAskResign` banner：签名验证失败但存在 pinned/trusted keys 时显示 Verify 按钮；
- `MessageDetailsModal`（More → View message details）展示 Encryption、Sender verification、Trackers blocked、Date、Size、Attachments、Recipients；
- `ItemSpyTrackerIcon` / `PrivacyDropdown`：显示被拦截 tracker 数量与详情。

### 6.5 Key Manager UI

文件：
- `applications/account/src/app/containers/mail/MailSettingsRouter.tsx`
- `packages/components/containers/keys/AddressKeysSection.tsx`
- `packages/components/containers/keys/UserKeysSection.tsx`
- `packages/components/containers/keys/KeysTable.tsx`
- `packages/components/containers/keys/KeysActions.tsx`
- `packages/components/containers/keys/KeysStatus.tsx`
- `packages/components/containers/keys/shared/useKeysMetadata.ts`
- `packages/components/containers/keys/shared/getDisplayKey.ts`
- `packages/components/containers/keys/shared/getPermissions.ts`
- `packages/components/containers/keys/importKeys/ImportKeyModal.tsx`
- `packages/components/containers/keys/exportKey/ExportPublicKeyModal.tsx`
- `packages/components/containers/keys/exportKey/ExportPrivateKeyModal.tsx`
- `packages/components/containers/keys/addKey/AddKeyModal.tsx`
- `packages/components/containers/keys/addKey/SelectKeyGenType.tsx`
- `packages/components/containers/keys/deleteKey/DeleteAddressKeyModal.tsx`
- `packages/components/containers/keys/reactivateKeys/ReactivateKeysModal.tsx`
- `packages/components/containers/keys/PostQuantumKeysOptInSection/PostQuantumKeysOptInSection.tsx`

**Key list**：表格展示 creation date、type、fingerprint、function、status、actions。

**Status badges**：Primary、Fallback、Inactive、Compromised、Obsolete、Disabled、Forwarding、Invalid。

**Per-key actions**：export public/private、mark obsolete/compromised、delete、set primary、use for encryption/signing。

**Import/Export**：
- `ImportKeyModal`：多步骤导入私钥，支持 passphrase 解密；
- `ExportPrivateKeyModal`：先强制重新认证，再用用户密码加密导出。

**Add key**：可选择 Classic (ECC Curve25519) 或 Post-quantum (ML-DSA/ML-KEM + ECC)。

### 6.6 Trust / Contact key pinning

文件：
- `packages/components/containers/contacts/email/ContactKeysTable.tsx`
- `packages/components/containers/contacts/email/ContactPGPSettings.tsx`
- `packages/components/containers/contacts/email/ContactEmailSettingsModal.tsx`
- `packages/components/containers/security/AddressVerificationSection.tsx`
- `packages/components/containers/security/PromptPinToggle.tsx`
- `packages/components/containers/security/KTToggle.tsx`
- `applications/mail/src/app/components/message/modals/TrustPublicKeyModal.tsx`
- `applications/mail/src/app/components/message/modals/SimplePublicKeyTable.tsx`

- `ContactKeysTable`：每个 contact public key 显示 fingerprint、status badges（Primary、Fallback、Trusted、Obsolete、Compromised、WKD、Expired、Revoked），并提供 Trust/Untrust/Use for sending/Download/Remove；
- `AddressVerificationSection`：设置项 "Prompt to trust keys"、"Verify keys with Key Transparency"；
- `TrustPublicKeyModal`：首次收到签名邮件或附加 key 时弹出，显示 fingerprint、creation、expiry、algorithm，确认后创建/更新 contact 并 pin key。

### 6.7 Recovery Flow UI

文件：
- `packages/account/recovery/recoveryKit/RecoveryKitModal.tsx`
- `packages/account/recovery/recoveryKit/RecoveryKitContent.tsx`
- `packages/account/recovery/recoveryKit/RecoveryKitAction.tsx`
- `packages/account/recovery/recoveryKit/CopyRecoveryPhraseContainer.tsx`
- `packages/account/recovery/recoveryKit/generateRecoveryKitBlob.ts`
- `packages/components/containers/mnemonic/MnemonicPhraseStep.tsx`
- `packages/components/containers/recovery/DataRecoverySection.tsx`
- `packages/components/containers/recovery/ExportRecoveryFileButton.tsx`
- `packages/account/safetyReview/components/actions/recoveryPhrase/DownloadRecoveryPhrase.tsx`

- `RecoveryKitModal`：生成助记词，提示“助记词只显示一次”，提供 PDF 下载 / 复制为文本；
- `CopyRecoveryPhraseContainer`：默认隐藏，点击显示，提供 Copy / Show；
- `MnemonicPhraseStep`：通用 12 词卡片 + Copy + Download `.txt`；
- `DataRecoverySection`：集中展示 recovery phrase、device backup、recovery file；
- 每个恢复方式都有带 status badge 的 settings nav item。

### 6.8 Security Settings

文件：
- `applications/account/src/app/containers/account/AccountSettingsRouter.tsx`
- `applications/account/src/app/containers/mail/MailSettingsRouter.tsx`
- `packages/components/containers/security/ExternalPGPSettingsSection.tsx`
- `packages/components/containers/security/AddressVerificationSection.tsx`
- `packages/components/containers/emailPrivacy/EmailPrivacySection.tsx`
- `packages/components/containers/account/PasswordsSection.tsx`
- `packages/components/containers/account/TwoFactorSection.tsx`
- `packages/components/containers/sessions/SessionsSection.tsx`
- `packages/account/sso/AuthDevicesSettings.tsx`
- `packages/components/components/drawer/views/SecurityCenter/SecurityCenter.tsx`

路由拆分：

| 路由 | 内容 |
|---|---|
| `/security` | Sentinel、CredentialLeak、AuthDevices、Sessions、Logs、Third-party、Privacy |
| `/account-password` | Password、TwoFactor、Recovery contacts、Family plan、Delete account |
| `/recovery` | Recovery email/phone、device backup、recovery file、phrase、signed-in reset、QR code、emergency contacts |

Security Center drawer：账户安全状态卡片、Breach alerts、Sentinel。

### 6.9 图标、颜色、Tooltip、Banner

文件：
- `packages/icons/icons/IcLock*.tsx`
- `packages/icons/icons/IcShield*.tsx`
- `packages/icons/icons/IcKey*.tsx`
- `packages/colors/themes/src/wallet-light/standard-base.css`
- `packages/colors/types.ts`
- `packages/atoms/src/Banner/Banner.tsx`
- `packages/atoms/src/Tooltip/Tooltip.tsx`

**颜色语义**：

```css
--signal-danger: #ed4349;
--signal-warning: #fe9964;
--signal-success: #6ac06b;
--signal-info: #767dff;
```

- 绿色 = verified；
- 蓝色 = internal E2EE / info；
- 橙色 = warning；
- 红色 = error / danger；
- 黑色/灰色 = zero-access / plain。

**Tooltip pattern**：

```tsx
<Tooltip title={tooltip} data-testid="encryption-icon-tooltip">
    <span>
        <Icon size={4} name={iconName} className={colorClassName} alt={text || ''} />
    </span>
</Tooltip>
```

**Banner variants**：`norm`、`info`、`success`、`warning`、`danger` 及 outline 变体。安全相关 banner 用 `IcInfoCircleFilled color-info`、`IcExclamationTriangleFilled color-danger`。

**常用 wording**：
- "End-to-end encrypted message from verified sender"
- "End-to-end encrypted message"
- "Sender verification failed"
- "Sender's trusted keys verification failed"
- "PGP-encrypted message from verified sender"

---

## 7. 对 Kylins 的综合设计建议

> **权威设计文档：** 本节为基于 Proton WebClients 源码学习得出的方向性建议；Kylins 加密模块的权威设计以 [`crypto-architecture-design.md`](crypto-architecture-design.md) 为准。两者冲突时以设计文档为准。

### 7.1 架构层

1. **前端 `CryptoService` 门面**：
   - 所有加密操作通过 Tauri `invoke` 调用 Rust `crypto_*` commands；
   - 前端不直接持有私钥，只保存 key ID / fingerprint / metadata；
   - Rust 层实现 `CryptoProvider` trait（OpenPGP/S-MIME/国密），前端无感切换。

2. **Key reference 模式**：
   - Rust key store 维护 `Map<keyId, PrivateKey>`；
   - 向前端返回 `KeyReference { id, fingerprint, algorithm, isPrivate, status }`；
   - 需要时通过 `invoke('crypto_with_key', { keyId, op })` 在 Rust 内完成操作。

3. **Worker / 异步**：
   - 加密、解密、签名验证全部走 Tauri async command，必要时 Rust 端 spawn_blocking；
   - 前端显示 skeleton/loading，不阻塞 UI。

### 7.2 发送流程

1. Composer 维护 `isSigned`、`isEncrypted`、`cryptoMethod`、`expiresIn`。
2. 发送前调用 Rust `getSendPreferences(accountId, recipients, cryptoMethod)`，返回每个收件人的 `RecipientReadiness`：

```typescript
interface RecipientReadiness {
    email: string;
    state: 'ready' | 'no_key' | 'expired' | 'rejected' | 'pinned_mismatch' | 'alias';
    cryptoMethod: 'openpgp' | 'smime' | 'plain';
    fingerprint?: string;
    pinned?: boolean;
    ktVerified?: boolean;
    warning?: string;
    error?: string;
}
```

3. 未 ready 时禁用发送，弹出 Key Assistant 式弹窗，分 ready / problematic 两栏，提供 Discover / Import / Disable Encryption / Trust key。
4. 最终发送前再次 re-validate preferences，防止 key 变更或降级。
5. Rust 根据 crypto method 构建标准 PGP/MIME 或 S/MIME，交给 SMTP/EAS 发送。

### 7.3 接收流程

1. IMAP 拉取原始 MIME。
2. Rust `detectCryptoType(contentType)` 识别类型。
3. 解密后返回 `CryptoStatusEvent`：

```typescript
interface CryptoStatusEvent {
    messageId: string;
    tech: 'openpgp' | 'smime' | null;
    encryption: 'ok' | 'notok' | null;
    signature: 'ok' | 'verified' | 'unverified' | 'mismatch' | 'unknown' | null;
    lockColor?: 'success' | 'info' | 'warning' | 'danger' | 'norm';
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
5. 解密、验证、渲染分层，支持先显示明文再异步验证签名。

### 7.4 密钥管理

1. **密钥层级**：Account Master Key（存 OS keychain）→ Identity Key（OpenPGP/S-MIME/SM2）→ Message Session Key。
2. **私钥保护**：软私钥用 master key AES-GCM 加密存 SQLite；master key 存 OS keychain。
3. **解锁缓存**：10 min user key / 5 min address key；显式 lock 命令立即清除。
4. **自动发现 key**：WKD / keyserver / Autocrypt 发现的 key 先进 `collected_keys`，用户显式 accept 后进正式 `crypto_keys`。
5. **信任决策**：rejected / undecided / unverified / verified / personal。
6. **冲突处理**：已有 accepted key 时新 key 不自动替换，显示冲突对话框展示 fingerprint。

### 7.5 UI/UX

1. **Composer**：
   - per-recipient lock icon + tooltip；
   - 未 ready 禁用发送；
   - 签名/加密状态由后端 `SendPreferences` 驱动，不暴露独立 Sign toggle（或默认 sign when encrypt）。

2. **Reading pane**：
   - crypto badge + `Privacy:` row；
   - 颜色区分 internal/external/plain；
   - 详情面板展示 signer/encryption key + trust actions；
   - 远程图片/tracker 拦截 UI。

3. **Key Manager**：
   - 表格展示 keys，搜索过滤；
   - 右键 View/Export/Delete/Set Default/Change Expiry；
   - status badges：Primary、Trusted、Expired、Revoked、Compromised、WKD。

4. **Trust Dialogs**：
   - 首次收到签名邮件弹出 `TrustPublicKeyModal`；
   - composer pre-send `AskForKeyPinningModal`；
   - signature 失败时 `ExtraAskResign` banner。

5. **Recovery**：
   - Recovery kit：PDF + 助记词 + copy；
   - 强制 "I understand" checkbox；
   - 恢复文件用 recovery secret 加密私钥。

6. **Security Settings**：
   - 加密 keys、外部 PGP、email privacy、password、2FA、sessions、recovery 分路由；
   - 每个 nav item 带 status badge。

### 7.6 安全措施

1. 所有 secrets 用 Rust `secrecy` + `zeroize`；
2. AES-GCM 加密本地 credential，AAD 绑定 account/field/version；
3. OS keychain / keyring 保护 master key；
4. 解锁 key cache TTL；
5. 可选 PIN/生物识别应用锁（Argon2 哈希）；
6. Sandbox HTML：iframe `sandbox` 不含 `allow-same-origin`/`allow-forms`/`allow-top-navigation`；
7. DOMPurify 清理；
8. 远程图片/tracker 代理；
9. 附件预览用独立 WebView/origin；
10. 对 SMTP/IMAP/EAS provider response 做签名或 pinning，防止 tampering。

---

## 8. 关键文件索引

### 加密抽象

| 用途 | 路径 |
|---|---|
| CryptoProxy 单例 | `WebPackages/packages/crypto/src/proxy/proxy.ts` |
| Api 后端 + KeyStore | `WebPackages/packages/crypto/src/proxy/endpoint/api.ts` |
| KeyReference 类型 | `WebPackages/packages/crypto/src/proxy/endpoint/api.models.ts` |
| OpenPGP.js 配置 | `WebPackages/packages/crypto/src/pmcrypto/openpgp.ts` |
| Worker pool | `WebPackages/packages/crypto/src/proxy/endpoint/workerPool/getWorkerPool.ts` |
| Worker entry | `WebPackages/packages/crypto/src/proxy/endpoint/workerPool/worker.ts` |
| Transfer handlers | `WebPackages/packages/crypto/src/proxy/endpoint/workerPool/transferHandlers/index.ts` |
| 初始化 loader | `WebClients/packages/shared/lib/helpers/setupCryptoWorker.ts` |
| 启动调用 | `WebClients/applications/mail/src/app/bootstrap.ts` |
| per-app worker 选项 | `WebClients/packages/account/bootstrap/cryptoWorkerOptions.ts` |
| AES-GCM subtle | `WebPackages/packages/crypto/src/subtle/aesGcm.ts` |

### 发送/接收流程

| 用途 | 路径 |
|---|---|
| SendPreferences 类型 | `WebClients/packages/shared/lib/interfaces/mail/crypto.ts` |
| getSendPreferences | `WebClients/packages/shared/lib/mail/send/getSendPreferences.ts` |
| sendPreferences scheme | `WebClients/packages/shared/lib/mail/send/sendPreferences.ts` |
| EncryptionPreferences | `WebClients/packages/shared/lib/mail/encryptionPreferences.ts` |
| useSendMessage | `WebClients/applications/mail/src/app/hooks/composer/useSendMessage.tsx` |
| sendTopPackages | `WebClients/applications/mail/src/app/helpers/send/sendTopPackages.ts` |
| sendSubPackages | `WebClients/applications/mail/src/app/helpers/send/sendSubPackages.ts` |
| sendEncrypt | `WebClients/applications/mail/src/app/helpers/send/sendEncrypt.ts` |
| sendFormatter | `WebClients/applications/mail/src/app/helpers/send/sendFormatter.ts` |
| send API | `WebClients/packages/shared/lib/api/messages.ts` |
| attachment encryption | `WebClients/packages/shared/lib/mail/send/attachments.ts` |
| attachment upload | `WebClients/applications/mail/src/app/helpers/attachment/attachmentUploader.ts` |
| messageDecrypt | `WebClients/applications/mail/src/app/helpers/message/messageDecrypt.ts` |
| useVerifyMessage | `WebClients/applications/mail/src/app/hooks/message/useVerifyMessage.ts` |
| verification preferences | `WebClients/packages/account/publicKeys/verificationPreferences.ts` |
| attachment loader | `WebClients/applications/mail/src/app/helpers/attachment/attachmentLoader.ts` |
| message icons | `WebClients/applications/mail/src/app/helpers/message/icon.ts` |
| crypto model | `WebClients/applications/mail/src/app/models/crypto.ts` |

### 安全

| 用途 | 路径 |
|---|---|
| user key generation | `WebClients/packages/shared/lib/keys/userKeys.ts` |
| address key generation | `WebClients/packages/shared/lib/keys/addressKeys.ts` |
| setup keys | `WebClients/packages/shared/lib/keys/setupKeys.ts` |
| reset keys | `WebClients/packages/shared/lib/keys/resetKeys.ts` |
| decrypted user keys | `WebClients/packages/shared/lib/keys/getDecryptedUserKeys.ts` |
| decrypted address keys | `WebClients/packages/shared/lib/keys/getDecryptedAddressKeys.ts` |
| auth store | `WebClients/packages/shared/lib/authentication/createAuthenticationStore.ts` |
| secure session storage | `WebClients/packages/shared/lib/helpers/secureSessionStorage.ts` |
| persisted session | `WebClients/packages/shared/lib/authentication/persistedSessionHelper.ts` |
| session blob crypto | `WebClients/packages/shared/lib/authentication/sessionBlobCryptoHelper.ts` |
| offline key | `WebClients/packages/shared/lib/authentication/offlineKey.ts` |
| SRP | `WebClients/packages/shared/lib/srp.ts` |
| device secret | `WebClients/packages/shared/lib/keys/device.ts` |
| recovery file crypto | `WebClients/packages/shared/lib/recoveryFile/recoveryFile.ts` |
| recovery kit | `WebClients/packages/recovery-kit/index.ts` |
| mnemonic | `WebClients/packages/shared/lib/mnemonic/helpers.ts` |
| delegated access | `WebClients/packages/account/delegatedAccess/crypto.ts` |
| signed key list | `WebClients/packages/shared/lib/keys/signedKeyList.ts` |
| KT verifier | `WebClients/packages/key-transparency/lib/helpers/createKTVerifier.ts` |
| KT proofs | `WebClients/packages/key-transparency/lib/verification/verifyProofs.ts` |
| KT self-audit | `WebClients/packages/key-transparency/lib/verification/self-audit/selfAudit.ts` |
| encrypted search | `WebClients/packages/encrypted-search/lib/esHelpers/esBuild.ts` |
| rate limiter | `WebClients/packages/shared/lib/api/apiRateLimiter.ts` |
| iframe sandbox | `WebClients/packages/mail-renderer/helpers/getIframeSandboxAttributes.ts` |
| DOMPurify | `WebClients/packages/sanitize/src/purify.ts` |

### UI/UX

| 用途 | 路径 |
|---|---|
| Composer | `WebClients/applications/mail/src/app/components/composer/Composer.tsx` |
| Composer actions | `WebClients/applications/mail/src/app/components/composer/actions/ComposerActions/ComposerActions.tsx` |
| External encryption | `WebClients/applications/mail/src/app/components/composer/actions/ComposerPasswordActions.tsx` |
| AddressesRecipientItem | `WebClients/applications/mail/src/app/components/composer/addresses/AddressesRecipientItem.tsx` |
| EncryptionStatusIcon | `WebClients/applications/mail/src/app/components/message/EncryptionStatusIcon.tsx` |
| useSendInfo | `WebClients/applications/mail/src/app/hooks/useSendInfo.tsx` |
| SendWithErrorsModal | `WebClients/applications/mail/src/app/components/composer/addresses/SendWithErrorsModal.tsx` |
| AskForKeyPinningModal | `WebClients/applications/mail/src/app/components/composer/addresses/AskForKeyPinningModal.tsx` |
| MessageView | `WebClients/applications/mail/src/app/components/message/MessageView.tsx` |
| HeaderExtra | `WebClients/applications/mail/src/app/components/message/extrasHeader/HeaderExtra.tsx` |
| ExtraPinKey | `WebClients/applications/mail/src/app/components/message/extrasHeader/components/ExtraPinKey.tsx` |
| MessageDetailsModal | `WebClients/applications/mail/src/app/components/message/modals/MessageDetailsModal.tsx` |
| TrustPublicKeyModal | `WebClients/applications/mail/src/app/components/message/modals/TrustPublicKeyModal.tsx` |
| AddressKeysSection | `WebClients/packages/components/containers/keys/AddressKeysSection.tsx` |
| UserKeysSection | `WebClients/packages/components/containers/keys/UserKeysSection.tsx` |
| KeysTable | `WebClients/packages/components/containers/keys/KeysTable.tsx` |
| KeysActions | `WebClients/packages/components/containers/keys/KeysActions.tsx` |
| KeysStatus | `WebClients/packages/components/containers/keys/KeysStatus.tsx` |
| ImportKeyModal | `WebClients/packages/components/containers/keys/importKeys/ImportKeyModal.tsx` |
| ExportPrivateKeyModal | `WebClients/packages/components/containers/keys/exportKey/ExportPrivateKeyModal.tsx` |
| AddKeyModal | `WebClients/packages/components/containers/keys/addKey/AddKeyModal.tsx` |
| RecoveryKitModal | `WebClients/packages/account/recovery/recoveryKit/RecoveryKitModal.tsx` |
| ExternalPGPSettingsSection | `WebClients/packages/components/containers/security/ExternalPGPSettingsSection.tsx` |
| AddressVerificationSection | `WebClients/packages/components/containers/security/AddressVerificationSection.tsx` |
| EmailPrivacySection | `WebClients/packages/components/containers/emailPrivacy/EmailPrivacySection.tsx` |
| TwoFactorSection | `WebClients/packages/components/containers/account/TwoFactorSection.tsx` |
| SessionsSection | `WebClients/packages/components/containers/sessions/SessionsSection.tsx` |
| AuthDevicesSettings | `WebClients/packages/account/sso/AuthDevicesSettings.tsx` |
| SecurityCenter | `WebClients/packages/components/components/drawer/views/SecurityCenter/SecurityCenter.tsx` |
| Icon mapping | `WebClients/applications/mail/src/app/helpers/message/icon.ts` |
| Banner | `WebClients/packages/atoms/src/Banner/Banner.tsx` |
| Tooltip | `WebClients/packages/atoms/src/Tooltip/Tooltip.tsx` |

---

## 9. 与 Proton Rust Clients 的对比

| 维度 | WebClients（TS/React） | Rust Clients（TUI） |
|---|---|---|
| 抽象层 | `CryptoProxy` → `Api` / `CryptoWorkerPool` | `PGPProviderSync` trait |
| 后端 | OpenPGP.js（`@protontech/openpgp`） | `rustpgp` |
| 密钥引用 | `KeyReference`（`_idx` + hash） | `PrivateKeyReference` / `PublicKeyReference` |
| Worker | Web Worker pool + comlink | Rust async/spawn_blocking |
| 本地密钥保护 | `clientKey` 存服务器、XOR-split session | OS keychain + AES-GCM SQLite |
| UI 丰富度 | 完整 React GUI、settings、drawer | TUI 有限 |
| 加密搜索 | AES-GCM 加密 IndexedDB | 当前 Rust 报告未重点涉及 |
| 沙箱 | iframe sandbox + preview-sandbox app | 依赖 TUI/terminal |

**对 Kylins 的启示：**

- Kylins 是 Tauri 桌面应用，可以结合 WebClients 的 UI/UX 状态机 + Rust Clients 的本地密钥保护链。
- WebClients 的 `CryptoProxy`/`KeyReference` 模式天然适合映射到 Tauri：前端 `CryptoService` 调用 Rust commands，Rust 端实现 provider trait。
- WebClients 的 `StatusIcon`/`SendInfo` 状态机可直接复用到 React 前端。

---

*报告由四个子代理并行分析 Proton WebClients 的加密抽象层、邮件加解密流程、安全措施、前端 UI/UX 后整合生成。*
