# Release手順

Community ServerはDocker image(`ghcr.io/jugem3rd/routemon`)として配布する。npmには公開しない。

## 公開の仕組み

`.github/workflows/docker.yml`が、次のときにimageを公開する。

| trigger | tag |
| --- | --- |
| `v0.1.0`のtag | `0.1.0`、`0.1`、`latest` |
| `main`へのpush | `edge` |

`linux/amd64`と`linux/arm64`を、それぞれのnative runnerでbuildし、最後に1つのmanifestへ束ねる。認証は`GITHUB_TOKEN`(`packages: write`)。

Pull Requestでは`ci.yml`の`docker`jobが、imageをbuildし、空の`/data`から起動して、`/healthz`とAgent artifact(`stable.lua`)の配置、`LICENSE`と`THIRD_PARTY_NOTICES.md`の同梱を確かめる。

## 初回だけの手作業

新しいpackageは、既定でPrivateになる。最初のpush後に一度だけ、次を行う。

1. GitHubの`jugem3rd`のPackagesで`routemon`を開く
2. `Package settings`で、repository(`jugem3rd/routemon`)へ紐づける
3. `Change visibility`で`Public`にする
4. 未login(`docker logout ghcr.io`した状態)で`docker pull ghcr.io/jugem3rd/routemon:<tag>`が通ることを確かめる

## Releaseの手順

1. `main`が緑で、新規installからEnrollmentまでの通しの確認(#4)が済んでいる
2. `docs/releases/v<version>.md`のnotesを更新する
3. tagを打つ: `git tag v0.1.0 && git push origin v0.1.0`
4. `Docker image`のworkflowが成功し、`docker buildx imagetools inspect ghcr.io/jugem3rd/routemon:0.1.0`に2つのplatformが出ることを確かめる
5. `gh release create v0.1.0 --title "v0.1.0" --notes-file docs/releases/v0.1.0.md`
