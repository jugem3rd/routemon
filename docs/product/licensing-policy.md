# Routemon Licensing Policy

Status: Current product policy  
Last updated: 2026-10-05

## 1. Purpose

本ドキュメントは、Routemonのライセンス方針を定義する。

---

## 2. License

Routemon(Community / Self-Hosted)の公開コードは **MIT License** を採用する。

採用目的:

- Self-Hosted利用、改変、再配布、商用利用を広く許可する
- 利用者・Contributor・再配布者にとって分かりやすいライセンスとする
- OSS公開時のライセンス運用を可能な限り単純化する
- 採用・検証・派生利用の障壁を下げる

MIT Licenseは、第三者による改変版の非公開利用、再配布、サービスとしての提供も許容する。Routemonではこれを許容する。

このrepositoryのrootに、MIT `LICENSE`を配置している。copyright holderは`jugem3rd`。READMEにもライセンスを明示する。

---

## 3. Architecture boundary

Coreは、特定のdeployment方式に依存しない構造にする。

```text
Routemon Core
├ Agent protocol
├ Device management
├ CONFIG parser
├ Device Profile
├ SYSLOG
├ Jobs
├ Routemon GUI
└ Admin / Viewer RBAC

Adapters / Deployment
└ Community
   ├ Local Auth
   ├ SQLite
   ├ Local filesystem
   └ Single Tenant
```

Coreから、特定の外部サービスのimplementationへ直接依存しない構造を目標とする。

---

## 4. Repository policy

`jugem3rd/Routemon`をPublic / MITのrepositoryとする。

---

## 5. Contributor policy

MITを採用するため、初期段階では複雑なContributor License Agreementを必須にしない方針とする。

外部Contributor受入時は、少なくとも以下を明確化する。

- ContributionもProjectのMIT Licenseで提供されること
- 必要に応じてDeveloper Certificate of Origin (DCO)を採用すること
- Third-party codeを持ち込む場合はLicense compatibilityを確認すること

---

## 6. Legal / license review

OSS一般公開前に以下を確認する。

- Third-party dependencyのLicense / Notice requirement
- 商標 / Project nameの扱い

本ドキュメントはRoutemonの製品・設計方針であり、法的助言そのものではない。
