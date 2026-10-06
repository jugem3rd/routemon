# Routemon Community(#12、docs/community/installation-setup-design.md §3)
# Web UI / API / Local Auth / Agent Gateway / WebGUI Relay / CONFIG Parser /
# SYSLOG / SQLite を1つのcontainerへまとめる。
FROM node:24-slim AS build
# better-sqlite3にprebuildが無い環境ではnode-gypでbuildする
RUN apt-get update \
	&& apt-get install -y --no-install-recommends python3 make g++ \
	&& rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/gateway/package.json packages/gateway/
COPY packages/web/package.json packages/web/
COPY apps/community/package.json apps/community/
RUN npm ci
COPY . .
# GUIだけbuildが要る(Node.jsのtype strippingはJSXを扱えない、ADR-0006)
RUN npm run build && npm prune --omit=dev

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/packages/core packages/core
COPY --from=build /app/packages/gateway packages/gateway
COPY --from=build /app/packages/web/dist packages/web/dist
COPY --from=build /app/packages/web/package.json packages/web/
COPY --from=build /app/apps/community apps/community
# Enrollmentに必要なAgent本体。Server起動時に/data/agent/releases/へ配置される(#2)
COPY --from=build /app/agent/https_tunnel_agent.lua agent/
# release artifactにもlicense noticeを含める(#10)
COPY LICENSE THIRD_PARTY_NOTICES.md ./

ENV ROUTEMON_DATA_DIR=/data
VOLUME ["/data"]
# 8080: GUI / API、8081: Agent Gateway、8082: Native WebGUI relay
EXPOSE 8080 8081 8082
CMD ["node", "apps/community/src/main.ts"]
