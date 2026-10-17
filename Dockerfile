# syntax=docker/dockerfile:1
FROM node:24-alpine AS web
WORKDIR /src/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM golang:1.26-alpine AS backend
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd/ cmd/
COPY internal/ internal/
ARG TARGETOS=linux
ARG TARGETARCH
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags='-s -w' -o /out/eir ./cmd/eir

FROM alpine:3.23
RUN apk add --no-cache ca-certificates tzdata wget poppler-utils libheif-tools font-dejavu font-noto-cjk && addgroup -S eir && adduser -S -G eir eir && mkdir -p /data/firmwares /data/documents && chown -R eir:eir /data
LABEL org.opencontainers.image.source="https://github.com/cloverstd/Eir" org.opencontainers.image.licenses="GPL-3.0-only"
WORKDIR /app
COPY LICENSE THIRD_PARTY_NOTICES.md /usr/share/licenses/eir/
COPY licenses/ /usr/share/licenses/eir/third-party/
COPY --from=backend /out/eir /usr/local/bin/eir
COPY --from=web /src/web/dist ./web/dist
USER eir
ENV HTTP_ADDR=:8080 WEB_DIR=/app/web/dist FIRMWARE_DIR=/data/firmwares DOCUMENT_DIR=/data/documents TZ=Asia/Shanghai
EXPOSE 8080
ENTRYPOINT ["eir"]
