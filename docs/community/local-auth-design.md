# Community Local Auth Design

Status: Current specification  
Scope: Community  
Last updated: 2026-09-16

Related:

- `docs/product/service-policy.md`(§5 Community Authentication)
- `docs/core/access-control-design.md`(Admin / Viewerの共通Authorization)
- `docs/community/installation-setup-design.md`(§5.3 Administrator)
- `docs/community/storage-backup-design.md`(Users / Local Auth / Sessionsの保存先)

## 1. Purpose

本ドキュメントは、Routemon Community / Self-HostedのUser Authenticationを定義する。

Admin / Viewerの権限内容とserver-side authorizationは`docs/core/access-control-design.md`に従う。

---

## 2. Policy

Routemon CommunityのUser Authenticationは**Local Authのみ**とする。

```text
Routemon Community
└ Local Auth
```

以下を実装対象外とする。

- Public signup
- OIDC
- SAML
- Google / Microsoft Social Login
- 外部のAuthentication service

複数UserとAdmin / Viewer RBACはLocal Auth上で提供する。Communityにはlicense上のUser数上限を設けない。

---

## 3. First Admin

最初のAdminは初期SetupのGUIで作成する(`docs/community/installation-setup-design.md` §5.3)。

- 最初のUserはAdmin固定
- 入力はEmailまたはLogin IDとPassword
- Passwordは安全なPassword hashで保存する
- CLIでUserを作成させない
- Setup完了後にAnonymous Userが初期Adminを上書き・再作成できてはならない

---

## 4. User management

Userの追加はAdminがGUIのSettingsから行う。

```text
Settings
└ Users
   ├ Add User
   └ Admin / Viewer
```

Public signupは提供しない。

User / Local Auth情報とSessionはSQLiteへ保存する(`docs/community/storage-backup-design.md` §4)。

---

## 5. Password

- hashは**scrypt**(Node.js組み込み、`N=16384, r=8, p=1`、salt 16 byte、key 32 byte)を使う。外部依存を増やさない(#24)
- 保存形式は`scrypt$N$r$p$<salt base64>$<hash base64>`とし、algorithmとparameterをhashと一緒に持つ(将来の変更に備える)
- 最低文字数は12文字とする
- Password変更時は、そのUserの既存Sessionをすべて無効化する

## 6. Session

- Session tokenは32 byteの乱数をbase64urlで表し、**hashだけをSQLiteへ保存する**(平文は保存しない)
- BrowserへはhttpOnly cookie(`routemon_session`、`SameSite=Lax`、TLS運用時は`Secure`)で渡す
- 有効期限は12時間。期限切れのSessionは認証時に削除し、定期的にまとめて削除する
- Password・Session tokenをlogへ出さない

## 7. Login失敗時の扱い

- Userが存在しない場合とPasswordが誤っている場合を区別せず、同じerrorを返す
- 連続10回失敗で15分間lockする。成功またはPassword再設定でcounterを戻す

## 8. Community v0.1で提供しないもの

- **Email経由のPassword reset**: SMTP等の外部依存をCommunity v0.1の必須にしないため。Passwordを忘れた場合は他のAdminがSettingsから再設定する
- **MFA**
- Public signup、OIDC / SAML / Social Login(§2)

Adminが1人だけでPasswordを失った場合の復旧手段は、#12のSetup / 運用手順で扱う。
