# Security Policy

## 脆弱性の報告

脆弱性を見つけた場合は、**公開のIssueに書かず**、GitHubのprivate vulnerability reportingで報告してください。

1. このrepositoryの`Security`タブを開く
2. `Report a vulnerability`を選ぶ
3. 再現手順、影響、対象のversionを書く

報告にはRouterのパスワード、Device Token、Enrollment Code、Public URLなどの秘密情報を含めないでください(必要なら伏せ字にしてください)。

## 対応の方針

個人が運営する小規模なプロジェクトのため、期限の約束はできませんが、次を目安にします。

- 受領の連絡: 7日以内
- 影響の確認と、修正・回避策の方針の連絡: 14日以内
- 修正したら、GitHub Security Advisoryで公表し、報告者の希望があれば謝辞を載せる

修正が公開されるまで、報告の内容は公開しないでください。

## 対象のversion

最新のreleaseだけを対象にします。古い`0.x`のreleaseへの修正のbackportは、原則として行いません。更新は`docker compose pull && docker compose up -d`です。

## 対象外

- YAMAHAルーターのfirmware自体の脆弱性(YAMAHAへ報告してください)
- 管理者がServerを公開インターネットへ置くときの設定(TLS、firewall等)の不備。ただし、READMEや設計docの手順に問題があれば報告してください
