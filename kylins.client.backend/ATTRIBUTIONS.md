# Attributions

## velo (Apache-2.0)

Significant portions of this backend are ported from **velo** — a Tauri v2 email client
licensed under the Apache License, Version 2.0.

- Upstream: https://github.com/avihaymenahem/velo
- Local reference copy: `D:\AI\Projects\opensource\velo`
- License file: `LICENSE-velo.txt` (copy of velo's Apache-2.0 LICENSE)

Ported modules:
- `src/oauth.rs` — OAuth PKCE localhost server, token exchange/refresh
- `src/mail/imap/` — IMAP client (connect, fetch, sync, move/delete, raw TCP fallback)
- `src/mail/smtp/` — SMTP client (PLAIN/LOGIN/XOAUTH2)
- Portions of `src/lib.rs` (tray, single-instance, window event handling)
- Portions of `src/commands.rs` (IMAP/SMTP/OAuth command signatures)
- Database migrations 1–23 (via the frontend `services/db/migrations.ts`)

Each ported file carries a header comment indicating its origin.

## mailkit_arkts (license pending)

The ActiveSync (EAS) module under `src/eas/` is ported from **mailkit_arkts** — a HarmonyOS
email client whose EAS implementation provides WBXML codec and command coverage.

- Local reference copy: `D:\AI\Projects\ArkTs\mailkit_arkts\common\MailKit\src\main\ets\protocols\activesync\`
- License: pending user confirmation (assumed user-owned given shared `kylins` branding)

Ported modules (Phase 5+):
- `src/eas/wbxml/` — WBXML serializer/deserializer, 26 code pages, tag tables
- `src/eas/types/` — folder, message, contact, calendar, sync state models
- `src/eas/commands/` — FolderSync, Sync, SendMail, SmartForward/Reply, ItemOperations, GetItemEstimate, Ping, FolderCreate/Delete/Update

## Apache-2.0 License Summary

Licensed under the Apache License, Version 2.0 (the "License"). You may not use ported
files except in compliance with the License. You may obtain a copy of the License at:

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software distributed under
the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
KIND, either express or implied. See the License for the specific language governing
permissions and limitations under the License.
